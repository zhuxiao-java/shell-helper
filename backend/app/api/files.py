"""文件管理 API(SFTP / FTP 通用)。

通过会话的 provider 屏蔽 SFTP 与 FTP 差异,提供列目录、mkdir、rename、delete。
"""
from __future__ import annotations

import asyncio
import posixpath
import queue
import threading
from ftplib import error_perm
from urllib.parse import quote
from fastapi import APIRouter, Depends, HTTPException, Query, Header, Request, Response
from fastapi.responses import StreamingResponse
from starlette.concurrency import run_in_threadpool
from ..services.file_provider import ContentError, MAX_CONTENT_BYTES, MAX_STREAM_BYTES, TRANSFER_TIMEOUT, digest

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


def _download_name(path: str) -> str:
    name = posixpath.basename(path)
    if not name or name in {".", ".."}:
        raise HTTPException(400, "无效的远程路径")
    return name


@router.get("/download")
def download_file(session_id: str, path: str):
    provider = _provider_or_404(session_id)
    size = _content_operation(lambda: provider.regular_file_size(path))
    name = _download_name(path)

    def generate():
        yield from provider.iter_bytes(path)

    return StreamingResponse(generate(), media_type="application/octet-stream", headers={
        "Content-Length": str(size),
        "Content-Disposition": f"attachment; filename*=UTF-8''{quote(name)}",
        "Cache-Control": "no-store",
    })


@router.get("/tree")
def list_tree(session_id: str, path: str = "/", limit: int = 2000):
    """递归列出目录中的普通文件，供整目录下载。上限 2000 个文件。"""
    provider = _provider_or_404(session_id)
    if limit < 1 or limit > 2000:
        raise HTTPException(400, "目录列举上限无效")
    found: list[dict] = []
    stack = [(path or "/", "")]
    while stack:
        directory, prefix = stack.pop()
        try:
            entries = _content_operation(lambda directory=directory: provider.list(directory))
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(400, f"无法列出目录: {exc}") from exc
        for entry in entries:
            if entry.name in {".", ".."} or "/" in entry.name or "\\" in entry.name:
                continue
            relative = f"{prefix}{entry.name}"
            if entry.is_dir:
                stack.append((entry.path, relative + "/"))
            else:
                found.append({"path": entry.path, "relative": relative, "size": entry.size})
                if len(found) > limit:
                    raise HTTPException(413, "目录中的文件超过 2000 个")
    return {"files": found}


_CANCEL = object()


@router.post("/upload")
async def upload_file(request: Request, session_id: str, directory: str = "/", name: str = "", overwrite: bool = False):
    filename = posixpath.basename((name or "").replace("\\", "/"))
    if not filename or filename in {".", ".."} or any(ord(char) < 32 for char in filename):
        raise HTTPException(400, "无效的文件名")
    provider = _provider_or_404(session_id)
    target = provider.join(directory or "/", filename)
    exists = await run_in_threadpool(_content_operation, lambda: provider.file_exists(target))
    if exists:
        is_directory = await run_in_threadpool(_content_operation, lambda: provider.is_dir(target))
        if is_directory:
            raise HTTPException(400, "只能传输普通文件")
        if not overwrite:
            raise HTTPException(409, "远程已有同名文件")
    blocks: queue.Queue = queue.Queue(maxsize=4)
    errors: list[BaseException] = []

    def consume() -> None:
        def chunks():
            while True:
                item = blocks.get()
                if item is None:
                    return
                if item is _CANCEL:
                    raise ContentError(499, "已取消")
                yield item
        try:
            provider.write_stream(target, chunks())
        except BaseException as exc:  # noqa: BLE001
            errors.append(exc)

    worker = threading.Thread(target=consume, daemon=True)
    worker.start()
    total = 0
    cancelled = False
    try:
        async for block in request.stream():
            if await request.is_disconnected():
                cancelled = True
                break
            total += len(block)
            if total > MAX_STREAM_BYTES:
                cancelled = True
                raise HTTPException(413, "文件超过 8 GiB 上限")
            await asyncio.to_thread(blocks.put, block)
    finally:
        await asyncio.to_thread(blocks.put, _CANCEL if cancelled else None)
        await asyncio.to_thread(worker.join)
    if errors:
        err = errors[0]
        if isinstance(err, ContentError):
            raise HTTPException(err.status, str(err)) from err
        if isinstance(err, HTTPException):
            raise err
        raise HTTPException(502, f"文件传输失败: {err}") from err
    return {"path": target, "size": total}


@router.post("/mkdir", status_code=204)
def mkdir(session_id: str, path: str):
    provider = _provider_or_404(session_id)
    try:
        _content_operation(lambda: provider.mkdir(path))
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"创建目录失败: {e}") from e

@router.post("/create", status_code=204)
def create_file(session_id: str, path: str):
    provider = _provider_or_404(session_id)
    try:
        _content_operation(lambda: provider.create_file(path))
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"创建文件失败: {e}") from e

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
