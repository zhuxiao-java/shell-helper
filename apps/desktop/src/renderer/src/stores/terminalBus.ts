import { ref } from 'vue'
import { defineStore } from 'pinia'

export const useTerminalBus = defineStore('terminal-bus', () => {
  const broadcast = ref(false)
  const senders = new Map<string, (data: string) => boolean>()

  function register(id: string, send: (data: string) => boolean): void {
    senders.set(id, send)
  }

  function unregister(id: string): void {
    senders.delete(id)
  }

  function broadcastInput(sourceId: string, data: string): void {
    if (!broadcast.value) return
    for (const [id, send] of senders) {
      if (id !== sourceId) send(data)
    }
  }

  return { broadcast, register, unregister, broadcastInput }
})
