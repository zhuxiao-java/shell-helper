# Shell Helper

集 **SSH 终端 / Telnet / 本地终端 / SFTP / FTP 文件管理** 于一体的跨平台桌面工具。
Electron + Vue 3 + Element Plus 提供界面，Python FastAPI 承担全部协议实现与会话管理。

## 功能特性

### 连接管理
- 支持 SSH / SFTP / FTP / Telnet / 本地终端 五类连接，按协议自动限制可用会话（如 SFTP 连接不提供终端、Telnet 不提供文件面板）
- 主机分组、标签、搜索；密码 / 公钥 / SSH Agent 多种认证；支持跳板机配置
- 凭据 AES 加密存储（系统 Keychain 托管主密钥，无系统 Keychain 时降级为本地主密钥），列表与接口不回显明文
- 最近连接记录，免配置一键打开本地终端

### 终端
- 多标签并行会话，终端 / 文件面板可随时切换
- 真实 PTY 本地终端（macOS/Linux POSIX PTY，Windows ConPTY）：中文输入输出、Ctrl+C 中断、窗口缩放自适应、多实例隔离
- 常用命令片段：可配置、一键插入终端、执行前确认
- 可配置的快捷键体系（含输入法兼容、长按抑制）

### 文件管理
- 目录树 + 文件列表双视图，支持浏览、新建、重命名、删除、上传、下载
- 文本文件外部编辑闭环：调用系统默认应用或指定编辑器，修改后确认回传，冲突检测拒绝覆盖，断线/退出保留草稿并可恢复
- 数据文件（SQLite 数据库、编辑草稿）存储位置可视化：展示、复制路径、一键打开目录

### 架构与安全
- 后端仅监听 `127.0.0.1`，HTTP + WebSocket 全部要求 Bearer Token 鉴权（Token 由 Electron 主进程随机生成、进程级注入）
- 终端数据走 WebSocket 二进制帧，控制消息（resize）走 JSON 文本帧并严格校验
- 应用退出时优雅关闭：先释放全部会话与子进程，再退出后端

## 技术栈

| 层 | 技术 |
| --- | --- |
| 桌面壳 | Electron 33、electron-vite |
| 前端 | Vue 3、TypeScript、Pinia、Element Plus、xterm.js |
| 后端 | Python 3.13、FastAPI、SQLAlchemy、Paramiko、pywinpty |
| 打包 | PyInstaller（后端）+ electron-builder（桌面端） |

## 目录结构

```
.
├── apps/desktop/        # Electron 桌面端（main / preload / renderer）
├── backend/             # Python FastAPI 后端
│   ├── app/api/         # hosts / sessions / terminals / files 路由
│   ├── app/services/    # ssh / ftp / telnet / local_pty / session_manager
│   └── tests/           # 后端单元测试（无需真实远程服务）
├── docs/                # 架构文档.md、需求文档.md
└── scripts/             # 打包脚本与应用图标生成脚本
```

## 本地开发

环境要求：Python ≥ 3.11（推荐 3.13）、Node.js ≥ 20。

```bash
# 1. 后端依赖
python -m venv .venv
.venv/bin/pip install -r backend/requirements.txt

# 2. 桌面端依赖
npm --prefix apps/desktop install

# 3. 启动开发环境（自动拉起 Python 后端 + Vite + Electron）
npm --prefix apps/desktop run dev
```

## 测试

```bash
# 后端单元测试（含真实 POSIX PTY 用例，macOS/Linux）
.venv/bin/python -m unittest discover -s backend/tests

# 前端逻辑测试 + 类型检查
npm --prefix apps/desktop test
npm --prefix apps/desktop run typecheck

# 真实 Electron 界面回归 / 启动与本地终端验收（构建后在无干扰环境下运行）
npm --prefix apps/desktop run test:electron
npm --prefix apps/desktop run test:startup
```

## 打包发布

electron-builder 不支持跨平台出包，请在目标系统上运行对应脚本：

```bash
# macOS / Linux（产出 apps/desktop/release/*.dmg|AppImage 等）
./scripts/package.sh

# Windows（产出 NSIS 安装包 + portable exe）
powershell -ExecutionPolicy Bypass -File scripts/package.ps1
```

脚本流程：依赖检查 → 后端测试 → PyInstaller 打包后端 → 产物冒烟检查 → electron-builder。
若访问 GitHub 缓慢，先设置镜像：`export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。

也可以交给 CI：推送 `v*` 标签或手动触发 GitHub Actions 的 **Build Desktop** 工作流
（[.github/workflows/build-desktop.yml](.github/workflows/build-desktop.yml)），
自动构建 macOS / Windows 安装包，打标签时并发布到 GitHub Release。

## 文档

- [需求文档](docs/需求文档.md)
- [架构文档](docs/架构文档.md)

## License

MIT
