"""会话生命周期 API。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from ..core.security import require_auth
from ..schemas import SessionInput, SessionOut
from ..services.session_manager import get_session_manager

router = APIRouter(prefix="/api/sessions", tags=["sessions"], dependencies=[Depends(require_auth)])


@router.post("", response_model=SessionOut, status_code=201)
def create_session(data: SessionInput):
    mgr = get_session_manager()
    try:
        session = mgr.create(data.host_id, data.type)
    except KeyError as e:
        raise HTTPException(404, str(e)) from e
    except NotImplementedError as e:
        raise HTTPException(501, str(e)) from e
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:  # noqa: BLE001 - 连接失败统一转 502
        raise HTTPException(502, f"连接失败: {e}") from e
    return SessionOut(
        session_id=session.session_id,
        host_id=session.host_id,
        type=session.type,
        status="active",
        remote_cwd=session.remote_cwd,
    )


@router.post("/local", response_model=SessionOut, status_code=201)
def create_local_session():
    try:
        session = get_session_manager().create_local()
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(502, f"本地终端启动失败: {exc}") from exc
    return SessionOut(session_id=session.session_id, host_id=session.host_id, type="terminal",
                      status="active", remote_cwd=session.remote_cwd)


@router.get("", response_model=list[str])
def list_sessions():
    return get_session_manager().list_ids()


@router.get("/{session_id}", response_model=SessionOut)
def get_session(session_id: str):
    session = get_session_manager().get(session_id)
    if session is None or session.closed or (session.provider is not None and session.provider.closed):
        raise HTTPException(410, "会话已断开")
    return SessionOut(session_id=session.session_id, host_id=session.host_id, type=session.type,
                      status="active", remote_cwd=session.remote_cwd)


@router.delete("/{session_id}", status_code=204)
def close_session(session_id: str):
    get_session_manager().close(session_id)
