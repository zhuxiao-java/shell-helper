import { shallowReactive } from 'vue'

export interface TerminalBridge {
  sessionId: string
  ready(): boolean
  insert(command: string): boolean
}
export interface FileBridge { refresh(): void; openSelected(): void }
export const terminalBridges = shallowReactive(new Map<string, TerminalBridge>())
export const fileBridges = new Map<string, FileBridge>()
