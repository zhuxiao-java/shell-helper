export const MAX_FILE_BYTES = 10 * 1024 * 1024
export type EditStatus = 'synced' | 'pending' | 'uploading' | 'conflict' | 'disconnected' | 'error'
export interface EditItem {
  id: string
  hostId: string
  hostName: string
  remotePath: string
  sessionId: string | null
  status: EditStatus
  dirty: boolean
  hash: string
  message: string
}
export interface OpenFileRequest { sessionId: string; path: string; hostName: string }
export const EDIT_STATUS: Record<EditStatus, string> = {
  synced: '已同步', pending: '待回传', uploading: '正在回传', conflict: '远程冲突',
  disconnected: '连接已断开', error: '操作失败'
}
