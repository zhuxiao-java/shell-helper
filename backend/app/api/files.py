"""文件管理 API(SFTP / FTP 通用)。

通过会话的 provider 屏蔽 SFTP 与 FTP 差异,提供列目录、mkdir、rename、delete。
"""
from __future__ import annotations

import asyncio
from ftplib import error_perm
from fastapi import APIRouter, Depends, HTTPException, Query, Header, Request, Response
from starlette.concurrency import run_in_threadpool
from ..services.file_provider import ContentError, MAX_CONTENT_BYTES, TRANSFER_TIMEOUT, digest

from ..core.security import require_auth
from ..schemas import FileEntry, FileListOut
from ..services.session_manager import get_session_manager

router = APIRouter(prefix="/api/files", tags=["files"], dependencies=[Depends(require_auth)])


def _provider_or_404(session_id: str):
    try:
        return get_session_manager().get_provider(session_id)
    except KeyError as e:
        raise HTTPException(410, str(e)) from e


def _content_operation(operation):
    try:
        return operation()
    except ContentError as e:
        raise HTTPException(e.status, str(e)) from e
    except FileNotFoundError as e:
        raise HTTPException(404, "远程文件不存在") from e
    except (PermissionError, error_perm) as e:
        raise HTTPException(403, "远程文件权限不足或服务器拒绝访问") from e
    except (OSError, EOFError) as e:
        raise HTTPException(502, f"文件传输失败: {e}") from e


@router.get("/content")
def get_content(session_id: str, path: str):
    provider = _provider_or_404(session_id)
    data = _content_operation(lambda: provider.read_content(path))
    return Response(data, media_type="application/octet-stream", headers={
        "X-Content-SHA256": digest(data), "Cache-Control": "no-store"
    })


@router.put("/content")
async def put_content(request: Request, session_id: str, path: str,
                      expected: str = Header(..., alias="X-Expected-SHA256")):
    import re
    if not re.fullmatch(r"[a-f0-9]{64}", expected):
        raise HTTPException(400, "缺少有效的原始内容摘要")
    provider = _provider_or_404(session_id)
    data = bytearray()
    try:
        async with asyncio.timeout(TRANSFER_TIMEOUT):
            async for block in request.stream():
                if len(data) + len(block) > MAX_CONTENT_BYTES:
                    raise HTTPException(413, "文件超过 10 MiB 上限")
                data.extend(block)
    except TimeoutError as e:
        raise HTTPException(408, "上传请求超时") from e
    result = await run_in_threadpool(
        _content_operation, lambda: provider.write_content(path, bytes(data), expected)
    )
    return {"sha256": result}


@router.get("/list", response_model=FileListOut)
def list_dir(session_id: str = Query(...), path: str = Query(".")):
    provider = _provider_or_404(session_id)
    target = path or "."
    try:
        stats = _content_operation(lambda: provider.list(target))
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"无法列出目录: {e}") from e
    result = [
        FileEntry(
            name=s.name,
            path=provider.join(target, s.name),
            is_dir=s.is_dir,
            size=s.size,
            mtime=s.mtime,
            mode=s.mode,
        )
        for s in stats
    ]
    result.sort(key=lambda e: (not e.is_dir, e.name.lower()))
    return FileListOut(path=target, entries=result)


@router.post("/mkdir", status_code=204)
def mkdir(session_id: str, path: str):
    provider = _provider_or_404(session_id)
    try:
        _content_operation(lambda: provider.mkdir(path))
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"创建目录失败: {e}") from e


@router.post("/rename", status_code=204)
def rename(session_id: str, old_path: str, new_path: str):
    provider = _provider_or_404(session_id)
    try:
        _content_operation(lambda: provider.rename(old_path, new_path))
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"重命名失败: {e}") from e


@router.post("/delete", status_code=204)
def delete(session_id: str, path: str):
    provider = _provider_or_404(session_id)
    try:
        _content_operation(lambda: provider.remove(path))
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"删除失败: {e}") from e
