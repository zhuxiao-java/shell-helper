"""SSH / SFTP 服务(基于 Paramiko)。

负责:
- 依据 Host + 凭据建立 SSHClient(支持密码/私钥/跳板链路)
- 打开交互式 shell channel(终端)
- 打开 SFTPClient(文件管理)
"""
from __future__ import annotations

import os
from typing import Any

import paramiko

from ..models import Host

DEFAULT_LOOK_FOR_KEYS = True


class SSHAuthError(Exception):
    pass


def _load_pkey(key_path: str, passphrase: str | None) -> paramiko.PKey | None:
    if not key_path or not os.path.exists(key_path):
        return None
    path = os.path.expanduser(key_path)
    for key_cls in (paramiko.Ed25519Key, paramiko.RSAKey, paramiko.ECDSAKey, paramiko.DSSKey):
        try:
            return key_cls.from_private_key_file(path, password=passphrase)
        except paramiko.SSHException:
            continue
        except Exception:  # noqa: BLE001
            continue
    return None


def _connect_kwargs(host: Host, password: str | None) -> dict[str, Any]:
    kwargs: dict[str, Any] = {
        "hostname": host.host,
        "port": host.port or 22,
        "username": host.username or None,
        "timeout": 15,
        "banner_timeout": 15,
        "auth_timeout": 15,
    }
    if host.auth_type == "pubkey" and host.key_path:
        pkey = _load_pkey(host.key_path, password)
        if pkey:
            kwargs["pkey"] = pkey
        else:
            kwargs["look_for_keys"] = DEFAULT_LOOK_FOR_KEYS
    elif host.auth_type == "agent":
        kwargs["look_for_keys"] = DEFAULT_LOOK_FOR_KEYS
        kwargs["allow_agent"] = True
    elif host.auth_type == "password" and password:
        kwargs["password"] = password
    return kwargs


def _open_client(host: Host, password: str | None, sock=None) -> paramiko.SSHClient:
    from . import host_keys

    client = host_keys.prepare_client(host.host, host.port or 22)
    try:
        kwargs = _connect_kwargs(host, password)
        if sock is not None:
            kwargs["sock"] = sock
        client.connect(**kwargs)
    except paramiko.BadHostKeyException as exc:
        raise host_keys.HostKeyChanged.from_paramiko(exc, host.port or 22) from exc
    return client


def connect(host: Host, password: str | None) -> paramiko.SSHClient:
    """建立到目标主机的 SSH 连接,自动处理跳板链。"""
    from ..repositories import host_repo
    from ..core.db import session_scope

    with session_scope() as db:
        chain = host_repo.jump_chain(db, host)

    if not chain:
        return _open_client(host, password)

    # 逐级建立:先连跳板,再通过 direct-tcpip 通道连目标
    jump_clients: list[paramiko.SSHClient] = []
    sock = None
    with session_scope() as db:
        for jump in chain:
            jpwd = host_repo.resolve_password(db, jump)
            jc = _open_client(jump, jpwd, sock=sock)
            jump_clients.append(jc)
            sock = jc.get_transport()

    target_kwargs = _connect_kwargs(host, password)
    transport = sock.open_channel(  # type: ignore[union-attr]
        "direct-tcpip", (host.host, host.port or 22), ("127.0.0.1", 0)
    )
    client = _open_client(host, password, sock=transport)
    # 把跳板 client 挂到目标 client 上,关闭时级联释放
    client._jump_clients = jump_clients  # type: ignore[attr-defined]
    return client


def open_shell(client: paramiko.SSHClient, term: str = "xterm-256color", cols: int = 80, rows: int = 24):
    """打开交互式 shell channel。"""
    chan = client.invoke_shell(term=term, width=cols, height=rows)
    chan.settimeout(0.0)
    return chan


def open_sftp(client: paramiko.SSHClient) -> paramiko.SFTPClient:
    return client.open_sftp()


def close_client(client: paramiko.SSHClient) -> None:
    try:
        client.close()
    finally:
        for jc in getattr(client, "_jump_clients", []):
            try:
                jc.close()
            except Exception:  # noqa: BLE001
                pass
