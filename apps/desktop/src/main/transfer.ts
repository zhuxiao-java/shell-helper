import { createReadStream, createWriteStream, promises as fs } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import http from 'node:http'
import path from 'node:path'
import type { BrowserWindow } from 'electron'
import type { BackendInfo } from './backend'

export interface TransferProgress { id: string; loaded: number; total: number }

const jobs = new Map<string, { destroy: () => void }>()

function endpoint(info: BackendInfo): { hostname: string; port: number } {
  return { hostname: info.host || '127.0.0.1', port: info.port }
}

function safeName(name: string): string {
  const base = path.basename(name.replace(/\\/g, '/'))
  if (!base || base === '.' || base === '..' || /[\x00-\x1f]/.test(base)) throw new Error('无效的文件名')
  return base
}

function safeRelative(relative: string): string {
  const parts = relative.split(/[\\/]/).filter(Boolean)
  if (!parts.length || parts.some(part => part === '..' || part === '.' || /[\x00-\x1f]/.test(part))) {
    throw new Error('无效的相对路径')
  }
  return parts.join(path.sep)
}

function readFailure(response: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    response.on('data', (chunk) => chunks.push(chunk as Buffer))
    response.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      try {
        const detail = JSON.parse(text).detail
        resolve(typeof detail === 'string' && detail ? detail : text || '传输失败')
      } catch {
        resolve(text || '传输失败')
      }
    })
    response.on('error', reject)
  })
}

export function cancelTransfer(id: string): void {
  jobs.get(id)?.destroy()
  jobs.delete(id)
}

export function downloadTo(
  window: BrowserWindow,
  info: BackendInfo,
  input: { id: string; sessionId: string; remotePath: string; destPath: string }
): Promise<void> {
  if (!path.isAbsolute(input.destPath)) return Promise.reject(new Error('请选择保存位置'))
  const query = new URLSearchParams({ session_id: input.sessionId, path: input.remotePath })
  return fs.mkdir(path.dirname(input.destPath), { recursive: true }).then(() => new Promise<void>((resolve, reject) => {
    const req = http.request({
      ...endpoint(info),
      path: `/api/files/download?${query}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${info.token}` }
    }, (response) => {
      if ((response.statusCode ?? 500) >= 400) {
        void readFailure(response).then(message => reject(new Error(message))).catch(reject)
        return
      }
      const total = Number(response.headers['content-length'] || 0)
      let loaded = 0
      const file = createWriteStream(input.destPath)
      response.on('data', (chunk: Buffer) => {
        loaded += chunk.length
        window.webContents.send('transfer:progress', { id: input.id, loaded, total } satisfies TransferProgress)
      })
      response.pipe(file)
      file.on('finish', () => file.close(() => resolve()))
      file.on('error', reject)
      response.on('error', reject)
    })
    req.on('error', reject)
    jobs.set(input.id, { destroy: () => { req.destroy(new Error('已取消')) } })
    req.end()
  })).finally(() => jobs.delete(input.id))
}

export function uploadFrom(
  window: BrowserWindow,
  info: BackendInfo,
  input: { id: string; sessionId: string; directory: string; localPath: string; name: string; overwrite: boolean }
): Promise<void> {
  if (!path.isAbsolute(input.localPath)) return Promise.reject(new Error('请选择本地文件'))
  const name = safeName(input.name)
  return fs.stat(input.localPath).then(stat => new Promise<void>((resolve, reject) => {
    if (!stat.isFile()) {
      reject(new Error('只能上传普通文件'))
      return
    }
    const query = new URLSearchParams({
      session_id: input.sessionId,
      directory: input.directory || '/',
      name,
      overwrite: input.overwrite ? 'true' : 'false'
    })
    const req = http.request({
      ...endpoint(info),
      path: `/api/files/upload?${query}`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${info.token}`,
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size
      }
    }, (response) => {
      void readFailure(response).then(message => {
        if ((response.statusCode ?? 500) >= 400) reject(new Error(message || '上传失败'))
        else resolve()
      }).catch(reject)
    })
    let loaded = 0
    const source = createReadStream(input.localPath)
    source.on('data', (chunk) => {
      loaded += chunk.length
      window.webContents.send('transfer:progress', { id: input.id, loaded, total: stat.size } satisfies TransferProgress)
    })
    source.on('error', reject)
    req.on('error', reject)
    jobs.set(input.id, { destroy: () => { source.destroy(); req.destroy(new Error('已取消')) } })
    source.pipe(req)
  })).finally(() => jobs.delete(input.id))
}

export async function listLocalFiles(root: string): Promise<{ path: string; relative: string; size: number }[]> {
  if (!path.isAbsolute(root)) throw new Error('请选择本地目录')
  const found: { path: string; relative: string; size: number }[] = []
  async function walk(directory: string, prefix: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(directory, entry.name)
      const relative = prefix ? path.join(prefix, entry.name) : entry.name
      if (entry.isDirectory()) await walk(full, relative)
      else if (entry.isFile()) {
        if (found.length >= 2000) throw new Error('目录中的文件超过 2000 个')
        const stat = await fs.stat(full)
        found.push({ path: full, relative: safeRelative(relative), size: stat.size })
      }
    }
  }
  await walk(root, '')
  return found
}
