import { getHttp } from './client'
import type { Session } from './types'

export async function openSession(
  hostId: string,
  type: Session['type']
): Promise<Session> {
  const http = await getHttp()
  const { data } = await http.post<Session>('/api/sessions', { host_id: hostId, type })
  return data
}

export async function openLocalSession(): Promise<Session> {
  const http = await getHttp()
  const { data } = await http.post<Session>('/api/sessions/local')
  return data
}

export async function closeSession(sessionId: string): Promise<void> {
  const http = await getHttp()
  await http.delete(`/api/sessions/${sessionId}`)
}
