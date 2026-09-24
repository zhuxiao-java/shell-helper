import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import * as hostApi from '@renderer/api/hosts'
import type { Host, HostInput } from '@renderer/api/types'

export const useHostStore = defineStore('hosts', () => {
  const hosts = ref<Host[]>([])
  const loading = ref(false)
  const error = ref('')
  const keyword = ref('')

  const grouped = computed(() => {
    const map = new Map<string, Host[]>()
    const kw = keyword.value.trim().toLowerCase()
    for (const h of hosts.value) {
      if (kw && !`${h.name} ${h.host} ${h.tags}`.toLowerCase().includes(kw)) continue
      const list = map.get(h.group) ?? []
      list.push(h)
      map.set(h.group, list)
    }
    return Array.from(map.entries()).map(([group, items]) => ({ group, items }))
  })

  async function refresh(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      hosts.value = await hostApi.listHosts()
    } catch (err) {
      error.value = (err as Error).message || '加载主机列表失败'
      throw err
    } finally {
      loading.value = false
    }
  }

  async function create(input: HostInput): Promise<Host> {
    const h = await hostApi.createHost(input)
    hosts.value.push(h)
    return h
  }

  async function update(id: string, input: HostInput): Promise<void> {
    const updated = await hostApi.updateHost(id, input)
    const idx = hosts.value.findIndex((x) => x.id === id)
    if (idx >= 0) hosts.value[idx] = updated
  }

  async function remove(id: string): Promise<void> {
    await hostApi.deleteHost(id)
    hosts.value = hosts.value.filter((x) => x.id !== id)
  }

  function byId(id: string): Host | undefined {
    return hosts.value.find((h) => h.id === id)
  }

  return { hosts, loading, error, keyword, grouped, refresh, create, update, remove, byId }
})
