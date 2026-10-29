import { createReadStream, createWriteStream, promises as fs } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import http from 'node:http'
import path from 'node:path'
import { Notification, shell, type BrowserWindow } from 'electron'
import type { BackendInfo } from './backend'

export interface TransferProgress { id: string; loaded: number; total: number }

const jobs = new Map<string, { destroy: () => void }>()
const activeNotifications = new Set<Notification>()
/** 只有真正的“大文件”才发系统通知，避免每一个小文件都打扰用户 */
const LARGE_DOWNLOAD_BYTES = 100 * 1024 * 1024

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function notifyLargeDownload(destPath: string, bytes: number): void {
  if (bytes < LARGE_DOWNLOAD_BYTES || !Notification.isSupported()) return
  const fileName = path.basename(destPath)
  const notification = new Notification({
    title: '大文件下载完成',
    body: `${fileName} · ${formatBytes(bytes)}\n已保存到 ${path.dirname(destPath)}`
  })
  activeNotifications.add(notification)
  notification.on('click', () => { shell.showItemInFolder(destPath) })
  notification.on('close', () => { activeNotifications.delete(notification) })
  notification.show()
}

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
  input: { id: string; sessionId: string; remotePath: string; destPath: string; resume?: boolean }
): Promise<void> {
  if (!path.isAbsolute(input.destPath)) return Promise.reject(new Error('请选择保存位置'))
  const query = new URLSearchParams({ session_id: input.sessionId, path: input.remotePath })
  return fs.mkdir(path.dirname(input.destPath), { recursive: true }).then(async () => {
    let start = 0
    if (input.resume) {
      try { start = (await fs.stat(input.destPath)).size } catch { start = 0 }
    }
    return new Promise<void>((resolve, reject) => {
    const headers: Record<string, string | number> = { Authorization: `Bearer ${info.token}` }
    if (start > 0) headers.Range = `bytes=${start}-`
    const req = http.request({
      ...endpoint(info),
      path: `/api/files/download?${query}`,
      method: 'GET',
      headers
    }, (response) => {
      if ((response.statusCode ?? 500) >= 400) {
        void readFailure(response).then(message => reject(new Error(message))).catch(reject)
        return
      }
      const resuming = start > 0 && response.statusCode === 206
      if (start > 0 && !resuming) start = 0
      const total = resuming ? start + Number(response.headers['content-length'] || 0) : Number(response.headers['content-length'] || 0)
      let loaded = start
      const file = createWriteStream(input.destPath, { flags: resuming ? 'a' : 'w' })
      if (start > 0) window.webContents.send('transfer:progress', { id: input.id, loaded, total } satisfies TransferProgress)
      response.on('data', (chunk: Buffer) => {
        loaded += chunk.length
        window.webContents.send('transfer:progress', { id: input.id, loaded, total } satisfies TransferProgress)
      })
      response.pipe(file)
      file.on('finish', () => file.close(() => {
        notifyLargeDownload(input.destPath, loaded)
        resolve()
      }))
      file.on('error', reject)
      response.on('error', reject)
    })
    req.on('error', reject)
    jobs.set(input.id, { destroy: () => { req.destroy(new Error('已取消')) } })
    req.end()
    })
  }).finally(() => jobs.delete(input.id))
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


export interface LocalDirEntry {
  name: string
  path: string
  is_dir: boolean
  size: number
  mtime: number
}

export async function listLocalDirectory(directory: string): Promise<LocalDirEntry[]> {
  if (!path.isAbsolute(directory)) throw new Error('请选择本地目录')
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const result: LocalDirEntry[] = []
  for (const entry of entries) {
    const full = path.join(directory, entry.name)
    try {
      const stat = await fs.stat(full)
      result.push({ name: entry.name, path: full, is_dir: entry.isDirectory(), size: stat.size, mtime: stat.mtimeMs / 1000 })
    } catch { /* 跳过无权限/已删除的条目 */ }
  }
  return result.sort((a, b) => Number(b.is_dir) - Number(a.is_dir) || a.name.localeCompare(b.name, undefined, { numeric: true }))
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
