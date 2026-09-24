"""数据访问层(Repository)。"""
from __future__ import annotations

import json

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Credential, Host
from ..schemas import HostInput


def list_hosts(db: Session) -> list[Host]:
    return list(db.scalars(select(Host).order_by(Host.group, Host.name)).all())


def get_host(db: Session, host_id: str) -> Host | None:
    return db.get(Host, host_id)


def _apply(host: Host, data: HostInput, db: Session) -> None:
    host.name = data.name
    host.group = data.group
    host.protocol = data.protocol
    host.host = data.host
    host.port = data.port
    host.username = data.username
    host.auth_type = data.auth_type
    host.key_path = data.key_path
    host.tags = data.tags
    host.remote_cwd = data.remote_cwd
    host.jump_host_ids = json.dumps(data.jump_host_ids)

    # 直接传了密码则创建/更新凭据
    if data.password:
        cred = host.credential or Credential(label=data.name, type="password")
        _set_secret(cred, data.password, db)
        host.credential = cred


def _set_secret(cred: Credential, plaintext: str, db: Session) -> None:
    from ..core.crypto import get_crypto

    ct, nonce = get_crypto().encrypt(plaintext)
    cred.ciphertext = ct
    cred.nonce = nonce
    if cred not in db:
        db.add(cred)


def create_host(db: Session, data: HostInput) -> Host:
    host = Host()
    _apply(host, data, db)
    db.add(host)
    db.flush()
    return host


def update_host(db: Session, host: Host, data: HostInput) -> Host:
    _apply(host, data, db)
    db.flush()
    return host


def delete_host(db: Session, host: Host) -> None:
    db.delete(host)


def resolve_password(db: Session, host: Host) -> str | None:
    """解密取回主机密码。"""
    cred = host.credential
    if not cred or not cred.ciphertext:
        return None
    from ..core.crypto import get_crypto

    return get_crypto().decrypt(cred.ciphertext, cred.nonce)


def jump_chain(db: Session, host: Host) -> list[Host]:
    """返回跳板链路(顺序:从外到内)。"""
    ids = json.loads(host.jump_host_ids or "[]")
    chain: list[Host] = []
    for hid in ids:
        j = db.get(Host, hid)
        if j:
            chain.append(j)
    return chain
