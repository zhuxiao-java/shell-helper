"""数据库:SQLAlchemy engine / session / 建表。"""
from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import create_engine
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .state import get_state


class Base(DeclarativeBase):
    pass


_engine: Engine | None = None
_SessionLocal: sessionmaker[Session] | None = None


def init_db() -> Engine:
    global _engine, _SessionLocal
    settings = get_state().settings
    _engine = create_engine(
        settings.db_url,
        connect_args={"check_same_thread": False} if "sqlite" in settings.db_url else {},
        future=True,
    )
    _SessionLocal = sessionmaker(bind=_engine, autoflush=False, expire_on_commit=False)
    # 延迟导入以注册所有模型
    from .. import models  # noqa: F401

    Base.metadata.create_all(_engine)
    _ensure_known_host_columns(_engine)
    get_state().engine = _engine
    return _engine


def _ensure_known_host_columns(engine: Engine) -> None:
    """已有数据库补上主机密钥材料列。create_all 不会修改旧表。"""
    from sqlalchemy import inspect, text

    inspector = inspect(engine)
    if "known_hosts" not in inspector.get_table_names():
        return
    columns = {column["name"] for column in inspector.get_columns("known_hosts")}
    statements = []
    if "key_type" not in columns:
        statements.append("ALTER TABLE known_hosts ADD COLUMN key_type VARCHAR(40) DEFAULT ''")
    if "public_key" not in columns:
        statements.append("ALTER TABLE known_hosts ADD COLUMN public_key TEXT DEFAULT ''")
    if not statements:
        return
    with engine.begin() as connection:
        for statement in statements:
            connection.execute(text(statement))


def get_engine() -> Engine:
    if _engine is None:
        return init_db()
    return _engine


@contextmanager
def session_scope() -> Iterator[Session]:
    if _SessionLocal is None:
        init_db()
    assert _SessionLocal is not None
    session = _SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def get_db() -> Iterator[Session]:
    """FastAPI 依赖:请求成功时提交,异常时回滚。"""
    if _SessionLocal is None:
        init_db()
    assert _SessionLocal is not None
    session = _SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
