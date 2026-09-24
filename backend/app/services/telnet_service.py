"""Telnet 终端服务(基于 socket 的最小实现)。

Python 3.13 移除了 telnetlib,这里自实现一个精简 telnet 客户端:
- 处理 IAC 协商(拒绝服务端发起的 WILL/DO,回复 WONT/DONT)
- 从输出流中剥离协商字节
- 暴露与 Paramiko channel 兼容的接口(recv_ready/recv/sendall/close/
  resize_pty/settimeout/closed/eof_received),使终端 WebSocket 层无需改动。
"""
from __future__ import annotations

import select
import socket

from ..models import Host

IAC, WILL, WONT, DO, DONT, SB, SE, NOP, GA = 255, 251, 252, 253, 254, 250, 240, 241, 249
_TIMEOUT = 0.1


class TelnetChannel:
    def __init__(self, sock: socket.socket) -> None:
        self._sock = sock
        self._inbuf = bytearray()   # 已解码的可见数据(等待被 recv 取走)
        self._raw = bytearray()      # 未处理的原始字节
        self._reply = bytearray()    # 待发送的协商响应
        self.closed = False
        self.eof_received = False

    # ---- 兼容 Paramiko channel 的接口 ----
    def settimeout(self, *_args, **_kwargs) -> None:  # noqa: D401 - 兼容用
        return None

    def recv_ready(self) -> bool:
        if self.closed:
            return False
        if self._inbuf:
            return True
        readable, _, _ = select.select([self._sock], [], [], 0)
        return bool(readable)

    def recv(self, size: int = 4096) -> bytes:
        self._flush_reply()
        try:
            ready, _, _ = select.select([self._sock], [], [], _TIMEOUT)
            if ready:
                data = self._sock.recv(4096)
                if data:
                    self._feed(data)
                else:
                    self.eof_received = True
                    self.closed = True
        except (socket.timeout, BlockingIOError, OSError):
            if self._sock.fileno() == -1:
                self.closed = True
        out = bytes(self._inbuf[:size])
        del self._inbuf[: len(out)]
        return out

    def sendall(self, data: bytes) -> None:
        self._flush_reply()
        buf = bytearray()
        for b in data:
            if b == IAC:
                buf.append(IAC)  # 数据中的 IAC 需转义为两个
            buf.append(b)
        self._sock.sendall(bytes(buf))

    def resize_pty(self, width: int = 0, height: int = 0) -> None:
        return None

    def close(self) -> None:
        self.closed = True
        try:
            self._sock.close()
        except OSError:
            pass

    # ---- IAC 协商处理 ----
    def _feed(self, data: bytes) -> None:
        self._raw.extend(data)
        raw = self._raw
        i = 0
        while i < len(raw):
            b = raw[i]
            if b != IAC:
                self._inbuf.append(b)
                i += 1
                continue
            # 是 IAC
            if i + 1 >= len(raw):
                break  # 等更多字节
            cmd = raw[i + 1]
            if cmd == IAC:  # 转义的 0xFF 数据
                self._inbuf.append(IAC)
                i += 2
                continue
            if cmd in (WILL, WONT, DO, DONT):
                if i + 2 >= len(raw):
                    break  # 选项字节未到
                opt = raw[i + 2]
                self._negotiate(cmd, opt)
                i += 3
                continue
            if cmd == SB:  # 子协商,读到 IAC SE
                end = self._find_subneg_end(raw, i + 2)
                if end < 0:
                    break
                i = end
                continue
            # NOP/GA 等两字节命令
            i += 2
        del raw[:i]

    def _find_subneg_end(self, raw: bytearray, start: int) -> int:
        j = start
        while j < len(raw) - 1:
            if raw[j] == IAC and raw[j + 1] == SE:
                return j + 2
            j += 1
        return -1

    def _negotiate(self, cmd: int, opt: int) -> None:
        # 礼貌拒绝:WILL->DONT, DO->WONT
        if cmd == WILL:
            self._reply.extend(bytes([IAC, DONT, opt]))
        elif cmd == DO:
            self._reply.extend(bytes([IAC, WONT, opt]))

    def _flush_reply(self) -> None:
        if self._reply:
            try:
                self._sock.sendall(bytes(self._reply))
            except OSError:
                pass
            self._reply.clear()


def connect(host: Host, _password: str | None) -> TelnetChannel:
    sock = socket.create_connection((host.host, host.port or 23), timeout=15)
    return TelnetChannel(sock)
