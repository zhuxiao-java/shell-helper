export type Protocol = 'ssh' | 'sftp' | 'telnet' | 'ftp' | 'local'
export type AuthType = 'password' | 'pubkey' | 'agent' | 'none'
export type SessionType = 'terminal' | 'sftp' | 'ftp'

// 协议 → 界面归类
export const TERMINAL_PROTOCOLS: Protocol[] = ['ssh', 'telnet', 'local']
export const FILE_PROTOCOLS: Protocol[] = ['ssh', 'sftp', 'ftp']

export function isFileProto(p: Protocol): boolean {
  return FILE_PROTOCOLS.includes(p)
}

export function isTerminalProto(p: Protocol): boolean {
  return TERMINAL_PROTOCOLS.includes(p)
}

// 打开文件会话时使用的后端类型
export function fileSessionType(p: Protocol): SessionType {
  if (!isFileProto(p)) throw new Error(`${p.toUpperCase()} 不支持文件会话`)
  if (p === 'ftp') return 'ftp'
  return 'sftp' // sftp 及 ssh 走 SFTP
}

export function protocolLabel(p: Protocol): string {
  return { ssh: 'Shell', sftp: 'SFTP', telnet: 'Telnet', ftp: 'FTP', local: '本地' }[p] ?? p.toUpperCase()
}

export interface Host {
  id: string
  name: string
  group: string
  protocol: Protocol
  host: string
  port: number
  username: string
  auth_type: AuthType
  credential_id: string | null
  key_path: string
  jump_host_ids: string[]
  tags: string
  remote_cwd: string
}

export interface HostInput {
  name: string
  group?: string
  protocol?: Protocol
  host?: string
  port?: number
  username?: string
  auth_type?: AuthType
  key_path?: string
  jump_host_ids?: string[]
  tags?: string
  remote_cwd?: string
  password?: string | null
}

export interface Session {
  session_id: string
  host_id: string
  type: SessionType
  status: string
  remote_cwd: string
}

export interface FileEntry {
  name: string
  path: string
  is_dir: boolean
  size: number
  mtime: number
  mode: string
}
