import { randomUUID } from 'node:crypto'
import dgram from 'node:dgram'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { LanAssistEvent, LanEvent, LanFileAction, LanFileNotice, LanPeer, LanProfile, LanShareResult, LanState, SharedHost, SharedTerminal, TerminalShareInput } from '../shared/lan'

const LAN_GROUP = '239.255.42.99'
const LAN_PORT = 47823
const MAX_PACKET = 4096
const ANNOUNCE_MS = 3000
const EXPIRE_MS = 10000
const MAX_PEERS = 64
const MAX_EVENTS = 80
const VERSION = 1

interface StoredProfile {
  id?: string
  name?: string
  enabled?: boolean
  avatar?: string
}

interface WireFrom {
  id: string
  name: string
  device: string
}

interface WireMessage {
  v?: number
  type?: string
  mid?: string
  id?: string
  name?: string
  device?: string
  avatar?: string
  to?: string
  from?: WireFrom
  host?: unknown
  hostName?: string
  path?: string
  action?: string
  at?: number
  share?: unknown
  shareId?: string
  data?: string
  part?: number
  total?: number
}

function clean(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, max)
}

function sanitizeAvatar(value: unknown): string {
  if (typeof value !== 'string' || value.length > 3200) return ''
  if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value)) return ''
  return value
}

function validProtocol(value: unknown): value is SharedHost['protocol'] {
  return typeof value === 'string' && ['ssh', 'sftp', 'ftp', 'telnet'].includes(value)
}

function validAction(value: unknown): value is LanFileAction {
  return value === 'created' || value === 'modified' || value === 'renamed' || value === 'deleted'
}

function sanitizeHost(value: unknown): SharedHost | null {
  if (!value || typeof value !== 'object') return null
  const host = value as Record<string, unknown>
  if (!validProtocol(host.protocol)) return null
  const port = Number(host.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  const address = clean(host.host, 255)
  const name = clean(host.name, 100)
  if (!address || !name) return null
  return {
    name,
    protocol: host.protocol,
    host: address,
    port,
    username: clean(host.username, 100),
    group: clean(host.group, 80),
    tags: clean(host.tags, 200),
    remoteCwd: clean(host.remoteCwd, 500)
  }
}

export class LanService {
  private profile: LanProfile & { enabled: boolean }
  private peers = new Map<string, LanPeer>()
  private events: LanEvent[] = []
  private terminals = new Map<string, SharedTerminal>()
  private terminalListeners = new Set<(payload: { id: string; data: string }) => void>()
  private assistListeners = new Set<(event: LanAssistEvent) => void>()
  private assistParts = new Map<string, { parts: string[]; total: number; at: number; peer: LanPeer }>()
  private socket: dgram.Socket | null = null
  private announceTimer: NodeJS.Timeout | null = null
  private sweepTimer: NodeJS.Timeout | null = null
  private listeners = new Set<(state: LanState) => void>()
  private seen = new Map<string, number>()
  private error = ''
  private readonly profilePath: string

  constructor(private readonly userData: string) {
    this.profilePath = path.join(userData, 'lan-profile.json')
    this.profile = this.loadProfile()
  }

  private loadProfile(): LanProfile & { enabled: boolean } {
    let stored: StoredProfile = {}
    try { stored = JSON.parse(fs.readFileSync(this.profilePath, 'utf8')) as StoredProfile } catch { /* 首次运行 */ }
    const id = typeof stored.id === 'string' && /^[\w-]{8,80}$/.test(stored.id) ? stored.id : randomUUID()
    let username = 'Shell Helper 用户'
    try { username = os.userInfo().username || username } catch { /* 无用户信息 */ }
    return {
      id,
      name: clean(stored.name, 40) || username,
      device: clean(os.hostname(), 80) || '本机',
      enabled: stored.enabled !== false,
      avatar: sanitizeAvatar(stored.avatar)
    }
  }

  private saveProfile(): void {
    try {
      fs.mkdirSync(this.userData, { recursive: true })
      fs.writeFileSync(this.profilePath, JSON.stringify({ id: this.profile.id, name: this.profile.name, enabled: this.profile.enabled, avatar: this.profile.avatar || '' }, null, 2), { mode: 0o600 })
    } catch { /* 配置目录不可写时仍允许本次运行 */ }
  }

  init(): void {
    if (this.profile.enabled) this.start()
  }

  subscribe(listener: (state: LanState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  state(): LanState {
    return {
      enabled: this.profile.enabled,
      profile: { id: this.profile.id, name: this.profile.name, device: this.profile.device, avatar: this.profile.avatar || '' },
      peers: [...this.peers.values()].sort((a, b) => a.name.localeCompare(b.name)),
      events: this.events.slice(0, MAX_EVENTS),
      terminals: [...this.terminals.values()].sort((a, b) => Number(b.self) - Number(a.self) || a.startedAt - b.startedAt),
      error: this.error || undefined
    }
  }

  private emit(): void {
    const state = this.state()
    for (const listener of this.listeners) {
      try { listener(state) } catch { /* 忽略监听器异常 */ }
    }
  }

  setEnabled(enabled: boolean): LanState {
    this.profile.enabled = enabled
    this.saveProfile()
    if (enabled) this.start()
    else this.stop()
    this.emit()
    return this.state()
  }

  setName(name: string): LanState {
    const next = clean(name, 40)
    if (!next) return this.state()
    this.profile.name = next
    this.saveProfile()
    this.sendAnnounce('announce')
    this.emit()
    return this.state()
  }

  setAvatar(value: unknown): LanState {
    const avatar = sanitizeAvatar(value)
    if (value && !avatar) throw new Error('头像格式无效或超过大小限制')
    this.profile.avatar = avatar
    this.saveProfile()
    this.sendAnnounce('announce')
    this.emit()
    return this.state()
  }

  markRead(): LanState {
    let changed = false
    for (const event of this.events) {
      if (!event.read) { event.read = true; changed = true }
    }
    if (changed) this.emit()
    return this.state()
  }

  shareHost(targetId: string, host: unknown): LanShareResult {
    if (!this.profile.enabled) return { ok: false, error: '请先启用局域网发现' }
    if (!this.socket) return { ok: false, error: '局域网服务尚未就绪' }
    const peer = this.peers.get(clean(targetId, 80))
    if (!peer) return { ok: false, error: '对方已离线' }
    const shared = sanitizeHost(host)
    if (!shared) return { ok: false, error: '连接配置无效' }
    this.send({
      v: VERSION,
      type: 'share',
      mid: randomUUID(),
      from: this.selfInfo(),
      to: peer.id,
      host: shared,
      at: Date.now()
    })
    return { ok: true }
  }

  notifyFile(input: LanFileNotice): void {
    if (!this.profile.enabled || !this.socket) return
    const hostName = clean(input?.hostName, 80)
    const remotePath = clean(input?.path, 500)
    if (!hostName || !remotePath || !validAction(input?.action)) return
    this.send({
      v: VERSION,
      type: 'file',
      mid: randomUUID(),
      from: this.selfInfo(),
      to: '*',
      hostName,
      path: remotePath,
      action: input.action,
      at: Date.now()
    })
  }

  subscribeAssist(listener: (event: LanAssistEvent) => void): () => void {
    this.assistListeners.add(listener)
    return () => this.assistListeners.delete(listener)
  }

  sendAssist(targetId: string, payload: Record<string, unknown>): { ok: boolean; error?: string } {
    if (!this.profile.enabled) return { ok: false, error: '请先启用局域网发现' }
    const peer = this.peers.get(clean(targetId, 80))
    if (!peer) return { ok: false, error: '对方已离线' }
    const raw = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
    const mid = randomUUID()
    const total = Math.ceil(raw.length / 700)
    for (let part = 0; part < total; part++) {
      this.send({
        v: VERSION, type: 'assist', mid, id: this.profile.id, from: this.selfInfo(), to: peer.id,
        part, total, data: raw.slice(part * 700, part * 700 + 700), at: Date.now()
      }, peer.address)
    }
    return { ok: true }
  }

  subscribeTerminal(listener: (payload: { id: string; data: string }) => void): () => void {
    this.terminalListeners.add(listener)
    return () => this.terminalListeners.delete(listener)
  }

  startTerminalShare(input: TerminalShareInput): string {
    if (!this.profile.enabled) throw new Error('请先启用局域网发现')
    if (!this.socket) throw new Error('局域网服务尚未就绪')
    const share: SharedTerminal = {
      id: randomUUID(), ownerId: this.profile.id, ownerName: this.profile.name,
      ownerDevice: this.profile.device, title: clean(input.title, 100) || '终端会话',
      hostName: clean(input.hostName, 100), joined: true, self: true, startedAt: Date.now()
    }
    this.terminals.set(share.id, share)
    this.send({ v: VERSION, type: 'terminal-offer', id: this.profile.id, from: this.selfInfo(), share: { id: share.id, title: share.title, hostName: share.hostName, startedAt: share.startedAt }, at: Date.now() })
    this.emit()
    return share.id
  }

  stopTerminalShare(id: string): void {
    const share = this.terminals.get(id)
    if (!share?.self) return
    this.terminals.delete(id)
    this.send({ v: VERSION, type: 'terminal-stop', id: this.profile.id, shareId: id, at: Date.now() })
    this.emit()
  }

  joinTerminal(id: string): void {
    const share = this.terminals.get(id)
    if (!share || share.self) return
    share.joined = true
    this.emit()
  }

  leaveTerminal(id: string): void {
    const share = this.terminals.get(id)
    if (!share) return
    if (share.self) this.stopTerminalShare(id)
    else { share.joined = false; this.emit() }
  }

  sendTerminalOutput(id: string, data: string): void {
    const share = this.terminals.get(id)
    if (!share?.self || !data) return
    const encoded = Buffer.from(data, 'utf8').toString('base64')
    for (let offset = 0; offset < encoded.length; offset += 700) {
      this.send({
        v: VERSION, type: 'terminal-output', id: this.profile.id, shareId: id,
        data: encoded.slice(offset, offset + 700), at: Date.now()
      })
    }
  }

  private closeAllTerminalShares(): void {
    for (const share of this.terminals.values()) {
      if (share.self) this.send({ v: VERSION, type: 'terminal-stop', id: this.profile.id, shareId: share.id, at: Date.now() })
    }
    this.terminals.clear()
    this.emit()
  }

  stop(): void {
    if (this.announceTimer) clearInterval(this.announceTimer)
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.announceTimer = null
    this.sweepTimer = null
    this.closeAllTerminalShares()
    const socket = this.socket
    this.socket = null
    if (socket) {
      try {
        const bye = Buffer.from(JSON.stringify({ v: VERSION, type: 'bye', id: this.profile.id, at: Date.now() }))
        socket.send(bye, LAN_PORT, LAN_GROUP)
      } catch { /* 已在关闭流程 */ }
      try { socket.close() } catch { /* 已关闭 */ }
    }
    this.peers.clear()
    this.emit()
  }

  private selfInfo(): WireFrom {
    return { id: this.profile.id, name: this.profile.name, device: this.profile.device }
  }

  private start(): void {
    if (this.socket) return
    this.error = ''
    this.peers.clear()
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    this.socket = socket
    socket.on('error', (error) => {
      this.error = `局域网发现启动失败：${error.message}`
      this.emit()
    })
    socket.on('message', (message, rinfo) => this.receive(message, rinfo.address))
    socket.bind(LAN_PORT, () => {
      try {
        socket.addMembership(LAN_GROUP)
        socket.setMulticastTTL(1)
        socket.setMulticastLoopback(true)
      } catch (error) {
        this.error = `无法加入局域网发现组：${(error as Error).message}`
        this.emit()
      }
      this.sendAnnounce('announce')
      this.announceTimer = setInterval(() => this.sendAnnounce('announce'), ANNOUNCE_MS)
      this.sweepTimer = setInterval(() => this.sweepPeers(), 2000)
      this.emit()
    })
  }

  private sendAnnounce(type: 'announce' | 'bye'): void {
    if (type === 'bye') {
      this.send({ v: VERSION, type: 'bye', id: this.profile.id, at: Date.now() })
      return
    }
    this.send({ v: VERSION, type, id: this.profile.id, name: this.profile.name, device: this.profile.device, avatar: this.profile.avatar, at: Date.now() })
  }

  private send(payload: WireMessage, address = LAN_GROUP): void {
    const socket = this.socket
    if (!socket) return
    try {
      const data = Buffer.from(JSON.stringify(payload))
      if (data.length > MAX_PACKET) return
      socket.send(data, LAN_PORT, address, () => { /* UDP 丢包可忽略 */ })
    } catch { /* 网络接口切换期间的临时错误 */ }
  }

  private receive(message: Buffer, address: string): void {
    if (!message.length || message.length > MAX_PACKET) return
    let msg: WireMessage
    try { msg = JSON.parse(message.toString('utf8')) as WireMessage } catch { return }
    if (!msg || msg.v !== VERSION || typeof msg.type !== 'string') return
    if (msg.id === this.profile.id || msg.from?.id === this.profile.id) return

    if (msg.type === 'announce') {
      const id = clean(msg.id, 80)
      const name = clean(msg.name, 40)
      const device = clean(msg.device, 80)
      if (!id || id === this.profile.id || !name) return
      const previous = this.peers.get(id)
      if (!previous && this.peers.size >= MAX_PEERS) return
      const next: LanPeer = { id, name, device: device || '未知设备', address, lastSeen: Date.now(), avatar: sanitizeAvatar(msg.avatar) }
      this.peers.set(id, next)
      if (!previous || previous.name !== next.name || previous.device !== next.device || previous.address !== next.address || previous.avatar !== next.avatar) this.emit()
      return
    }

    if (msg.type === 'bye') {
      const peerId = clean(msg.id, 80)
      const removed = this.peers.delete(peerId)
      for (const [id, share] of this.terminals) if (!share.self && share.ownerId === peerId) this.terminals.delete(id)
      if (removed) this.emit()
      return
    }

    if (msg.type === 'assist') {
      const peerId = clean(msg.from?.id, 80)
      if (!peerId || msg.to !== this.profile.id) return
      const peer = this.peers.get(peerId)
      if (!peer) return
      const mid = clean(msg.mid, 100)
      const part = Number(msg.part)
      const total = Number(msg.total)
      if (!mid || !Number.isInteger(part) || !Number.isInteger(total) || part < 0 || total < 1 || total > 64 || part >= total || typeof msg.data !== 'string') return
      let entry = this.assistParts.get(mid)
      if (!entry) {
        entry = { parts: new Array(total).fill(''), total, at: Date.now(), peer }
        this.assistParts.set(mid, entry)
      }
      entry.parts[part] = msg.data
      if (Date.now() - entry.at > 30_000) { this.assistParts.delete(mid); return }
      if (entry.parts.filter(Boolean).length < total) return
      this.assistParts.delete(mid)
      try {
        const payload = JSON.parse(Buffer.from(entry.parts.join(''), 'base64').toString('utf8')) as Record<string, unknown>
        const event: LanAssistEvent = { peerId, peerName: peer.name, peerDevice: peer.device, payload }
        for (const listener of this.assistListeners) {
          try { listener(event) } catch { /* 忽略监听器异常 */ }
        }
      } catch { /* 无效 payload */ }
      return
    }

    if (msg.type === 'terminal-offer') {
      const raw = msg.share as Record<string, unknown> | undefined
      const id = clean(raw?.id, 100)
      if (!id || this.terminals.has(id)) return
      const ownerId = clean(msg.from?.id, 80)
      if (!ownerId || ownerId === this.profile.id) return
      this.terminals.set(id, {
        id, ownerId, ownerName: clean(msg.from?.name, 40) || '局域网用户',
        ownerDevice: clean(msg.from?.device, 80) || '未知设备',
        title: clean(raw?.title, 100) || '终端会话', hostName: clean(raw?.hostName, 100),
        joined: false, self: false, startedAt: Number(raw?.startedAt) || Date.now()
      })
      this.emit()
      return
    }
    if (msg.type === 'terminal-output') {
      const id = clean(msg.shareId, 100)
      const share = this.terminals.get(id)
      if (!share || share.self || !share.joined || typeof msg.data !== 'string') return
      try {
        const text = Buffer.from(msg.data, 'base64').toString('utf8')
        if (!text) return
        for (const listener of this.terminalListeners) {
          try { listener({ id, data: text }) } catch { /* 忽略监听器异常 */ }
        }
      } catch { /* 无效分片 */ }
      return
    }
    if (msg.type === 'terminal-stop') {
      const id = clean(msg.shareId, 100)
      const share = this.terminals.get(id)
      if (share && !share.self) { this.terminals.delete(id); this.emit() }
      return
    }
    if (msg.type !== 'share' && msg.type !== 'file') return
    const mid = clean(msg.mid, 100)
    if (!mid || this.seen.has(mid)) return
    this.seen.set(mid, Date.now())
    if (this.seen.size > 256) {
      const cutoff = Date.now() - 60_000
      for (const [key, at] of this.seen) if (at < cutoff) this.seen.delete(key)
    }
    const fromId = clean(msg.from?.id, 80)
    const fromName = clean(msg.from?.name, 40)
    if (!fromId || !fromName) return

    if (msg.type === 'share') {
      if (msg.to !== this.profile.id) return
      const host = sanitizeHost(msg.host)
      if (!host) return
      this.pushEvent({
        id: randomUUID(), kind: 'share', fromId, fromName,
        fromDevice: clean(msg.from?.device, 80) || '未知设备',
        at: Date.now(), read: false, host
      })
      return
    }

    if (msg.to && msg.to !== '*' && msg.to !== this.profile.id) return
    const hostName = clean(msg.hostName, 80)
    const remotePath = clean(msg.path, 500)
    if (!hostName || !remotePath || !validAction(msg.action)) return
    this.pushEvent({
      id: randomUUID(), kind: 'file', fromId, fromName,
      fromDevice: clean(msg.from?.device, 80) || '未知设备',
      at: Date.now(), read: false, hostName, path: remotePath, action: msg.action
    })
  }

  private pushEvent(event: LanEvent): void {
    this.events.unshift(event)
    this.events = this.events.slice(0, MAX_EVENTS)
    this.emit()
  }

  private sweepPeers(): void {
    const cutoff = Date.now() - EXPIRE_MS
    let changed = false
    for (const [id, peer] of this.peers) {
      if (peer.lastSeen < cutoff) {
        this.peers.delete(id)
        for (const [shareId, share] of this.terminals) if (!share.self && share.ownerId === id) this.terminals.delete(shareId)
        changed = true
      }
    }
    const cutoffAssist = Date.now() - 35_000
    for (const [mid, entry] of this.assistParts) if (entry.at < cutoffAssist) this.assistParts.delete(mid)
    if (changed) this.emit()
  }
}
