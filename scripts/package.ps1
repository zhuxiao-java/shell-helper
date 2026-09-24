# 一键打包桌面端 (Windows)：PyInstaller 构建 Python 后端 -> electron-builder 生成安装包。
# 产物目录: apps/desktop/release/
# 用法: powershell -ExecutionPolicy Bypass -File scripts\package.ps1 [electron-builder 附加参数]
# 其他平台请使用 scripts/package.sh。
#
# electron-builder 需要下载对应版本的 Electron 发行包 (GitHub Releases)。
# 若访问 GitHub 困难，先设置镜像再运行本脚本:
#   $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
#   $env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$Backend = Join-Path $Root "backend"
$Desktop = Join-Path $Root "apps\desktop"
$Py = if ($env:PYTHON) { $env:PYTHON } else { Join-Path $Root ".venv\Scripts\python.exe" }
$BackendExe = Join-Path $Backend "dist\shell-helper-backend.exe"

Write-Host "==> 1/5 检查构建依赖"
if (-not (Test-Path $Py)) { Write-Error "找不到 Python 解释器: $Py (可通过环境变量 PYTHON 指定)"; exit 1 }
& $Py -m PyInstaller --version *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host "    安装构建期依赖 PyInstaller"
  & $Py -m pip install -r (Join-Path $Backend "requirements-build.txt")
  if ($LASTEXITCODE -ne 0) { exit 1 }
}
if (-not (Test-Path (Join-Path $Desktop "node_modules"))) {
  Write-Host "    安装桌面端依赖"
  Push-Location $Desktop; npm install --no-audit --no-fund; $code = $LASTEXITCODE; Pop-Location
  if ($code -ne 0) { exit 1 }
}

Write-Host "==> 2/5 运行后端测试"
Push-Location $Backend; & $Py -m unittest discover -s tests; $code = $LASTEXITCODE; Pop-Location
if ($code -ne 0) { exit 1 }

Write-Host "==> 3/5 PyInstaller 打包 Python 后端"
Remove-Item -Recurse -Force (Join-Path $Backend "build"), (Join-Path $Backend "dist") -ErrorAction SilentlyContinue
Push-Location $Backend; & $Py -m PyInstaller --noconfirm --clean pyi_backend.spec; $code = $LASTEXITCODE; Pop-Location
if ($code -ne 0 -or -not (Test-Path $BackendExe)) { Write-Error "后端产物缺失: $BackendExe"; exit 1 }

Write-Host "==> 4/5 冒烟检查后端产物 (临时数据目录，不触碰用户数据)"
$SmokeDir = Join-Path ([IO.Path]::GetTempPath()) ("shell-helper-smoke-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $SmokeDir | Out-Null
$Log = Join-Path $SmokeDir "handshake.log"
$Proc = Start-Process -FilePath $BackendExe `
  -ArgumentList @("--port", "0", "--token", "build-smoke", "--data-dir", $SmokeDir) `
  -RedirectStandardOutput $Log -PassThru -NoNewWindow
$handshake = $false
for ($i = 0; $i -lt 40; $i++) {
  if ((Get-Content $Log -Raw -ErrorAction SilentlyContinue) -match "(?m)^HANDSHAKE ") { $handshake = $true; break }
  if ($Proc.HasExited) { break }
  Start-Sleep -Milliseconds 500
}
if (-not $Proc.HasExited) { Stop-Process -Id $Proc.Id -Force -ErrorAction SilentlyContinue }
if (-not $handshake) {
  Write-Host "后端冒烟检查失败 (未收到 HANDSHAKE)，日志:"
  Get-Content $Log -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $SmokeDir -ErrorAction SilentlyContinue
  exit 1
}
Remove-Item -Recurse -Force $SmokeDir -ErrorAction SilentlyContinue
Write-Host "    后端可正常启动并打印握手信息"

Write-Host "==> 5/5 electron-builder 打包桌面端"
Push-Location $Desktop
npm run build
if ($LASTEXITCODE -ne 0) { Pop-Location; exit 1 }
npx electron-builder @args
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0) { exit 1 }

Write-Host "完成，安装包位于: $Desktop\release"
