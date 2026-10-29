export interface LanPeer {
  id: string
  name: string
  device: string
  address: string
  lastSeen: number
  avatar?: string
}

export interface LanProfile {
  id: string
  name: string
  device: string
  avatar?: string
}

export interface SharedHost {
  name: string
  protocol: string
  host: string
  port: number
  username: string
  group: string
  tags: string
  remoteCwd: string
}

export type LanFileAction = 'created' | 'modified' | 'renamed' | 'deleted'

export interface LanEvent {
  id: string
  kind: 'file' | 'share'
  fromId: string
  fromName: string
  fromDevice: string
  at: number
  read: boolean
  hostName?: string
  path?: string
  action?: LanFileAction
  host?: SharedHost
}

export interface SharedTerminal {
  id: string
  ownerId: string
  ownerName: string
  ownerDevice: string
  title: string
  hostName: string
  joined: boolean
  self: boolean
  startedAt: number
}

export interface LanState {
  enabled: boolean
  profile: LanProfile
  peers: LanPeer[]
  events: LanEvent[]
  terminals: SharedTerminal[]
  error?: string
}

export interface LanShareResult {
  ok: boolean
  error?: string
}

export interface LanFileNotice {
  hostName: string
  path: string
  action: LanFileAction
}

export interface TerminalShareInput {
  title: string
  hostName: string
}

export interface LanAssistEvent {
  peerId: string
  peerName: string
  peerDevice: string
  payload: Record<string, unknown>
}
