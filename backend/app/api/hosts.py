"""主机管理 API。"""
from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..core.db import get_db
from ..core.security import require_auth
from ..models import Host
from ..repositories import host_repo
from ..schemas import HostInput, HostOut, HostTestInput, KnownHostInput
from ..services import ftp_service, host_keys, ssh_service, telnet_service

router = APIRouter(prefix="/api/hosts", tags=["hosts"], dependencies=[Depends(require_auth)])


def _to_out(host: Host) -> HostOut:
    return HostOut(
        id=host.id,
        name=host.name,
        group=host.group,
        protocol=host.protocol,
        host=host.host,
        port=host.port,
        username=host.username,
        auth_type=host.auth_type,
        credential_id=host.credential_id,
        key_path=host.key_path,
        jump_host_ids=json.loads(host.jump_host_ids or "[]"),
        tags=host.tags,
        remote_cwd=host.remote_cwd,
    )


@router.get("", response_model=list[HostOut])
def list_hosts(db: Session = Depends(get_db)):
    return [_to_out(h) for h in host_repo.list_hosts(db)]


@router.post("", response_model=HostOut, status_code=201)
def create_host(data: HostInput, db: Session = Depends(get_db)):
    host = host_repo.create_host(db, data)
    return _to_out(host)


@router.post("/test")
def test_connection(data: HostTestInput, db: Session = Depends(get_db)):
    if data.protocol == "local":
        return {"ok": True, "message": "本地终端使用本机 Shell，无需远程探测"}
    if not data.host.strip():
        raise HTTPException(400, "请输入主机地址")
    for jump_id in data.jump_host_ids:
        jump = host_repo.get_host(db, jump_id)
        if data.id and jump_id == data.id:
            raise HTTPException(400, "不能把自己设为跳板")
        if not jump or jump.protocol not in {"ssh", "sftp"}:
            raise HTTPException(400, "跳板机必须是已保存的 SSH 或 SFTP 连接")
    host = Host(
        name=data.name or "连接探测",
        group=data.group,
        protocol=data.protocol,
        host=data.host,
        port=data.port,
        username=data.username,
        auth_type=data.auth_type,
        key_path=data.key_path,
        jump_host_ids=json.dumps(data.jump_host_ids),
        tags=data.tags,
        remote_cwd=data.remote_cwd,
    )
    password = data.password or None
    if not password and data.id:
        stored = host_repo.get_host(db, data.id)
        if stored:
            password = host_repo.resolve_password(db, stored)
    try:
        if data.protocol in {"ssh", "sftp"}:
            client = ssh_service.connect(host, password)
            ssh_service.close_client(client)
        elif data.protocol == "ftp":
            ftp = ftp_service.connect(host, password)
            ftp.quit()
        elif data.protocol == "telnet":
            channel = telnet_service.connect(host, password)
            channel.close()
        else:
            raise HTTPException(400, "不支持的协议")
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        mapped = host_keys.as_http(exc)
        if mapped:
            raise mapped from exc
        raise HTTPException(502, f"连接失败: {exc}") from exc
    return {"ok": True, "message": "连接成功"}


@router.post("/known")
def trust_host_key(data: KnownHostInput):
    try:
        fingerprint = host_keys.describe_public_key(data.key_type, data.public_key)
        if fingerprint != data.fingerprint:
            raise HTTPException(400, "指纹与公钥不一致")
        host_keys.remember(data.host.strip(), data.port, data.key_type, data.public_key)
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"ok": True, "fingerprint": fingerprint}


@router.get("/export", response_model=list[HostOut])
def export_hosts(db: Session = Depends(get_db)):
    return [_to_out(host) for host in host_repo.list_hosts(db)]


@router.post("/import", response_model=list[HostOut], status_code=201)
def import_hosts(items: list[HostInput], db: Session = Depends(get_db)):
    if not items or len(items) > 500:
        raise HTTPException(400, "一次最多导入 500 条连接，且不能为空")
    created = []
    for item in items:
        created.append(host_repo.create_host(db, item.model_copy(update={"password": None})))
    return [_to_out(host) for host in created]


@router.get("/{host_id}", response_model=HostOut)
def get_host(host_id: str, db: Session = Depends(get_db)):
    host = host_repo.get_host(db, host_id)
    if not host:
        raise HTTPException(404, "主机不存在")
    return _to_out(host)


@router.put("/{host_id}", response_model=HostOut)
def update_host(host_id: str, data: HostInput, db: Session = Depends(get_db)):
    host = host_repo.get_host(db, host_id)
    if not host:
        raise HTTPException(404, "主机不存在")
    host = host_repo.update_host(db, host, data)
    return _to_out(host)


@router.delete("/{host_id}", status_code=204)
def delete_host(host_id: str, db: Session = Depends(get_db)):
    host = host_repo.get_host(db, host_id)
    if not host:
        raise HTTPException(404, "主机不存在")
    host_repo.delete_host(db, host)
