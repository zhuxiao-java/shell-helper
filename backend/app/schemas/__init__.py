"""Pydantic 请求/响应模型。"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Protocol = Literal["ssh", "sftp", "telnet", "ftp", "local"]
AuthType = Literal["password", "pubkey", "agent", "none"]

# 哪些协议默认打开终端界面,哪些默认打开文件界面
TERMINAL_PROTOCOLS = {"ssh", "telnet", "local"}
FILE_PROTOCOLS = {"sftp", "ftp"}


class CredentialInput(BaseModel):
    label: str = ""
    type: str = "password"
    value: str | None = None  # 明文,仅入参;创建后不返回
    key_path: str = ""


class HostInput(BaseModel):
    name: str = Field(min_length=1)
    group: str = "默认分组"
    protocol: Protocol = "ssh"
    host: str = ""
    port: int = 22
    username: str = ""
    auth_type: AuthType = "password"
    key_path: str = ""
    jump_host_ids: list[str] = Field(default_factory=list)
    tags: str = ""
    remote_cwd: str = "~"
    # 便捷字段:直接传密码,后端自动建凭据
    password: str | None = None


class HostOut(BaseModel):
    id: str
    name: str
    group: str
    protocol: str
    host: str
    port: int
    username: str
    auth_type: str
    credential_id: str | None
    key_path: str
    jump_host_ids: list[str] = Field(default_factory=list)
    tags: str
    remote_cwd: str

    model_config = {"from_attributes": True}


class HostTestInput(HostInput):
    id: str | None = None


class KnownHostInput(BaseModel):
    host: str = Field(min_length=1, max_length=255)
    port: int = Field(ge=1, le=65535)
    key_type: str = Field(min_length=1, max_length=40)
    public_key: str = Field(min_length=1, max_length=8192)
    fingerprint: str = Field(min_length=1, max_length=200)


class SessionInput(BaseModel):
    host_id: str
    type: Literal["terminal", "sftp", "ftp"] = "terminal"


class SessionOut(BaseModel):
    session_id: str
    host_id: str
    type: str
    status: str
    remote_cwd: str = ""


class FileEntry(BaseModel):
    name: str
    path: str
    is_dir: bool
    size: int
    mtime: float
    mode: str


class FileListOut(BaseModel):
    path: str
    entries: list[FileEntry]


class TunnelInput(BaseModel):
    host_id: str
    name: str = Field(default="本地转发", min_length=1, max_length=200)
    local_port: int = Field(default=8080, ge=0, le=65535)
    remote_host: str = Field(default="127.0.0.1", min_length=1, max_length=255)
    remote_port: int = Field(default=80, ge=1, le=65535)


class TunnelOut(BaseModel):
    id: str
    host_id: str
    name: str
    local_port: int
    remote_host: str
    remote_port: int
    status: str = "stopped"
    bound_port: int | None = None
    error: str = ""


class ErrorResponse(BaseModel):
    detail: str
