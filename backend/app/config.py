"""应用配置。

端口与 token 由 Electron 主进程通过命令行参数注入，
后端启动完成后把真实监听端口和 token 打印到 stdout 供主进程解析。
"""
from __future__ import annotations

import os
import secrets
from dataclasses import dataclass, field
from pathlib import Path


def _default_data_dir() -> Path:
    """跨平台用户数据目录。"""
    override = os.environ.get("SHELL_HELPER_DATA_DIR")
    if override:
        return Path(override)
    home = Path.home()
    if os.name == "nt":  # Windows
        base = Path(os.environ.get("APPDATA", home / "AppData" / "Roaming"))
    elif Path("/Applications").exists() or "darwin" in os.platform().lower():  # macOS
        base = home / "Library" / "Application Support"
    else:  # Linux 等
        base = Path(os.environ.get("XDG_DATA_HOME", home / ".local" / "share"))
    return base / "shell-helper"


@dataclass
class Settings:
    """运行期配置（从命令行 / 环境变量解析）。"""

    host: str = "127.0.0.1"
    port: int = 0  # 0 表示让系统分配随机端口
    token: str = field(default_factory=lambda: secrets.token_urlsafe(32))
    data_dir: Path = field(default_factory=_default_data_dir)
    db_url: str = ""
    master_key: str = ""  # 无系统 Keychain 时的降级主密钥

    def __post_init__(self) -> None:
        self.data_dir = Path(self.data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        if not self.db_url:
            self.db_url = f"sqlite:///{self.data_dir / 'shell-helper.db'}"

    @property
    def log_dir(self) -> Path:
        d = self.data_dir / "logs"
        d.mkdir(parents=True, exist_ok=True)
        return d


def load_settings(argv: list[str] | None = None) -> Settings:
    """从命令行参数与环境变量加载配置。

    支持: --port=8000 --data-dir=/path --token=xxx
    """
    argv = argv if argv is not None else _sys_argv()
    kwargs: dict[str, object] = {}
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg.startswith("--"):
            key, _, val = arg[2:].partition("=")
            if not val and i + 1 < len(argv) and not argv[i + 1].startswith("--"):
                i += 1
                val = argv[i]
            key = key.replace("-", "_")
            if key == "port":
                kwargs["port"] = int(val)
            elif key == "data_dir":
                kwargs["data_dir"] = Path(val)
            elif key in ("token", "host", "master_key", "db_url"):
                kwargs[key] = val
        i += 1

    s = Settings(**kwargs)  # type: ignore[arg-type]
    # 环境变量兜底
    env_token = os.environ.get("SHELL_HELPER_TOKEN")
    if env_token and "token" not in kwargs:
        s.token = env_token
    env_master = os.environ.get("SHELL_HELPER_MASTER_KEY")
    if env_master:
        s.master_key = env_master
    return s


def _sys_argv() -> list[str]:
    import sys

    # 去掉脚本名
    return sys.argv[1:]
