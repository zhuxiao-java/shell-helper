import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

export interface BackendInfo {
  port: number
  token: string
  host: string
  dataDir?: string
  databasePath?: string | null
}

/**
 * 负责启动/守护/关闭 Python 后端。
 * - 开发态: 使用仓库内的虚拟环境解释器运行 `python -m app.main`
 * - 生产态: 运行随包分发的 PyInstaller 可执行文件
 */
export class BackendManager {
  private proc: ChildProcessByStdio<null, Readable, Readable> | null = null
  private starting: Promise<BackendInfo> | null = null
  private info: BackendInfo | null = null
  private readonly token = randomBytes(24).toString('base64url')

  get isRunning(): boolean {
    return this.info !== null
  }

  get backendInfo(): BackendInfo | null {
    return this.info
  }

  private resolveCommand(): { command: string; args: string[]; cwd: string } {
    if (app.isPackaged) {
      const exeName = process.platform === 'win32' ? 'shell-helper-backend.exe' : 'shell-helper-backend'
      const exe = path.join(process.resourcesPath, 'backend', exeName)
      return { command: exe, args: ['--port', '0', '--token', this.token], cwd: path.dirname(exe) }
    }
    // 开发态: backend 目录相对本文件位于 monorepo 根
    const backendDir = path.resolve(app.getAppPath(), '../../backend')
    const venvPython = path.join(
      backendDir,
      '../.venv',
      process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
    )
    const python = existsSync(venvPython) ? venvPython : process.env.PYTHON || 'python3'
    return {
      command: python,
      args: ['-m', 'app.main', '--port', '0', '--token', this.token],
      cwd: backendDir
    }
  }

  start(): Promise<BackendInfo> {
    if (this.info) return Promise.resolve(this.info)
    if (!this.starting) this.starting = this.launch().finally(() => { this.starting = null })
    return this.starting
  }

  private launch(): Promise<BackendInfo> {
    const { command, args, cwd } = this.resolveCommand()

    return new Promise<BackendInfo>((resolve, reject) => {
      let buffer = ''
      let settled = false

      try {
        this.proc = spawn(command, args, {
          cwd,
          env: { ...process.env, PYTHONUNBUFFERED: '1' },
          stdio: ['ignore', 'pipe', 'pipe']
        })
      } catch (err) {
        reject(err)
        return
      }

      const timer = setTimeout(() => {
        if (!settled) reject(new Error('后端启动超时,未能读取握手信息'))
      }, 20000)

      this.proc.stdout.setEncoding('utf8')
      this.proc.stdout.on('data', (chunk: string) => {
        buffer += chunk
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('HANDSHAKE ')) continue
          const payload = JSON.parse(line.slice('HANDSHAKE '.length))
          this.info = {
            port: payload.port, token: this.token, host: payload.host || '127.0.0.1',
            dataDir: payload.data_dir, databasePath: payload.database_path
          }
          settled = true
          clearTimeout(timer)
          resolve(this.info)
        }
      })

      this.proc.stderr.setEncoding('utf8')
      this.proc.stderr.on('data', (chunk: string) => {
        // 后端日志转发到主进程控制台
        process.stderr.write(`[backend] ${chunk}`)
      })

      this.proc.on('exit', (code) => {
        clearTimeout(timer)
        this.info = null
        this.proc = null
        if (!settled) {
          settled = true
          reject(new Error(`后端异常退出 (code=${code})`))
        } else {
          console.log(`后端进程已退出: ${code}`)
        }
      })

      this.proc.on('error', (err) => {
        clearTimeout(timer)
        if (!settled) {
          settled = true
          reject(err)
        }
      })
    })
  }

  async stop(): Promise<void> {
    if (!this.proc) return
    const proc = this.proc
    const info = this.info
    if (info) {
      try {
        await fetch(`http://${info.host}:${info.port}/shutdown`, {
          method: 'POST', headers: { Authorization: `Bearer ${info.token}` },
          signal: AbortSignal.timeout(2000)
        })
      } catch { /* 后端无响应时继续通过进程信号退出。 */ }
    }
    try {
      // 先尝试优雅关闭
      // (Electron 侧无 HTTP 客户端依赖,直接发信号)
      if (process.platform === 'win32') {
        proc.kill()
      } else {
        proc.kill('SIGTERM')
      }
    } catch {
      proc.kill('SIGKILL')
    }
    await new Promise<void>((res) => {
      const t = setTimeout(() => {
        try {
          proc.kill('SIGKILL')
        } catch {
          /* noop */
        }
        res()
      }, 3000)
      proc.once('exit', () => {
        clearTimeout(t)
        res()
      })
    })
    this.proc = null
    this.info = null
  }
}

export const backendManager = new BackendManager()
