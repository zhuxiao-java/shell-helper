import { getHttp } from './client'
import type { Host, HostInput } from './types'

export async function listHosts(): Promise<Host[]> {
  const http = await getHttp()
  const { data } = await http.get<Host[]>('/api/hosts')
  return data
}

export async function createHost(input: HostInput): Promise<Host> {
  const http = await getHttp()
  const { data } = await http.post<Host>('/api/hosts', input)
  return data
}

export async function updateHost(id: string, input: HostInput): Promise<Host> {
  const http = await getHttp()
  const { data } = await http.put<Host>(`/api/hosts/${id}`, input)
  return data
}

export async function testHost(input: HostInput & { id?: string }): Promise<{ ok: boolean; message: string }> {
  const http = await getHttp()
  const { data } = await http.post<{ ok: boolean; message: string }>('/api/hosts/test', input)
  return data
}

export async function deleteHost(id: string): Promise<void> {
  const http = await getHttp()
  await http.delete(`/api/hosts/${id}`)
}

export interface HostKeyChallenge {
  code: 'unknown_host_key' | 'host_key_changed'
  host: string
  port: number
  key_type: string
  public_key: string
  fingerprint: string
  message: string
}

export async function acceptHostKey(challenge: HostKeyChallenge): Promise<void> {
  const http = await getHttp()
  await http.post('/api/hosts/known', challenge)
}

export async function exportHosts(): Promise<Host[]> {
  const http = await getHttp()
  const { data } = await http.get<Host[]>('/api/hosts/export')
  return data
}

export async function importHosts(items: HostInput[]): Promise<Host[]> {
  const http = await getHttp()
  const { data } = await http.post<Host[]>('/api/hosts/import', items)
  return data
}
