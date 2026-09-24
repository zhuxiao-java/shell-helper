"""应用级共享状态(单例)。

集中持有 Settings、数据库 engine、会话管理器等跨请求资源，
供 FastAPI 依赖注入与各 service 引用。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from ..config import Settings, load_settings

if TYPE_CHECKING:  # 避免循环引用
    from sqlalchemy.engine import Engine

    from ..services.session_manager import SessionManager


@dataclass
class AppState:
    settings: Settings
    engine: "Engine | None" = None
    session_manager: "SessionManager | None" = None


_state: AppState | None = None


def init_state(argv: list[str] | None = None) -> AppState:
    global _state
    _state = AppState(settings=load_settings(argv))
    return _state


def get_state() -> AppState:
    if _state is None:
        raise RuntimeError("AppState 尚未初始化")
    return _state


def get_settings() -> Settings:
    return get_state().settings
