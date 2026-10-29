"""SSH 本地端口转发（MVP）。

一个 TunnelRule 对应一个独立的 SSH 连接，在 127.0.0.1 上监听本地端口，
把连接通过 Paramiko 的 direct-tcpip 通道转发到远端主机/端口。
"""
from __future__ import annotations

import socket
import threading
from dataclasses import dataclass, field
from typing import Any

from . import ssh_service


@dataclass
class _Tunnel:
    rule_id: str
    local_port: int
    remote_host: str
    remote_port: int
    host: Any
    password: str | None
    client: Any = None
    server: socket.socket | None = None
    thread: threading.Thread | None = None
    stop_event: threading.Event = field(default_factory=threading.Event)
    connections: set[socket.socket] = field(default_factory=set)
    channels: set[Any] = field(default_factory=set)
    bound_port: int = 0
    status: str = "stopped"
    error: str = ""
    lock: threading.Lock = field(default_factory=threading.Lock)

    def start(self) -> None:
        try:
            self.client = ssh_service.connect(self.host, self.password)
            transport = self.client.get_transport()
            if transport is None:
                raise RuntimeError("SSH 传输尚未建立")
            server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            server.bind(("127.0.0.1", self.local_port))
            server.listen(20)
            server.settimeout(0.5)
            self.server = server
            self.bound_port = int(server.getsockname()[1])
            self.status = "running"
            self.thread = threading.Thread(target=self._accept_loop, name=f"tunnel-{self.rule_id}", daemon=True)
            self.thread.start()
        except Exception as exc:  # noqa: BLE001
            self.error = str(exc) or "端口转发启动失败"
            self.status = "error"
            self._close_client()
            self._close_server()
            raise

    def _close_server(self) -> None:
        server, self.server = self.server, None
        if server is not None:
            try: server.close()
            except Exception: pass

    def _close_client(self) -> None:
        client, self.client = self.client, None
        if client is not None:
            try: ssh_service.close_client(client)
            except Exception: pass

    def _accept_loop(self) -> None:
        transport = self.client.get_transport() if self.client else None
        while not self.stop_event.is_set() and self.server is not None:
            try:
                conn, addr = self.server.accept()
            except socket.timeout:
                if transport is not None and not transport.is_active():
                    self.error = "SSH 连接已断开，请重新启动规则"
                    self.status = "error"
                    break
                continue
            except OSError:
                break
            thread = threading.Thread(target=self._handle, args=(conn, addr, transport), daemon=True)
            thread.start()

    def _handle(self, conn: socket.socket, addr: tuple[str, int], transport: Any) -> None:
        channel = None
        try:
            if transport is None or not transport.is_active():
                raise RuntimeError("SSH 连接已断开")
            conn.settimeout(None)
            channel = transport.open_channel("direct-tcpip", (self.remote_host, self.remote_port), addr, timeout=15)
            if channel is None:
                raise RuntimeError("远端拒绝打开转发通道")
            channel.settimeout(None)
            with self.lock:
                self.connections.add(conn)
                self.channels.add(channel)
            to_remote = threading.Thread(target=self._pump, args=(conn, channel), daemon=True)
            from_remote = threading.Thread(target=self._pump, args=(channel, conn), daemon=True)
            to_remote.start()
            from_remote.start()
            to_remote.join()
            from_remote.join()
        except Exception as exc:  # noqa: BLE001
            if not self.stop_event.is_set():
                self.error = str(exc) or "转发失败"
        finally:
            with self.lock:
                self.connections.discard(conn)
                if channel is not None:
                    self.channels.discard(channel)
            try: conn.close()
            except Exception: pass
            if channel is not None:
                try: channel.close()
                except Exception: pass

    def _pump(self, source: Any, target: Any) -> None:
        try:
            while not self.stop_event.is_set():
                block = source.recv(65536)
                if not block:
                    break
                target.sendall(block)
        except Exception:
            pass
        finally:
            try:
                if isinstance(target, socket.socket):
                    target.shutdown(socket.SHUT_WR)
                else:
                    target.shutdown_write()
            except Exception:
                pass

    def stop(self) -> None:
        self.stop_event.set()
        self._close_server()
        with self.lock:
            connections = list(self.connections)
            channels = list(self.channels)
            self.connections.clear()
            self.channels.clear()
        for conn in connections:
            try: conn.close()
            except Exception: pass
        for channel in channels:
            try: channel.close()
            except Exception: pass
        self._close_client()
        if self.thread and self.thread.is_alive():
            self.thread.join(timeout=1)
        self.status = "stopped"
        self.error = ""


class TunnelManager:
    def __init__(self) -> None:
        self._tunnels: dict[str, _Tunnel] = {}
        self._lock = threading.Lock()

    def start(self, rule_id: str, local_port: int, remote_host: str, remote_port: int, host: Any, password: str | None) -> _Tunnel:
        with self._lock:
            old = self._tunnels.pop(rule_id, None)
        if old:
            old.stop()
        tunnel = _Tunnel(rule_id, local_port, remote_host, remote_port, host, password)
        tunnel.start()
        with self._lock:
            self._tunnels[rule_id] = tunnel
        return tunnel

    def stop(self, rule_id: str) -> None:
        with self._lock:
            tunnel = self._tunnels.pop(rule_id, None)
        if tunnel:
            tunnel.stop()

    def status(self, rule_id: str) -> dict[str, Any]:
        with self._lock:
            tunnel = self._tunnels.get(rule_id)
        if tunnel is None:
            return {"status": "stopped", "bound_port": None, "error": ""}
        return {"status": tunnel.status, "bound_port": tunnel.bound_port or None, "error": tunnel.error}

    def close_all(self) -> None:
        with self._lock:
            tunnels = list(self._tunnels.values())
            self._tunnels.clear()
        for tunnel in tunnels:
            tunnel.stop()


_manager: TunnelManager | None = None


def get_tunnel_manager() -> TunnelManager:
    global _manager
    if _manager is None:
        _manager = TunnelManager()
    return _manager
