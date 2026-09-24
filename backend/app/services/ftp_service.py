"""FTP 服务(基于标准库 ftplib)。

提供连接与一个统一的 FileProvider 实现(FtpProvider)。
优先使用 MLSD(结构化列表),不支持时回退 LIST 解析。
"""
from __future__ import annotations

import calendar
import io
import posixpath
import uuid
import re
import time
from ftplib import FTP, error_perm

from ..models import Host
from .file_provider import (FileProvider, FileStat, ContentError, MAX_CONTENT_BYTES,
                            TRANSFER_TIMEOUT, digest, validate_text)


def connect(host: Host, password: str | None) -> FTP:
    """建立 FTP 控制连接(被动模式)。"""
    ftp = FTP(timeout=15, encoding="utf-8")
    ftp.connect(host.host, host.port or 21)
    ftp.login(user=host.username or "anonymous", passwd=password or "")
    ftp.set_pasv(True)
    return ftp


# LIST 行解析(类 unix 与 windows 两种常见格式)
_UNIX_RE = re.compile(
    r"^(?P<mode>[dclpsb-][-rwxsStT]{9}).*\s+(?P<size>\d+)\s+"
    r"(?P<mt>\w{3}\s+\d{1,2}\s+[\d:]{4,5}(?:\s+\d{4})?|\w{3}\s+\d{1,2}\s+\d{4})\s+(?P<name>.+)$"
)


def _parse_unix_mtime(mt: str) -> float:
    for fmt in ("%b %d %Y %H:%M", "%b %d %H:%M", "%b %d %Y"):
        try:
            return float(calendar.timegm(time.strptime(mt, fmt)))
        except ValueError:
            continue
    return 0.0


class FtpProvider(FileProvider):
    def __init__(self, ftp: FTP) -> None:
        super().__init__()
        self._ftp = ftp

    def _regular(self, path: str) -> FileStat:
        parent, name = posixpath.split(path)
        entry = next((s for s in self.list(parent or ".") if s.name == name), None)
        if entry is None:
            raise ContentError(404, "远程文件不存在")
        if entry.is_dir or not entry.mode.startswith("-"):
            raise ContentError(415, "只能打开普通文本文件，不支持目录或符号链接")
        if entry.size > MAX_CONTENT_BYTES:
            raise ContentError(413, "文件超过 10 MiB 上限")
        return entry

    def read_content(self, path: str) -> bytes:
        self._regular(path)
        data = bytearray()
        deadline = time.monotonic() + TRANSFER_TIMEOUT

        def receive(block):
            if time.monotonic() > deadline:
                raise TimeoutError()
            if len(data) + len(block) > MAX_CONTENT_BYTES:
                raise ContentError(413, "文件超过 10 MiB 上限")
            data.extend(block)

        try:
            self._ftp.retrbinary(f"RETR {path}", receive, blocksize=65536)
        except error_perm as e:
            raise ContentError(403, "无法读取文件：不存在或权限不足") from e
        except Exception:
            # 中途打断数据连接后，不再复用可能残留完成响应的控制连接。
            self.closed = True
            self._ftp.close()
            raise
        result = bytes(data)
        validate_text(result)
        return result

    def write_content(self, path: str, data: bytes, expected: str) -> str:
        validate_text(data)
        self.assert_digest(path, expected)
        temp = posixpath.join(posixpath.dirname(path), f".shell-helper-{uuid.uuid4().hex}.tmp")
        deadline = time.monotonic() + TRANSFER_TIMEOUT

        def sent(_block):
            if time.monotonic() > deadline:
                raise TimeoutError()

        try:
            try:
                self._ftp.storbinary(f"STOR {temp}", io.BytesIO(data), blocksize=65536, callback=sent)
            except error_perm as e:
                raise ContentError(403, "没有上传权限") from e
            except Exception:
                self.closed = True
                self._ftp.close()
                raise
            self.assert_digest(path, expected)
            try:
                self._ftp.rename(temp, path)
            except error_perm as e:
                raise ContentError(409, "服务器拒绝替换原文件，未采用删除原文件的降级方式") from e
        finally:
            if not self.closed:
                try:
                    self._ftp.delete(temp)
                except Exception:
                    pass
        return digest(data)

    def list(self, path: str) -> list[FileStat]:
        try:
            return self._list_mlsd(path)
        except error_perm:
            return self._list_unix(path)

    def _list_mlsd(self, path: str) -> list[FileStat]:
        out: list[FileStat] = []
        for name, facts in self._ftp.mlsd(path, facts=["type", "size", "modify"]):
            ftype = facts.get("type", "").lower()
            if ftype in ("cdir", "pdir"):
                continue
            mtime = 0.0
            mod = facts.get("modify")
            if mod:
                try:
                    mtime = float(calendar.timegm(time.strptime(mod[:14], "%Y%m%d%H%M%S")))
                except ValueError:
                    mtime = 0.0
            out.append(
                FileStat(
                    name=name,
                    is_dir=ftype == "dir",
                    size=int(facts.get("size", 0) or 0),
                    mtime=mtime,
                    mode="drwxr-xr-x" if ftype == "dir" else ("-rw-r--r--" if ftype == "file" else "l---------"),
                )
            )
        return out

    def _list_unix(self, path: str) -> list[FileStat]:
        lines: list[str] = []
        self._ftp.retrlines(f"LIST {path}".strip(), lines.append)
        out: list[FileStat] = []
        for line in lines:
            m = _UNIX_RE.match(line)
            if not m:
                continue
            mode = m.group("mode")
            name = m.group("name").strip()
            if name in (".", ".."):
                continue
            out.append(
                FileStat(
                    name=name,
                    is_dir=mode.startswith("d"),
                    size=int(m.group("size") or 0),
                    mtime=_parse_unix_mtime(m.group("mt")),
                    mode=mode,
                )
            )
        return out

    def mkdir(self, path: str) -> None:
        self._ftp.mkd(path)

    def rename(self, old: str, new: str) -> None:
        self._ftp.rename(old, new)

    def remove(self, path: str) -> None:
        if self.is_dir(path):
            self._ftp.rmd(path)
        else:
            self._ftp.delete(path)

    def is_dir(self, path: str) -> bool:
        try:
            self._ftp.cwd(path)
            self._ftp.cwd("/")
            return True
        except error_perm:
            return False

    def close(self) -> None:
        self.closed = True
        try:
            self._ftp.quit()
        except Exception:  # noqa: BLE001
            try:
                self._ftp.close()
            except Exception:  # noqa: BLE001
                pass
