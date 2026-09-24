"""主机管理 API。"""
from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..core.db import get_db
from ..core.security import require_auth
from ..models import Host
from ..repositories import host_repo
from ..schemas import HostInput, HostOut

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
