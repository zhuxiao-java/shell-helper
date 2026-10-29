import { getHttp } from './client'

export interface TunnelRule {
  id: string
  host_id: string
  name: string
  local_port: number
  remote_host: string
  remote_port: number
  status: 'running' | 'stopped' | 'error'
  bound_port: number | null
  error: string
}

export interface TunnelInput {
  host_id: string
  name: string
  local_port: number
  remote_host: string
  remote_port: number
}

export async function listTunnels(hostId: string): Promise<TunnelRule[]> {
  const http = await getHttp()
  const { data } = await http.get<TunnelRule[]>('/api/tunnels', { params: { host_id: hostId } })
  return data
}

export async function createTunnel(input: TunnelInput): Promise<TunnelRule> {
  const http = await getHttp()
  const { data } = await http.post<TunnelRule>('/api/tunnels', input)
  return data
}

export async function startTunnel(id: string): Promise<TunnelRule> {
  const http = await getHttp()
  const { data } = await http.post<TunnelRule>(`/api/tunnels/${id}/start`)
  return data
}

export async function stopTunnel(id: string): Promise<TunnelRule> {
  const http = await getHttp()
  const { data } = await http.post<TunnelRule>(`/api/tunnels/${id}/stop`)
  return data
}

export async function deleteTunnel(id: string): Promise<void> {
  const http = await getHttp()
  await http.delete(`/api/tunnels/${id}`)
}
