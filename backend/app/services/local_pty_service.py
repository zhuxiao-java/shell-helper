"""本地伪终端：POSIX PTY / Windows ConPTY，提供统一的终端通道接口。"""
from __future__ import annotations

import codecs
import errno
import os
import select
import shutil
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path


def terminal_environment() -> dict[str, str]:
    """不把应用内部令牌、主密钥和 Electron 启动参数传入交互 Shell。"""
    env = {key: value for key, value in os.environ.items()
           if not key.upper().startswith(("SHELL_HELPER_", "ELECTRON_"))
           and key.upper() not in {"PYTHONHOME", "PYTHONPATH", "PYTHONUNBUFFERED", "NODE_OPTIONS"}}
    env.update(TERM="xterm-256color", COLORTERM="truecolor", TERM_PROGRAM="shell-helper")
    env.setdefault("LANG", "en_US.UTF-8" if sys.platform == "darwin" else "C.UTF-8")
    return env


def shell_command() -> list[str]:
    if os.name == "nt":
        powershell = shutil.which("pwsh.exe") or shutil.which("powershell.exe")
        if powershell:
            return [powershell, "-NoLogo"]
        return [os.environ.get("COMSPEC", "cmd.exe")]
    import pwd

    candidates = [os.environ.get("SHELL", ""), pwd.getpwuid(os.getuid()).pw_shell, "/bin/sh"]
    for shell in candidates:
        if os.path.isabs(shell) and os.path.isfile(shell) and os.access(shell, os.X_OK):
            return [shell, "-l"]
    raise ValueError("没有可用的本地 Shell")


def working_directory(value: str = "~") -> str:
    if not value or value == "~":
        directory = Path.home()
    else:
        if any(ord(char) < 32 for char in value):
            raise ValueError("本地初始目录不能包含控制字符")
        directory = Path(value).expanduser()
    if not directory.is_absolute() or not directory.is_dir():
        raise ValueError("本地初始目录必须是存在的绝对目录（可使用 ~）")
    return str(directory.resolve())


def exec_shell(shell: str) -> None:
    """在独立辅助进程中取得控制终端，避免线程池内执行 preexec_fn/fork 回调。"""
    import fcntl
    import termios

    fcntl.ioctl(0, termios.TIOCSCTTY, 0)
    os.execve(shell, [shell, "-l"], terminal_environment())


class PosixChannel:
    def __init__(self, cwd: str, command: list[str], env: dict[str, str]) -> None:
        import pty
        import termios

        self.cwd = cwd
        self.closed = False
        self.eof_received = False
        self._lock = threading.Lock()
        self._master, slave = pty.openpty()
        try:
            termios.tcsetwinsize(slave, (24, 80))
            os.set_blocking(self._master, False)
            # 打包后由同一可执行文件分派辅助入口；开发态直接启动此模块。
            args = ([sys.executable] if getattr(sys, "frozen", False)
                    else [sys.executable, "-I", str(Path(__file__).resolve())])
            self.process = subprocess.Popen(
                [*args, "--local-pty-child", command[0]], cwd=cwd, env=env,
                stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
                close_fds=True,
            )
        except BaseException:
            os.close(self._master)
            raise
        finally:
            os.close(slave)

    def settimeout(self, _timeout: float) -> None:
        pass  # 读写均使用非阻塞描述符。

    def recv_ready(self) -> bool:
        with self._lock:
            if self.closed or self.eof_received:
                return False
            ready = bool(select.select([self._master], [], [], 0)[0])
            if not ready and self.process.poll() is not None:
                self.eof_received = True
            return ready

    def recv(self, size: int = 4096) -> bytes:
        with self._lock:
            if self.closed or self.eof_received:
                return b""
            try:
                data = os.read(self._master, size)
            except BlockingIOError:
                return b""
            except OSError as exc:
                if exc.errno != errno.EIO:
                    raise
                data = b""  # Linux PTY 从端退出时以 EIO 表示 EOF。
            if not data:
                self.eof_received = True
            return data

    def sendall(self, data: bytes) -> None:
        remaining = memoryview(data)
        deadline = time.monotonic() + 5
        while remaining:
            with self._lock:
                if self.closed or self.eof_received:
                    raise EOFError("本地终端已结束")
                try:
                    written = os.write(self._master, remaining[:65536])
                    remaining = remaining[written:]
                    deadline = time.monotonic() + 5
                except BlockingIOError:
                    pass
            if remaining:
                if time.monotonic() >= deadline:
                    raise TimeoutError("本地终端暂时无法接收输入")
                time.sleep(0.005)

    def resize_pty(self, width: int = 80, height: int = 24) -> None:
        import termios

        if not 1 <= width <= 1000 or not 1 <= height <= 1000:
            raise ValueError("无效的终端尺寸")
        with self._lock:
            if not self.closed:
                termios.tcsetwinsize(self._master, (height, width))

    def _signal_group(self, group: int, sig: int) -> None:
        try:
            # 仅向本终端会话中的进程组发信号，不能影响后端或其它终端。
            if group > 0 and os.getsid(group) == self.process.pid:
                os.killpg(group, sig)
        except ProcessLookupError:
            pass

    def close(self) -> None:
        with self._lock:
            if self.closed:
                return
            self.closed = True
            try:
                foreground = os.tcgetpgrp(self._master)
            except OSError:
                foreground = 0
            groups = {self.process.pid, foreground}
            for group in groups:
                self._signal_group(group, signal.SIGHUP)
            os.close(self._master)
        # 给 Shell 机会回收任务；对仍存活的前台任务和 Shell 做有界清理。
        time.sleep(0.1)
        for group in groups:
            self._signal_group(group, signal.SIGKILL)
        self.process.wait(timeout=1)


class WindowsChannel:
    def __init__(self, cwd: str, command: list[str], env: dict[str, str]) -> None:
        try:
            from winpty import PtyProcess
        except ImportError as exc:
            raise RuntimeError("本地终端需要 pywinpty，请安装 backend/requirements.txt 中的依赖") from exc
        self.cwd = cwd
        self.closed = False
        self.eof_received = False
        self._lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self.process = PtyProcess.spawn(command, cwd=cwd, env=env, dimensions=(24, 80))
        self.process.fileobj.setblocking(False)

    def settimeout(self, _timeout: float) -> None:
        pass

    def recv_ready(self) -> bool:
        with self._lock:
            return not self.closed and bool(select.select([self.process.fileobj], [], [], 0)[0])

    def recv(self, size: int = 4096) -> bytes:
        with self._lock:
            if self.closed:
                return b""
            try:
                data = self.process.fileobj.recv(size)
            except BlockingIOError:
                return b""
            if not data:
                self.eof_received = True
            return data

    def sendall(self, data: bytes) -> None:
        # ConPTY 写入可能等待输出被消费，不能同时占用读取/关闭的锁。
        with self._write_lock:
            if self.closed or self.eof_received:
                raise EOFError("本地终端已结束")
            text = self._decoder.decode(data)
            if text:
                self.process.write(text)

    def resize_pty(self, width: int = 80, height: int = 24) -> None:
        if not 1 <= width <= 1000 or not 1 <= height <= 1000:
            raise ValueError("无效的终端尺寸")
        with self._lock:
            if not self.closed:
                self.process.setwinsize(height, width)

    def close(self) -> None:
        with self._lock:
            if self.closed:
                return
            self.closed = True
        self.process.close(force=True)


def connect(cwd: str = "~") -> PosixChannel | WindowsChannel:
    directory = working_directory(cwd)
    channel_type = WindowsChannel if os.name == "nt" else PosixChannel
    return channel_type(directory, shell_command(), terminal_environment())


if __name__ == "__main__" and len(sys.argv) == 3 and sys.argv[1] == "--local-pty-child":
    exec_shell(sys.argv[2])
