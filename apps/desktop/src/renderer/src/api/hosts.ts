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
