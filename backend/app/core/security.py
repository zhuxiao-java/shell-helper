"""鉴权:校验 Bearer Token 与 WebSocket token。

后端仅监听 127.0.0.1，但仍需 token 防止本机其它进程滥用。
"""
from __future__ import annotations

import hmac

from fastapi import HTTPException, Security, WebSocket
from fastapi.security.api_key import APIKeyHeader

from .state import get_settings

_api_key_header = APIKeyHeader(name="Authorization", auto_error=False)


def _expected() -> str:
    return get_settings().token


def token_ok(provided: str | None) -> bool:
    if not provided:
        return False
    # 支持 "Bearer xxx" 与裸 token 两种写法
    if provided.lower().startswith("bearer "):
        provided = provided[7:]
    return hmac.compare_digest(provided, _expected())


async def require_auth(api_key: str | None = Security(_api_key_header)) -> None:
    if not token_ok(api_key):
        raise HTTPException(status_code=401, detail="无效或缺失的访问令牌")


def require_ws_auth(websocket: WebSocket) -> bool:
    """WebSocket 握手鉴权:优先 Sec-WebSocket-Protocol,其次 query。"""
    protocols = websocket.headers.get("sec-websocket-protocol", "")
    for p in protocols.split(","):
        p = p.strip().removeprefix("bearer.")
        if token_ok(p):
            return True
    if token_ok(websocket.query_params.get("token")):
        return True
    if token_ok(websocket.headers.get("authorization")):
        return True
    return False
