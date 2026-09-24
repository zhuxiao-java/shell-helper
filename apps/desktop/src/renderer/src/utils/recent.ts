// 最近连接记录:仅存本机 localStorage,保存 hostId + 时间戳。
// 主机被删除时按 id 关联不到即自动忽略,无需额外清理。
const KEY = 'shell-helper:recent-hosts'
const MAX = 8

export interface RecentItem {
  hostId: string
  ts: number
}

function read(): RecentItem[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function write(list: RecentItem[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    /* 忽略隐私模式等写入异常 */
  }
}

/** 记录一次连接:置顶去重,超出上限截断 */
export function recordConnect(hostId: string): void {
  if (!hostId) return
  const list = read().filter((r) => r.hostId !== hostId)
  list.unshift({ hostId, ts: Date.now() })
  write(list.slice(0, MAX))
}

/** 读取最近连接(按时间倒序) */
export function getRecents(): RecentItem[] {
  return read()
}

/** 移除某条最近记录(如主机已删除) */
export function dropRecent(hostId: string): void {
  write(read().filter((r) => r.hostId !== hostId))
}
