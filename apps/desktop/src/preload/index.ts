import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { Settings, SettingsResult, StorageLocationId, StorageLocations } from '../shared/settings'
import type { EditItem, OpenFileRequest } from '../shared/external'
import type { LanFileNotice, LanShareResult, LanState } from '../shared/lan'

export interface BackendConn {
  baseUrl: string
  wsUrl: string
  token: string
}

const api = {
  /** 获取(并按需拉起)Python 后端的连接信息 */
  getBackendInfo(): Promise<BackendConn> {
    return ipcRenderer.invoke('backend:info')
  },
  getVersion(): Promise<string> {
    return ipcRenderer.invoke('app:version')
  },
  /** Electron 32+ 已移除 File.path，拖拽/文件选择统一走 webUtils */
  getPathForFile(file: File): string {
    return webUtils.getPathForFile(file)
  },
  readStorageLocations: (): Promise<StorageLocations> => ipcRenderer.invoke('storage:read'),
  openStorageLocation: (id: StorageLocationId): Promise<void> => ipcRenderer.invoke('storage:open', id),
  copyStorageLocation: (id: StorageLocationId): Promise<void> => ipcRenderer.invoke('storage:copy', id),
  readSettings: (): Promise<SettingsResult> => ipcRenderer.invoke('settings:read'),
  saveSettings: (settings: Settings): Promise<Settings> => ipcRenderer.invoke('settings:save', settings),
  chooseEditor: (): Promise<string | null> => ipcRenderer.invoke('editor:choose'),
  listEdits: (): Promise<EditItem[]> => ipcRenderer.invoke('edits:list'),
  openFile: (input: OpenFileRequest): Promise<EditItem[]> => ipcRenderer.invoke('edits:open', input),
  reopenEdit: (id: string, useDefault = false): Promise<void> => ipcRenderer.invoke('edits:reopen', id, useDefault),
  uploadEdit: (id: string, hash: string): Promise<void> => ipcRenderer.invoke('edits:upload', id, hash),
  reloadEdit: (id: string): Promise<EditItem[]> => ipcRenderer.invoke('edits:reload', id),
  detachEdits: (sessionId: string): Promise<void> => ipcRenderer.invoke('edits:detach', sessionId),
  onEditsChanged(callback: (items: EditItem[]) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, items: EditItem[]): void => callback(items)
    ipcRenderer.on('edits:changed', listener)
    return () => ipcRenderer.removeListener('edits:changed', listener)
  },
  lanState(): Promise<LanState> {
    return ipcRenderer.invoke('lan:state')
  },
  setLanEnabled(enabled: boolean): Promise<LanState> {
    return ipcRenderer.invoke('lan:set-enabled', enabled)
  },
  setLanName(name: string): Promise<LanState> {
    return ipcRenderer.invoke('lan:set-name', name)
  },
  setLanAvatar(avatar: string): Promise<LanState> {
    return ipcRenderer.invoke('lan:set-avatar', avatar)
  },
  shareLanHost(targetId: string, host: unknown): Promise<LanShareResult> {
    return ipcRenderer.invoke('lan:share', targetId, host)
  },
  notifyLanFile(input: LanFileNotice): Promise<void> {
    return ipcRenderer.invoke('lan:notify-file', input)
  },
  markLanRead(): Promise<LanState> {
    return ipcRenderer.invoke('lan:mark-read')
  },
  startLanTerminalShare(input: { title: string; hostName: string }): Promise<string> {
    return ipcRenderer.invoke('lan:start-terminal-share', input)
  },
  stopLanTerminalShare(id: string): Promise<void> {
    return ipcRenderer.invoke('lan:stop-terminal-share', id)
  },
  joinLanTerminal(id: string): Promise<void> {
    return ipcRenderer.invoke('lan:join-terminal', id)
  },
  leaveLanTerminal(id: string): Promise<void> {
    return ipcRenderer.invoke('lan:leave-terminal', id)
  },
  sendLanAssist(peerId: string, payload: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke('lan:assist-send', peerId, payload)
  },
  onLanAssist(callback: (event: import('../shared/lan').LanAssistEvent) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, payload: import('../shared/lan').LanAssistEvent): void => callback(payload)
    ipcRenderer.on('lan:assist', listener)
    return () => ipcRenderer.removeListener('lan:assist', listener)
  },
  sendLanTerminalOutput(id: string, data: string): Promise<void> {
    return ipcRenderer.invoke('lan:terminal-output', id, data)
  },
  onLanTerminalOutput(callback: (payload: { id: string; data: string }) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, payload: { id: string; data: string }): void => callback(payload)
    ipcRenderer.on('lan:terminal-output', listener)
    return () => ipcRenderer.removeListener('lan:terminal-output', listener)
  },
  onLanUpdate(callback: (state: LanState) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, state: LanState): void => callback(state)
    ipcRenderer.on('lan:update', listener)
    return () => ipcRenderer.removeListener('lan:update', listener)
  },
  saveRecording: (input: { name: string; content: string }): Promise<string | null> => ipcRenderer.invoke('recording:save', input),
  chooseSavePath: (name: string): Promise<string | null> => ipcRenderer.invoke('dialog:save', name),
  chooseDirectory: (): Promise<string | null> => ipcRenderer.invoke('dialog:directory'),
  listLocalFiles: (root: string): Promise<{ path: string; relative: string; size: number }[]> => ipcRenderer.invoke('files:list-local', root),
  listLocalDirectory: (directory: string): Promise<{ name: string; path: string; is_dir: boolean; size: number; mtime: number }[]> => ipcRenderer.invoke('files:list-local-dir', directory),
  downloadTo: (input: { id: string; sessionId: string; remotePath: string; destPath: string; resume?: boolean }): Promise<void> => ipcRenderer.invoke('files:download', input),
  uploadFrom: (input: { id: string; sessionId: string; directory: string; localPath: string; name: string; overwrite: boolean }): Promise<void> => ipcRenderer.invoke('files:upload', input),
  cancelTransfer: (id: string): Promise<void> => ipcRenderer.invoke('files:cancel', id),
  onTransferProgress(callback: (event: { id: string; loaded: number; total: number }) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, payload: { id: string; loaded: number; total: number }): void => callback(payload)
    ipcRenderer.on('transfer:progress', listener)
    return () => ipcRenderer.removeListener('transfer:progress', listener)
  },
  copyText: (text: string): Promise<void> => ipcRenderer.invoke('clipboard:write', text)
}

contextBridge.exposeInMainWorld('shellHelper', api)

export type ShellHelperApi = typeof api
