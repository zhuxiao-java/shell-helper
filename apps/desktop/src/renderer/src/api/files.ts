import { getHttp } from './client'
import type { FileEntry } from './types'

export async function listDir(sessionId: string, path: string): Promise<FileEntry[]> {
  const http = await getHttp()
  const { data } = await http.get<{ path: string; entries: FileEntry[] }>('/api/files/list', {
    params: { session_id: sessionId, path }
  })
  return data.entries
}

export async function mkdir(sessionId: string, path: string): Promise<void> {
  const http = await getHttp()
  await http.post('/api/files/mkdir', null, { params: { session_id: sessionId, path } })
}

export async function rename(sessionId: string, oldPath: string, newPath: string): Promise<void> {
  const http = await getHttp()
  await http.post('/api/files/rename', null, {
    params: { session_id: sessionId, old_path: oldPath, new_path: newPath }
  })
}

export async function remove(sessionId: string, path: string): Promise<void> {
  const http = await getHttp()
  await http.post('/api/files/delete', null, { params: { session_id: sessionId, path } })
}
