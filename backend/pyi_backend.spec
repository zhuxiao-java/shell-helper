# -*- mode: python ; coding: utf-8 -*-
"""Python 后端 PyInstaller 配置。

在 backend 目录执行：
    python -m PyInstaller --noconfirm --clean pyi_backend.spec
产出 backend/dist/shell-helper-backend（单文件可执行程序）。
electron-builder.yml 会把 backend/dist 拷贝进安装包的 resources/backend，
主进程 (apps/desktop/src/main/backend.ts) 按 resources/backend/shell-helper-backend 查找。
"""
from PyInstaller.utils.hooks import collect_submodules

# uvicorn 的 loop/protocol/http 实现都是运行期按字符串导入，需显式收集。
hiddenimports = collect_submodules("uvicorn")

a = Analysis(
    ["pyi_entry.py"],
    pathex=["."],
    binaries=[],
    datas=[],
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "PyQt5", "PySide6", "tests"],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="shell-helper-backend",
    debug=False,
    strip=False,
    upx=False,
    # 握手 JSON 通过 stdout 与 Electron 主进程通信，必须保留控制台。
    console=True,
)
