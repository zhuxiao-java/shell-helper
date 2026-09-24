#!/usr/bin/env bash
# 一键打包桌面端：PyInstaller 构建 Python 后端 -> electron-builder 生成安装包。
# 产物目录: apps/desktop/release/
# 注意: electron-builder 不支持跨平台出包，请在目标系统上运行对应脚本
#       (macOS/Linux 用本脚本，Windows 用 scripts/package.ps1)。
# 用法: ./scripts/package.sh [electron-builder 附加参数，如 --mac dmg]
#
# electron-builder 需要下载对应版本的 Electron 发行包 (GitHub Releases)。
# 若访问 GitHub 困难，先设置镜像再运行本脚本:
#   export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
#   export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND="$ROOT/backend"
DESKTOP="$ROOT/apps/desktop"
PY="${PYTHON:-$ROOT/.venv/bin/python}"
NPM="${NPM:-npm}"
BACKEND_EXE="$BACKEND/dist/shell-helper-backend"

echo "==> 1/5 检查构建依赖"
[ -x "$PY" ] || { echo "找不到 Python 解释器: $PY (可通过环境变量 PYTHON 指定)"; exit 1; }
if ! "$PY" -m PyInstaller --version >/dev/null 2>&1; then
  echo "    安装构建期依赖 PyInstaller"
  "$PY" -m pip install -r "$BACKEND/requirements-build.txt"
fi
if [ ! -d "$DESKTOP/node_modules" ]; then
  echo "    安装桌面端依赖"
  (cd "$DESKTOP" && "$NPM" install --no-audit --no-fund)
fi

echo "==> 2/5 运行后端测试"
(cd "$BACKEND" && "$PY" -m unittest discover -s tests)

echo "==> 3/5 PyInstaller 打包 Python 后端"
rm -rf "$BACKEND/build" "$BACKEND/dist"
(cd "$BACKEND" && "$PY" -m PyInstaller --noconfirm --clean pyi_backend.spec)
[ -f "$BACKEND_EXE" ] || { echo "后端产物缺失: $BACKEND_EXE"; exit 1; }

echo "==> 4/5 冒烟检查后端产物 (临时数据目录，不触碰用户数据)"
SMOKE_DIR="$(mktemp -d)"
LOG="$SMOKE_DIR/handshake.log"
"$BACKEND_EXE" --port 0 --token build-smoke --data-dir "$SMOKE_DIR" >"$LOG" 2>&1 &
BACKEND_PID=$!
handshake=""
for _ in $(seq 1 40); do
  if grep -q '^HANDSHAKE ' "$LOG"; then handshake=ok; break; fi
  kill -0 "$BACKEND_PID" 2>/dev/null || break
  sleep 0.5
done
kill "$BACKEND_PID" 2>/dev/null || true
wait "$BACKEND_PID" 2>/dev/null || true
if [ -z "$handshake" ]; then
  echo "后端冒烟检查失败 (未收到 HANDSHAKE)，日志:"
  cat "$LOG" || true
  rm -rf "$SMOKE_DIR"
  exit 1
fi
rm -rf "$SMOKE_DIR"
echo "    后端可正常启动并打印握手信息"

echo "==> 5/5 electron-builder 打包桌面端"
(cd "$DESKTOP" && "$NPM" run build && npx electron-builder "$@")

echo "完成，安装包位于: $DESKTOP/release"
