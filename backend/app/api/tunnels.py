"""SSH 本地端口转发规则。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..core.db import get_db
from ..core.security import require_auth
from ..models import TunnelRule
from ..repositories import host_repo
from ..schemas import TunnelInput, TunnelOut
from ..services.tunnel_service import get_tunnel_manager

router = APIRouter(prefix="/api/tunnels", tags=["tunnels"], dependencies=[Depends(require_auth)])


def _out(rule: TunnelRule) -> TunnelOut:
    status = get_tunnel_manager().status(rule.id)
    return TunnelOut(
        id=rule.id,
        host_id=rule.host_id,
        name=rule.name,
        local_port=rule.local_port,
        remote_host=rule.remote_host,
        remote_port=rule.remote_port,
        status=status["status"],
        bound_port=status["bound_port"],
        error=status["error"],
    )


def _get_rule(db: Session, rule_id: str) -> TunnelRule:
    rule = db.get(TunnelRule, rule_id)
    if rule is None:
        raise HTTPException(404, "转发规则不存在")
    return rule


@router.get("", response_model=list[TunnelOut])
def list_tunnels(host_id: str | None = None, db: Session = Depends(get_db)):
    query = db.query(TunnelRule)
    if host_id:
        query = query.filter(TunnelRule.host_id == host_id)
    return [_out(rule) for rule in query.order_by(TunnelRule.created_at.asc()).all()]


@router.post("", response_model=TunnelOut, status_code=201)
def create_tunnel(data: TunnelInput, db: Session = Depends(get_db)):
    host = host_repo.get_host(db, data.host_id)
    if host is None:
        raise HTTPException(404, "主机不存在")
    if host.protocol not in {"ssh", "sftp"}:
        raise HTTPException(400, "只有 SSH / SFTP 连接支持端口转发")
    if any(ord(char) < 32 for char in data.remote_host):
        raise HTTPException(400, "远端主机地址无效")
    rule = TunnelRule(
        host_id=data.host_id, name=data.name.strip(), local_port=data.local_port,
        remote_host=data.remote_host.strip(), remote_port=data.remote_port,
    )
    db.add(rule)
    db.commit()
    db.refresh(rule)
    return _out(rule)


@router.post("/{rule_id}/start", response_model=TunnelOut)
def start_tunnel(rule_id: str, db: Session = Depends(get_db)):
    rule = _get_rule(db, rule_id)
    host = host_repo.get_host(db, rule.host_id)
    if host is None:
        raise HTTPException(404, "主机不存在")
    password = host_repo.resolve_password(db, host)
    try:
        get_tunnel_manager().start(rule.id, rule.local_port, rule.remote_host, rule.remote_port, host, password)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"端口转发启动失败：{exc}") from exc
    return _out(rule)


@router.post("/{rule_id}/stop", response_model=TunnelOut)
def stop_tunnel(rule_id: str, db: Session = Depends(get_db)):
    rule = _get_rule(db, rule_id)
    get_tunnel_manager().stop(rule.id)
    return _out(rule)


@router.delete("/{rule_id}", status_code=204)
def delete_tunnel(rule_id: str, db: Session = Depends(get_db)):
    rule = _get_rule(db, rule_id)
    get_tunnel_manager().stop(rule.id)
    db.delete(rule)
    db.commit()
