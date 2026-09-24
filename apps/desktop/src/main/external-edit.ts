import { promises as fs, watch, constants, type FSWatcher } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { atomicJson } from './settings'
import { MAX_FILE_BYTES, type EditItem, type OpenFileRequest } from '../shared/external'
import type { Settings } from '../shared/settings'

export class RemoteError extends Error {
  constructor(public status: number, message: string) { super(message) }
}
export interface EditDependencies {
  request(route: string, init?: RequestInit): Promise<Response>
  editor(): Settings['editor']
  launch(file: string, editor: Settings['editor']): Promise<void>
  changed(items: EditItem[]): void
}
interface Draft extends EditItem { version: 1; fileName: string; baseHash: string }
const hash = (data: Buffer): string => createHash('sha256').update(data).digest('hex')
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

export async function responseBytes(response: Response): Promise<Buffer> {
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { detail?: string }
    throw new RemoteError(response.status, data.detail || `文件请求失败 (${response.status})`)
  }
  const reader = response.body?.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_FILE_BYTES) throw new Error('文件超过 10 MiB 上限')
        chunks.push(value)
      }
    } finally { await reader.cancel().catch(() => undefined) }
  }
  return Buffer.concat(chunks)
}

export class ExternalEditService {
  private drafts = new Map<string, Draft>()
  private watchers = new Map<string, FSWatcher>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private scans = new Map<string, Promise<void>>()
  private busy = new Set<string>()
  private detached = new Set<string>()
  private openQueue: Promise<unknown> = Promise.resolve()
  private writes: Promise<unknown> = Promise.resolve()
  private poll?: ReturnType<typeof setInterval>
  private stopped = false
  constructor(private readonly root: string, private readonly deps: EditDependencies) {}

  list(): EditItem[] {
    return [...this.drafts.values()].map(({ version: _v, fileName: _f, baseHash: _b, ...item }) => ({ ...item }))
  }
  private file(d: Draft): string { return path.join(this.root, d.id, d.fileName) }
  private notify(): void { this.deps.changed(this.list()) }
  private async persist(d: Draft): Promise<void> {
    const snapshot = { ...d, sessionId: null }
    const task = this.writes.then(() => atomicJson(path.join(this.root, d.id, 'draft.json'), snapshot))
    this.writes = task.catch(() => undefined)
    await task
  }
  private get(id: string): Draft {
    const d = this.drafts.get(id)
    if (!d) throw new Error('草稿不存在')
    return d
  }
  async initialize(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 })
    for (const entry of await fs.readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue
      try {
        const manifest = path.join(this.root, entry.name, 'draft.json')
        if ((await fs.lstat(manifest)).size > 16384) continue
        const d = JSON.parse(await fs.readFile(manifest, 'utf8')) as Draft
        if (d.version !== 1 || d.id !== entry.name || !/^document(?:\.[a-zA-Z0-9_-]{1,20})?$/.test(d.fileName) ||
            !/^[a-f0-9]{64}$/.test(d.baseHash) || typeof d.hostId !== 'string' || typeof d.remotePath !== 'string') continue
        d.sessionId = null
        d.status = 'disconnected'
        d.message = '已恢复本地草稿；重新打开同一远程文件后才能确认回传'
        this.drafts.set(d.id, d)
        await this.scan(d)
        this.observe(d)
      } catch { /* 损坏的草稿目录原样保留，不自动删除。 */ }
    }
    this.poll = setInterval(() => {
      for (const d of this.drafts.values()) void this.scan(d)
    }, 2000)
    this.poll.unref()
  }
  private observe(d: Draft): void {
    const watcher = watch(path.dirname(this.file(d)), (_event, name) => {
      if (name && name.toString() !== d.fileName) return
      clearTimeout(this.timers.get(d.id))
      this.timers.set(d.id, setTimeout(() => { void this.scan(d) }, 500))
    })
    watcher.on('error', error => { d.message = `文件监听失败：${error.message}；仍会定期检查`; this.notify() })
    this.watchers.set(d.id, watcher)
  }
  private async read(d: Draft): Promise<Buffer> {
    const file = this.file(d)
    const info = await fs.lstat(file)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('本地副本必须为普通文件')
    if (info.size > MAX_FILE_BYTES) throw new Error('本地文件超过 10 MiB 上限，草稿仍保留')
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    try {
      const data = Buffer.alloc(MAX_FILE_BYTES + 1)
      let length = 0
      while (length < data.length) {
        const result = await handle.read(data, length, data.length - length, null)
        if (!result.bytesRead) break
        length += result.bytesRead
      }
      if (length > MAX_FILE_BYTES) throw new Error('本地文件超过 10 MiB 上限')
      return data.subarray(0, length)
    } finally { await handle.close() }
  }
  private async stable(d: Draft): Promise<Buffer> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const first = await this.read(d)
      await delay(180)
      const second = await this.read(d)
      if (hash(first) === hash(second)) return second
    }
    throw new Error('编辑器仍在保存，请稍后重试')
  }
  private scan(d: Draft): Promise<void> {
    const running = this.scans.get(d.id)
    if (running) return running
    const task = (async () => {
      try {
        const data = await this.stable(d)
        const next = hash(data)
        if (d.hash === next && d.status !== 'error') return
        d.hash = next
        d.dirty = next !== d.baseHash
        if (!this.busy.has(d.id) && d.status !== 'conflict') d.status = d.sessionId ? (d.dirty ? 'pending' : 'synced') : 'disconnected'
        await this.persist(d)
        this.notify()
      } catch (error) {
        if (d.message === (error as Error).message) return
        d.dirty = true
        d.status = 'error'
        d.message = (error as Error).message
        this.notify()
      }
    })().finally(() => this.scans.delete(d.id))
    this.scans.set(d.id, task)
    return task
  }
  open(input: OpenFileRequest): Promise<EditItem[]> {
    const task = this.openQueue.then(() => this.openOne(input))
    this.openQueue = task.catch(() => undefined)
    return task
  }
  private async openOne(input: OpenFileRequest): Promise<EditItem[]> {
    if (this.stopped) throw new Error('应用正在退出')
    if (!input || typeof input.sessionId !== 'string' || !/^[a-f0-9]{32}$/.test(input.sessionId) ||
        typeof input.path !== 'string' || !input.path.startsWith('/') || input.path.length > 4096 || /[\x00-\x1f\x7f]/.test(input.path)) throw new Error('无效的文件请求')
    if (this.detached.has(input.sessionId)) throw new Error('文件会话已关闭')
    const session = JSON.parse((await responseBytes(await this.deps.request(`/api/sessions/${input.sessionId}`))).toString()) as { host_id: string; type: string }
    if (!['sftp', 'ftp'].includes(session.type)) throw new Error('只能使用文件会话打开文本')
    const remotePath = path.posix.normalize(input.path)
    let d = [...this.drafts.values()].find(item => item.hostId === session.host_id && item.remotePath === remotePath)
    if (d) {
      if (this.busy.has(d.id)) throw new Error('文件正在回传，请稍后再打开')
      d.sessionId = input.sessionId
      await this.scan(d)
      d.status = d.dirty ? 'pending' : 'synced'
      d.message = ''
    } else {
      const response = await this.deps.request(`/api/files/content?${new URLSearchParams({ session_id: input.sessionId, path: remotePath })}`)
      const bytes = await responseBytes(response)
      const baseHash = response.headers.get('X-Content-SHA256')
      if (baseHash !== hash(bytes)) throw new Error('下载文件摘要校验失败')
      const editor = this.deps.editor()
      const ext = path.posix.extname(remotePath)
      const fileName = editor.mode === 'default' ? 'document.txt' : `document${/^\.[a-zA-Z0-9_-]{1,20}$/.test(ext) ? ext : ''}`
      d = { version: 1, id: randomUUID(), hostId: session.host_id, hostName: String(input.hostName || session.host_id).slice(0, 200),
        remotePath, sessionId: input.sessionId, fileName, baseHash, hash: baseHash, dirty: false, status: 'synced', message: '' }
      await fs.mkdir(path.dirname(this.file(d)), { mode: 0o700 })
      await fs.writeFile(this.file(d), bytes, { mode: 0o600, flag: 'wx' })
      await this.persist(d)
      this.drafts.set(d.id, d)
      this.observe(d)
    }
    if (this.detached.has(input.sessionId)) {
      d.sessionId = null
      d.status = 'disconnected'
      d.message = '下载期间会话已关闭，本地副本仍保留'
    }
    await this.persist(d)
    await this.reopen(d.id)
    return this.list()
  }
  async reopen(id: string, useDefault = false): Promise<void> {
    const d = this.get(id)
    try {
      await this.scan(d)
      await this.stable(d)
      const editor = useDefault ? { mode: 'default' as const, path: '' } : this.deps.editor()
      const ext = path.posix.extname(d.remotePath)
      const desired = editor.mode === 'default' ? 'document.txt' : `document${/^\.[a-zA-Z0-9_-]{1,20}$/.test(ext) ? ext : ''}`
      let renamed = false
      if (d.fileName !== desired) {
        const previous = this.file(d)
        const next = path.join(path.dirname(previous), desired)
        await fs.rename(previous, next)
        d.fileName = desired
        renamed = true
        await this.persist(d)
      }
      await this.deps.launch(this.file(d), editor)
      d.message = renamed ? '副本扩展名已切换，请关闭旧编辑器窗口，继续在当前窗口编辑' : ''
    } catch (error) {
      d.message = `打开失败：${(error as Error).message}；可在外部编辑列表改用默认应用`
      throw error
    } finally { this.notify() }
  }
  async upload(id: string, confirmedHash: string): Promise<void> {
    const d = this.get(id)
    if (!d.sessionId || this.stopped) throw new Error('连接已断开，请先重新打开远程文件')
    if (this.busy.has(id)) throw new Error('文件正在回传')
    const sessionId = d.sessionId
    this.busy.add(id)
    try {
      const snapshot = await this.stable(d)
      if (hash(snapshot) !== confirmedHash) throw new Error('确认期间内容再次改变，请确认最新版本')
      if (d.sessionId !== sessionId) throw new Error('连接已关闭，已取消回传')
      d.status = 'uploading'
      this.notify()
      const response = await this.deps.request(`/api/files/content?${new URLSearchParams({ session_id: sessionId, path: d.remotePath })}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Expected-SHA256': d.baseHash }, body: new Uint8Array(snapshot)
      })
      const result = JSON.parse((await responseBytes(response)).toString()) as { sha256: string }
      if (result.sha256 !== hash(snapshot)) throw new Error('回传结果摘要不一致，请保留草稿')
      d.baseHash = result.sha256
      d.hash = hash(await this.stable(d))
      d.dirty = d.hash !== d.baseHash
      d.status = d.sessionId ? (d.dirty ? 'pending' : 'synced') : 'disconnected'
      d.message = ''
      await this.persist(d)
    } catch (error) {
      if (error instanceof RemoteError && error.status === 410) d.sessionId = null
      d.status = error instanceof RemoteError && error.status === 409 ? 'conflict' : d.sessionId ? 'error' : 'disconnected'
      d.message = (error as Error).message
      await this.persist(d)
      throw error
    } finally {
      this.busy.delete(id)
      this.notify()
    }
  }
  async detach(sessionId: string): Promise<void> {
    if (typeof sessionId !== 'string' || !/^[a-f0-9]{32}$/.test(sessionId)) throw new Error('无效的文件会话')
    this.detached.add(sessionId)
    for (const d of this.drafts.values()) {
      if (d.sessionId !== sessionId) continue
      d.sessionId = null
      d.status = 'disconnected'
      d.message = '会话已关闭，本地草稿仍保留'
      await this.persist(d)
    }
    this.notify()
  }
  async refresh(): Promise<EditItem[]> {
    await Promise.all([...this.drafts.values()].map(d => this.scan(d)))
    return this.list()
  }
  async hasPending(): Promise<boolean> {
    await this.openQueue
    await this.refresh()
    return this.busy.size > 0 || [...this.drafts.values()].some(d => d.dirty)
  }
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    while (this.busy.size) await delay(100)
    clearInterval(this.poll)
    for (const watcher of this.watchers.values()) watcher.close()
    for (const timer of this.timers.values()) clearTimeout(timer)
    await Promise.all(this.scans.values())
    for (const d of this.drafts.values()) await this.persist(d)
  }
}
