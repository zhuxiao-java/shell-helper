"""后端入口。

启动方式:
    python -m app.main --port 0 --token xxx
启动后在 stdout 打印一行握手 JSON: {"port":..,"token":..}
供 Electron 主进程解析真实端口。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from loguru import logger

from .api import files, hosts, sessions, terminals
from .core.db import get_engine, init_db
from .core.security import require_auth
from .core.state import get_settings, init_state


def create_app() -> FastAPI:
    settings = get_settings()
    logger.remove()
    logger.add(sys.stderr, level="INFO")
    logger.add(settings.log_dir / "backend.log", rotation="10 MB", retention=5, level="DEBUG")

    app = FastAPI(title="Shell Helper Backend", version="0.1.0")
    # 允许 Electron 渲染层(dev server 端口)访问本机后端
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"http://(localhost|127\.0\.0\.1)(:\d+)?",
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.on_event("startup")
    def _startup() -> None:
        init_db()
        logger.info("数据库已初始化: {}", settings.db_url)

    @app.on_event("shutdown")
    def _shutdown() -> None:
        _cleanup()

    @app.get("/healthz")
    def healthz():
        return {"status": "ok"}

    @app.post("/shutdown")
    def shutdown(_: None = Depends(require_auth)):
        from .services.session_manager import get_session_manager

        get_session_manager().close_all()
        return {"status": "bye"}

    app.include_router(hosts.router)
    app.include_router(sessions.router)
    app.include_router(files.router)
    app.include_router(terminals.router)
    return app


def _print_handshake(port: int) -> None:
    settings = get_settings()
    engine = get_engine()
    database_path = None
    if engine.url.get_backend_name() == "sqlite":
        with engine.connect() as connection:
            for _, name, filename in connection.exec_driver_sql("PRAGMA database_list"):
                if name == "main" and filename:
                    database_path = str(Path(filename).resolve())
    handshake = {
        "port": port, "token": settings.token, "host": settings.host,
        "data_dir": str(settings.data_dir.resolve()), "database_path": database_path,
    }
    # 单独一行,前缀标记,便于主进程解析
    sys.stdout.write("HANDSHAKE " + json.dumps(handshake) + "\n")
    sys.stdout.flush()


def main() -> None:
    if len(sys.argv) == 3 and sys.argv[1] == "--local-pty-child":
        from .services.local_pty_service import exec_shell

        exec_shell(sys.argv[2])
        return

    import uvicorn

    init_state(sys.argv[1:])
    settings = get_settings()
    app = create_app()

    # port=0 表示希望随机端口:自己挑一个空闲端口,避免依赖 uvicorn 内部
    # (uvicorn 0.34 在 server.startup 阶段并不暴露真实绑定端口)
    if not settings.port:
        settings.port = _pick_free_port(settings.host)

    config = uvicorn.Config(
        app, host=settings.host, port=settings.port, log_level="warning", access_log=False
    )
    server = uvicorn.Server(config)

    # 端口已知,注册 startup 钩子在服务就绪后打印握手信息
    original_startup = server.startup

    async def _startup_with_handshake(sockets=None):
        await original_startup(sockets=sockets)
        _print_handshake(settings.port)

    server.startup = _startup_with_handshake  # type: ignore[method-assign]
    try:
        server.run()
    finally:
        _cleanup()


def _pick_free_port(host: str) -> int:
    """向操作系统申请一个当前空闲的端口。"""
    import socket

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind((host, 0))
        return int(s.getsockname()[1])


def _cleanup() -> None:
    try:
        from .services.session_manager import get_session_manager

        get_session_manager().close_all()
    except Exception:  # noqa: BLE001
        pass


if __name__ == "__main__":
    main()
