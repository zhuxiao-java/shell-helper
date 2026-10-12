import { contextBridge, ipcRenderer } from 'electron'
import type { Settings, SettingsResult, StorageLocationId, StorageLocations } from '../shared/settings'
import type { EditItem, OpenFileRequest } from '../shared/external'

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
  detachEdits: (sessionId: string): Promise<void> => ipcRenderer.invoke('edits:detach', sessionId),
  onEditsChanged(callback: (items: EditItem[]) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, items: EditItem[]): void => callback(items)
    ipcRenderer.on('edits:changed', listener)
    return () => ipcRenderer.removeListener('edits:changed', listener)
  },
  chooseSavePath: (name: string): Promise<string | null> => ipcRenderer.invoke('dialog:save', name),
  chooseDirectory: (): Promise<string | null> => ipcRenderer.invoke('dialog:directory'),
  listLocalFiles: (root: string): Promise<{ path: string; relative: string; size: number }[]> => ipcRenderer.invoke('files:list-local', root),
  downloadTo: (input: { id: string; sessionId: string; remotePath: string; destPath: string }): Promise<void> => ipcRenderer.invoke('files:download', input),
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
