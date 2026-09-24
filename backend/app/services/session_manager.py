"""会话管理器。

按会话类型(terminal / sftp / ftp)与主机协议路由到对应服务:
- terminal + ssh     : Paramiko shell channel
- terminal + telnet  : 自实现 TelnetChannel
- sftp               : Paramiko SFTP(经 SSH 通道)
- ftp                : ftplib FTP 控制连接

每种会话记录底层传输(ssh/ftp/telnet),关闭时按传输类型正确释放资源。
"""
from __future__ import annotations

import threading
import uuid
from dataclasses import dataclass, field
from typing import Literal

from . import ftp_service, local_pty_service, ssh_service, telnet_service
from .file_provider import FileProvider, SftpProvider

SessionType = Literal["terminal", "sftp", "ftp"]
Transport = Literal["ssh", "ftp", "telnet", "local"]


def validate_capability(protocol: str, stype: str) -> None:
    allowed = {"ssh": {"terminal", "sftp"}, "sftp": {"sftp"},
               "ftp": {"ftp"}, "telnet": {"terminal"}, "local": {"terminal"}}
    if stype not in allowed.get(protocol, set()):
        raise ValueError(f"{protocol.upper()} 不支持 {stype} 会话")


@dataclass
class Session:
    session_id: str
    host_id: str
    type: SessionType
    transport: Transport
    protocol: str
    client: object = None            # SSHClient | FTP | TelnetChannel
    channel: object = None           # 终端 channel(paramiko.Channel | TelnetChannel)
    provider: FileProvider | None = None
    remote_cwd: str = ""
    closed: bool = False
    terminal_attached: bool = False
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def attach_terminal(self) -> bool:
        with self._lock:
            if self.closed or self.type != "terminal" or self.channel is None or self.terminal_attached:
                return False
            self.terminal_attached = True
            return True

    def close(self) -> None:
        with self._lock:
            if self.closed:
                return
            self.closed = True
        if self.provider is not None:
            try:
                self.provider.close()
            except Exception:
                pass
        if self.transport == "ssh":
            try:
                if self.channel is not None:
                    self.channel.close()  # type: ignore[attr-defined]
            finally:
                ssh_service.close_client(self.client)  # type: ignore[arg-type]
        elif self.transport in {"telnet", "local"}:
            if self.channel is not None:
                self.channel.close()  # type: ignore[attr-defined]


class SessionManager:
    def __init__(self) -> None:
        self._sessions: dict[str, Session] = {}
        self._lock = threading.Lock()

    def create(self, host_id: str, stype: SessionType) -> Session:
        from ..core.db import session_scope
        from ..repositories import host_repo

        with session_scope() as db:
            host = host_repo.get_host(db, host_id)
            if host is None:
                raise KeyError(f"主机不存在: {host_id}")
            protocol = host.protocol
            validate_capability(protocol, stype)
            password = None if protocol == "local" else host_repo.resolve_password(db, host)

        if stype == "terminal":
            session = self._create_terminal(host, password, protocol, host_id)
        elif stype == "sftp":
            session = self._create_sftp(host, password, protocol, host_id)
        elif stype == "ftp":
            session = self._create_ftp(host, password, protocol, host_id)
        else:  # pragma: no cover
            raise ValueError(f"未知会话类型: {stype}")

        session.remote_cwd = (session.channel.cwd if protocol == "local"
                              else getattr(host, "remote_cwd", "") or "")
        with self._lock:
            self._sessions[session.session_id] = session
        return session

    def _create_terminal(self, host, password, protocol, host_id) -> Session:
        if protocol == "telnet":
            chan = telnet_service.connect(host, password)
            return self._new(host_id, "terminal", "telnet", protocol, channel=chan)
        if protocol == "local":
            channel = local_pty_service.connect(getattr(host, "remote_cwd", "") or "~")
            return self._new(host_id, "terminal", "local", protocol, channel=channel)
        # 默认 ssh shell
        client = ssh_service.connect(host, password)
        channel = ssh_service.open_shell(client)
        return self._new(host_id, "terminal", "ssh", protocol, client=client, channel=channel)

    def create_local(self) -> Session:
        channel = local_pty_service.connect()
        session = self._new("", "terminal", "local", "local", channel=channel)
        session.remote_cwd = channel.cwd
        with self._lock:
            self._sessions[session.session_id] = session
        return session

    def _create_sftp(self, host, password, protocol, host_id) -> Session:
        client = ssh_service.connect(host, password)
        provider = SftpProvider(ssh_service.open_sftp(client))
        return self._new(host_id, "sftp", "ssh", protocol, client=client, provider=provider)

    def _create_ftp(self, host, password, protocol, host_id) -> Session:
        ftp = ftp_service.connect(host, password)
        provider = ftp_service.FtpProvider(ftp)
        return self._new(host_id, "ftp", "ftp", protocol, client=ftp, provider=provider)

    @staticmethod
    def _new(host_id, stype, transport, protocol, *, client=None, channel=None, provider=None) -> Session:
        return Session(
            session_id=uuid.uuid4().hex,
            host_id=host_id,
            type=stype,
            transport=transport,
            protocol=protocol,
            client=client,
            channel=channel,
            provider=provider,
        )

    def get(self, session_id: str) -> Session | None:
        with self._lock:
            return self._sessions.get(session_id)

    def get_provider(self, session_id: str) -> FileProvider:
        session = self.get(session_id)
        if session is None or session.closed:
            raise KeyError("会话不存在或已关闭")
        if session.provider is None or session.provider.closed:
            raise KeyError("文件会话不存在或已断开")
        return session.provider

    def close(self, session_id: str) -> None:
        with self._lock:
            session = self._sessions.pop(session_id, None)
        if session:
            session.close()

    def close_all(self) -> None:
        with self._lock:
            sessions = list(self._sessions.values())
            self._sessions.clear()
        for s in sessions:
            s.close()

    def list_ids(self) -> list[str]:
        with self._lock:
            return list(self._sessions.keys())


_manager: SessionManager | None = None


def get_session_manager() -> SessionManager:
    global _manager
    if _manager is None:
        _manager = SessionManager()
    return _manager
