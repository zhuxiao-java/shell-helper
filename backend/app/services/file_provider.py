"""统一文件提供者接口。

SFTP 与 FTP 的差异封装在各自 Provider 中,向上(files API)暴露同一组方法:
list / mkdir / rename / remove / is_dir。list 返回标准化的 FileStat 列表。
"""
from __future__ import annotations

import posixpath
import stat as statmod
import hashlib
import threading
import time
import uuid
from functools import wraps
from dataclasses import dataclass

MAX_CONTENT_BYTES = 10 * 1024 * 1024
TRANSFER_TIMEOUT = 30


class ContentError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def validate_text(data: bytes) -> None:
    if len(data) > MAX_CONTENT_BYTES:
        raise ContentError(413, "文件超过 10 MiB 上限")
    if data.startswith((b"MZ", b"\x7fELF", b"\xcf\xfa\xed\xfe", b"\xfe\xed\xfa", b"\xca\xfe\xba\xbe",
                        b"%PDF-", b"\x89PNG", b"GIF87a", b"GIF89a", b"\xff\xd8\xff", b"PK\x03\x04", b"\x1f\x8b")):
        raise ContentError(415, "不支持二进制、图片、PDF 或可执行文件")
    try:
        if data.startswith((b"\xff\xfe\x00\x00", b"\x00\x00\xfe\xff")):
            text = data.decode("utf-32")
        elif data.startswith((b"\xff\xfe", b"\xfe\xff")):
            text = data.decode("utf-16")
        else:
            text = data.decode("latin1")
    except UnicodeError as e:
        raise ContentError(415, "文本编码不完整") from e
    if any(ord(c) < 32 and c not in "\t\r\n\f" for c in text) or "\x7f" in text:
        raise ContentError(415, "文件不符合文本检测要求")


def check_path(path: str) -> None:
    if not path or any(ord(c) < 32 or ord(c) == 127 for c in path):
        raise ContentError(400, "无效的远程路径")


def serialized(method):
    @wraps(method)
    def call(self, *args, **kwargs):
        with self.lock:
            if self.closed and method.__name__ != "close":
                raise ContentError(410, "文件会话已断开，请重新连接")
            for arg in (*args, *kwargs.values()):
                if isinstance(arg, str):
                    check_path(arg)
            try:
                return method(self, *args, **kwargs)
            except (TimeoutError, EOFError, ConnectionError) as e:
                self.close()
                raise ContentError(410, "文件连接中断或传输超时，请重新连接") from e
    return call


@dataclass
class FileStat:
    name: str
    is_dir: bool
    size: int
    mtime: float
    mode: str


class FileProvider:
    """文件操作统一接口。"""

    def __init__(self):
        self.lock = threading.RLock()
        self.closed = False

    def __init_subclass__(cls):
        for name in ("list", "mkdir", "rename", "remove", "is_dir", "read_content", "write_content", "close"):
            if name in cls.__dict__:
                setattr(cls, name, serialized(cls.__dict__[name]))

    def read_content(self, path: str) -> bytes:
        raise NotImplementedError

    def write_content(self, path: str, data: bytes, expected: str) -> str:
        raise NotImplementedError

    def assert_digest(self, path: str, expected: str) -> None:
        try:
            current = self.read_content(path)
        except FileNotFoundError as e:
            raise ContentError(409, "远程文件已删除，保留本地草稿") from e
        except ContentError as e:
            if e.status in (404, 413, 415):
                raise ContentError(409, "远程文件已改变，保留本地草稿") from e
            raise
        if digest(current) != expected:
            raise ContentError(409, "远程文件已改变，保留本地草稿")

    def close(self) -> None:
        with self.lock:
            self.closed = True

    def list(self, path: str) -> list[FileStat]:
        raise NotImplementedError

    def mkdir(self, path: str) -> None:
        raise NotImplementedError

    def rename(self, old: str, new: str) -> None:
        raise NotImplementedError

    def remove(self, path: str) -> None:
        raise NotImplementedError

    def is_dir(self, path: str) -> bool:
        raise NotImplementedError

    @staticmethod
    def join(base: str, name: str) -> str:
        return posixpath.join(base if base else ".", name)


class SftpProvider(FileProvider):
    """基于 Paramiko SFTPClient。"""

    def __init__(self, sftp) -> None:
        super().__init__()
        self._sftp = sftp
        self._sftp.get_channel().settimeout(TRANSFER_TIMEOUT)

    def _regular(self, path: str):
        attr = self._sftp.lstat(path)
        if not statmod.S_ISREG(attr.st_mode or 0):
            raise ContentError(415, "只能打开普通文本文件，不支持目录或符号链接")
        if (attr.st_size or 0) > MAX_CONTENT_BYTES:
            raise ContentError(413, "文件超过 10 MiB 上限")
        return attr

    def read_content(self, path: str) -> bytes:
        self._regular(path)
        deadline = time.monotonic() + TRANSFER_TIMEOUT
        data = bytearray()
        with self._sftp.open(path, "rb") as stream:
            while True:
                if time.monotonic() > deadline:
                    raise TimeoutError()
                block = stream.read(min(65536, MAX_CONTENT_BYTES + 1 - len(data)))
                if not block:
                    break
                data.extend(block)
                if len(data) > MAX_CONTENT_BYTES:
                    raise ContentError(413, "文件超过 10 MiB 上限")
        self._regular(path)
        result = bytes(data)
        validate_text(result)
        return result

    def write_content(self, path: str, data: bytes, expected: str) -> str:
        validate_text(data)
        self.assert_digest(path, expected)
        attr = self._regular(path)
        temp = posixpath.join(posixpath.dirname(path), f".shell-helper-{uuid.uuid4().hex}.tmp")
        try:
            deadline = time.monotonic() + TRANSFER_TIMEOUT
            with self._sftp.open(temp, "wx") as stream:
                for offset in range(0, len(data), 65536):
                    if time.monotonic() > deadline:
                        raise TimeoutError()
                    stream.write(data[offset:offset + 65536])
            self._sftp.chmod(temp, statmod.S_IMODE(attr.st_mode))
            self.assert_digest(path, expected)
            try:
                self._sftp.posix_rename(temp, path)
            except OSError as e:
                raise ContentError(409, "服务器拒绝安全替换，原文件未删除，请保留草稿") from e
        finally:
            try:
                self._sftp.remove(temp)
            except OSError:
                pass
        return digest(data)

    def close(self) -> None:
        self.closed = True
        self._sftp.close()

    def list(self, path: str) -> list[FileStat]:
        out: list[FileStat] = []
        for attr in self._sftp.listdir_attr(path):
            m = attr.st_mode or 0
            out.append(
                FileStat(
                    name=attr.filename,
                    is_dir=statmod.S_ISDIR(m),
                    size=attr.st_size or 0,
                    mtime=float(attr.st_mtime or 0),
                    mode=statmod.filemode(m),
                )
            )
        return out

    def mkdir(self, path: str) -> None:
        self._sftp.mkdir(path)

    def rename(self, old: str, new: str) -> None:
        self._sftp.rename(old, new)

    def remove(self, path: str) -> None:
        if self.is_dir(path):
            self._sftp.rmdir(path)
        else:
            self._sftp.remove(path)

    def is_dir(self, path: str) -> bool:
        try:
            return statmod.S_ISDIR(self._sftp.stat(path).st_mode)
        except IOError:
            return False
