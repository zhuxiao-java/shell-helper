"""SSH 主机密钥：首次连接要求确认，变更时阻止，确认后写入 known_hosts。"""
from __future__ import annotations

import base64
import hashlib

import paramiko
from sqlalchemy import select

from ..models import KnownHost


def fingerprint_of(key: paramiko.PKey) -> str:
    digest = hashlib.sha256(key.asbytes()).digest()
    return "SHA256:" + base64.b64encode(digest).decode().rstrip("=")


def public_key_of(key: paramiko.PKey) -> str:
    return base64.b64encode(key.asbytes()).decode()


def parse_endpoint(hostname: str, default_port: int = 22) -> tuple[str, int]:
    if hostname.startswith("[") and "]" in hostname:
        host, _, port = hostname[1:].partition("]")
        if port.startswith(":"):
            return host, int(port[1:])
        return host, default_port
    return hostname, default_port


class UnknownHostKey(Exception):
    def __init__(self, host: str, port: int, key: paramiko.PKey):
        self.host = host
        self.port = port
        self.key_type = key.get_name()
        self.public_key = public_key_of(key)
        self.fingerprint = fingerprint_of(key)
        super().__init__(f"未知主机密钥 {host}:{port} {self.fingerprint}")

    def payload(self) -> dict:
        return {
            "code": "unknown_host_key",
            "host": self.host,
            "port": self.port,
            "key_type": self.key_type,
            "public_key": self.public_key,
            "fingerprint": self.fingerprint,
            "message": f"首次连接 {self.host}:{self.port}，请确认指纹 {self.fingerprint}",
        }


class HostKeyChanged(Exception):
    def __init__(self, host: str, port: int, key: paramiko.PKey):
        self.host = host
        self.port = port
        self.key_type = key.get_name()
        self.public_key = public_key_of(key)
        self.fingerprint = fingerprint_of(key)
        super().__init__(f"主机密钥已变化 {host}:{port} {self.fingerprint}")

    @classmethod
    def from_paramiko(cls, exc: paramiko.BadHostKeyException, port: int = 22) -> "HostKeyChanged":
        host, parsed = parse_endpoint(exc.hostname, port)
        return cls(host, parsed, exc.key)

    def payload(self) -> dict:
        return {
            "code": "host_key_changed",
            "host": self.host,
            "port": self.port,
            "key_type": self.key_type,
            "public_key": self.public_key,
            "fingerprint": self.fingerprint,
            "message": f"{self.host}:{self.port} 的主机密钥与已保存的不一致。若你确认服务器已更换密钥，可以更新；否则请停止连接。",
        }


class RejectUnknown(paramiko.MissingHostKeyPolicy):
    def __init__(self, host: str, port: int):
        self.host = host
        self.port = port

    def missing_host_key(self, client, hostname, key):  # noqa: ANN001
        host, port = parse_endpoint(str(hostname), self.port)
        raise UnknownHostKey(host or self.host, port, key)


def _load_key(key_type: str, public_key: str) -> paramiko.PKey:
    try:
        raw = base64.b64decode(public_key, validate=True)
        key = paramiko.PKey.from_type_string(key_type, raw)
    except Exception as exc:  # noqa: BLE001
        raise ValueError("主机密钥无效") from exc
    return key


def describe_public_key(key_type: str, public_key: str) -> str:
    key = _load_key(key_type, public_key)
    if key.get_name() != key_type:
        raise ValueError("主机密钥类型不匹配")
    return fingerprint_of(key)


def remember(host: str, port: int, key_type: str, public_key: str) -> str:
    """校验并保存公钥，返回指纹。"""
    key = _load_key(key_type, public_key)
    if key.get_name() != key_type:
        raise ValueError("主机密钥类型不匹配")
    fingerprint = fingerprint_of(key)
    from ..core.db import session_scope

    with session_scope() as db:
        row = db.scalar(select(KnownHost).where(KnownHost.host == host, KnownHost.port == port))
        if row is None:
            row = KnownHost(host=host, port=port)
            db.add(row)
        row.key_type = key_type
        row.public_key = public_key
        row.fingerprint = fingerprint
    return fingerprint


def apply_known_key(client: paramiko.SSHClient, host: str, port: int) -> None:
    from ..core.db import session_scope

    with session_scope() as db:
        row = db.scalar(select(KnownHost).where(KnownHost.host == host, KnownHost.port == port))
        material = (row.public_key, row.key_type) if row and row.public_key else None
    if not material:
        return
    key = _load_key(material[1], material[0])
    names = {host, f"[{host}]:{port}"}
    for name in names:
        client.get_host_keys().add(name, key.get_name(), key)


def as_http(exc: Exception):
    """把主机密钥异常转成 409。其它异常返回 None。"""
    from fastapi import HTTPException

    if isinstance(exc, (UnknownHostKey, HostKeyChanged)):
        return HTTPException(409, detail=exc.payload())
    return None


def prepare_client(host: str, port: int) -> paramiko.SSHClient:
    client = paramiko.SSHClient()
    apply_known_key(client, host, port)
    client.set_missing_host_key_policy(RejectUnknown(host, port))
    return client
