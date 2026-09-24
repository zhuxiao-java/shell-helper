"""SQLAlchemy ORM 模型。"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..core.db import Base


def _uuid() -> str:
    return uuid.uuid4().hex


def _now() -> datetime:
    return datetime.now(timezone.utc)


class Credential(Base):
    __tablename__ = "credentials"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    label: Mapped[str] = mapped_column(String(200), default="")
    type: Mapped[str] = mapped_column(String(20), default="password")  # password/privkey/passphrase
    ciphertext: Mapped[str] = mapped_column(Text, default="")
    nonce: Mapped[str] = mapped_column(String(64), default="")
    key_path: Mapped[str] = mapped_column(String(500), default="")
    created_at: Mapped[datetime] = mapped_column(default=_now)


class Host(Base):
    __tablename__ = "hosts"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(200))
    group: Mapped[str] = mapped_column(String(200), default="默认分组")
    protocol: Mapped[str] = mapped_column(String(20), default="ssh")  # ssh/telnet/ftp/local
    host: Mapped[str] = mapped_column(String(255), default="")
    port: Mapped[int] = mapped_column(default=22)
    username: Mapped[str] = mapped_column(String(200), default="")
    auth_type: Mapped[str] = mapped_column(String(20), default="password")  # password/pubkey/agent/none
    credential_id: Mapped[str | None] = mapped_column(ForeignKey("credentials.id"), nullable=True)
    key_path: Mapped[str] = mapped_column(String(500), default="")
    jump_host_ids: Mapped[str] = mapped_column(Text, default="")  # JSON 数组字符串
    tags: Mapped[str] = mapped_column(String(500), default="")
    remote_cwd: Mapped[str] = mapped_column(String(500), default="~")
    created_at: Mapped[datetime] = mapped_column(default=_now)
    updated_at: Mapped[datetime] = mapped_column(default=_now, onupdate=_now)

    credential: Mapped[Credential | None] = relationship(
        "Credential",
        uselist=False,
        cascade="all,delete-orphan",
        single_parent=True,
        lazy="joined",
    )


class KnownHost(Base):
    __tablename__ = "known_hosts"
    __table_args__ = (UniqueConstraint("host", "port", name="uq_known_host_port"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    host: Mapped[str] = mapped_column(String(255))
    port: Mapped[int] = mapped_column(default=22)
    fingerprint: Mapped[str] = mapped_column(String(200), default="")
    added_at: Mapped[datetime] = mapped_column(default=_now)
