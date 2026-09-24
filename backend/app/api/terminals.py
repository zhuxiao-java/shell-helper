"""终端 WebSocket 桥接。

协议:
- 二进制帧:终端原始输入/输出字节
- 文本帧(JSON):控制消息 {"type":"resize","cols":..,"rows":..}

后端从 Paramiko channel 读输出用独立线程 + run_in_executor 避免阻塞事件循环。
"""
from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..core.security import require_ws_auth
from ..services.session_manager import get_session_manager

router = APIRouter(tags=["terminals"])

_CHUNK = 4096


@router.websocket("/api/terminals/{session_id}/ws")
async def terminal_ws(websocket: WebSocket, session_id: str):
    if not require_ws_auth(websocket):
        await websocket.close(code=4401)
        return

    manager = get_session_manager()
    session = manager.get(session_id)
    if session is None or session.closed or session.channel is None:
        await websocket.close(code=4404)
        return
    if not session.attach_terminal():
        await websocket.close(code=4409)
        return

    channel = session.channel

    async def pump_output() -> None:
        """channel -> WebSocket。"""
        while True:
            data = await asyncio.to_thread(_blocking_read, channel)
            if data is None:
                return
            if data:
                await websocket.send_bytes(data)
            else:
                await asyncio.sleep(0.01)

    async def pump_input() -> None:
        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                break
            if (raw := message.get("bytes")) is not None:
                await asyncio.to_thread(channel.sendall, raw)
            elif (text := message.get("text")) is not None:
                await asyncio.to_thread(_handle_control, channel, text)

    tasks = []
    code = 1000
    try:
        await websocket.accept()
        tasks = [asyncio.create_task(pump_output()), asyncio.create_task(pump_input())]
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
    except (WebSocketDisconnect, EOFError):
        pass
    except Exception:  # noqa: BLE001
        code = 1011
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await asyncio.to_thread(manager.close, session_id)
        try:
            await websocket.close(code=code)
        except (RuntimeError, WebSocketDisconnect):
            pass


def _blocking_read(channel) -> bytes | None:
    channel.settimeout(0.1)
    if channel.recv_ready():
        data = channel.recv(_CHUNK)
        if data:
            return data
    if channel.closed or channel.eof_received:
        return None
    return b""


def _handle_control(channel, text: str) -> None:
    try:
        msg = json.loads(text)
    except json.JSONDecodeError:
        return
    if isinstance(msg, dict) and msg.get("type") == "resize":
        cols, rows = msg.get("cols", 80), msg.get("rows", 24)
        if type(cols) is not int or type(rows) is not int or not 1 <= cols <= 1000 or not 1 <= rows <= 1000:
            return
        try:
            channel.resize_pty(width=cols, height=rows)
        except Exception:  # noqa: BLE001
            pass
