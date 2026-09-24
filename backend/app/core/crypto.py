"""凭据加密。

优先从系统 Keychain(keyring) 读取主密钥；不可用时降级到
Settings.master_key(由环境变量注入)。使用 AES-256-GCM 加密具体凭据。
"""
from __future__ import annotations

import base64
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .state import get_settings

_KEYRING_SERVICE = "shell-helper"
_KEYRING_KEY = "master-key"
_KEK_INFO = b"shell-helper-master-key-v1"


def _b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii")


def _b64d(text: str) -> bytes:
    return base64.urlsafe_b64decode(text.encode("ascii"))


def _derive_key(secret: str) -> bytes:
    """从主密钥字符串派生 256bit key(使用 HKDF)。"""
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF

    hkdf = HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=None,
        info=_KEK_INFO,
    )
    return hkdf.derive(secret.encode("utf-8"))


def _load_or_create_master_secret() -> str:
    """尝试 keyring；失败降级到环境变量 / 本地文件。"""
    secret = os.environ.get("SHELL_HELPER_MASTER_KEY")
    if secret:
        return secret
    try:
        import keyring

        existing = keyring.get_password(_KEYRING_SERVICE, _KEYRING_KEY)
        if existing:
            return existing
        new = base64.urlsafe_b64encode(os.urandom(32)).decode("ascii")
        keyring.set_password(_KEYRING_SERVICE, _KEYRING_KEY, new)
        return new
    except Exception:  # noqa: BLE001 - keyring 后端缺失时降级
        # 落到本地文件(权限受限),仅作 MVP 兜底
        path = get_settings().data_dir / ".master.key"
        if path.exists():
            return path.read_text("utf-8").strip()
        new = base64.urlsafe_b64encode(os.urandom(32)).decode("ascii")
        path.write_text(new, "utf-8")
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
        return new


class Crypto:
    """AES-256-GCM 加解密工具。"""

    def __init__(self) -> None:
        self._key = _derive_key(_load_or_create_master_secret())
        self._aesgcm = AESGCM(self._key)

    def encrypt(self, plaintext: str) -> tuple[str, str]:
        """返回 (ciphertext_b64, nonce_b64)。"""
        nonce = os.urandom(12)
        ct = self._aesgcm.encrypt(nonce, plaintext.encode("utf-8"), None)
        return _b64e(ct), _b64e(nonce)

    def decrypt(self, ciphertext_b64: str, nonce_b64: str) -> str:
        ct = _b64d(ciphertext_b64)
        nonce = _b64d(nonce_b64)
        return self._aesgcm.decrypt(nonce, ct, None).decode("utf-8")


_crypto: Crypto | None = None


def get_crypto() -> Crypto:
    global _crypto
    if _crypto is None:
        _crypto = Crypto()
    return _crypto
