import { ref } from 'vue'
import { defineStore } from 'pinia'

export interface WorkspaceEntry {
  hostId: string
  kind: 'terminal' | 'files'
  startupCommand?: string
}

export interface Workspace {
  id: string
  name: string
  entries: WorkspaceEntry[]
  localPath: string
  createdAt: number
}

const STORAGE_KEY = 'shell-helper:workspaces'

function load(): Workspace[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') as Workspace[]
    if (!Array.isArray(raw)) return []
    return raw.filter(item => item && typeof item.id === 'string' && typeof item.name === 'string' && Array.isArray(item.entries))
  } catch { return [] }
}

export const useWorkspacesStore = defineStore('workspaces', () => {
  const items = ref<Workspace[]>(load())

  function persist(): void {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(items.value)) } catch { /* 忽略配额错误 */ }
  }

  function create(input: { name: string; entries: WorkspaceEntry[]; localPath?: string }): Workspace {
    const workspace: Workspace = {
      id: crypto.randomUUID(),
      name: input.name.trim() || '未命名工作区',
      entries: input.entries.filter(entry => entry.hostId),
      localPath: input.localPath || '',
      createdAt: Date.now()
    }
    items.value = [workspace, ...items.value].slice(0, 100)
    persist()
    return workspace
  }

  function remove(id: string): void {
    items.value = items.value.filter(item => item.id !== id)
    persist()
  }

  function updateLocalPath(id: string, path: string): void {
    const workspace = items.value.find(item => item.id === id)
    if (!workspace) return
    workspace.localPath = path
    persist()
  }

  return { items, create, remove, updateLocalPath }
})
