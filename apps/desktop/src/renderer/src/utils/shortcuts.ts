import { fromKey, terminalControl, type ActionId, type Settings, type TerminalCommand } from '../../../shared/settings'

interface ShortcutContext {
  settings(): Settings
  blocked(): boolean
  action(id: ActionId): boolean
  command(command: TerminalCommand): boolean
  mac: boolean
}
let context: ShortcutContext | undefined
const handled = new WeakSet<KeyboardEvent>()
export function hasDialog(): boolean {
  return [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')].some(el => el.getClientRects().length > 0)
}
export function dispatchShortcut(event: KeyboardEvent): boolean {
  if (handled.has(event)) return true
  if (!context || event.type !== 'keydown' || event.isComposing || event.keyCode === 229 || !document.hasFocus() || context.blocked() || hasDialog()) return false
  const target = event.target as HTMLElement | null
  const terminal = !!target?.closest?.('.xterm')
  if (terminal && terminalControl(event)) return false
  if (!terminal && target?.closest?.('input, textarea, select, [contenteditable="true"]')) return false
  const key = fromKey(event, context.mac)
  if (!key) return false
  const settings = context.settings()
  const action = (Object.entries(settings.bindings) as [ActionId, Settings['bindings'][ActionId]][])
    .find(([, b]) => b.enabled && b.shortcut === key)?.[0]
  const command = settings.commands.find(c => c.enabled && c.shortcut === key)
  if (!action && !command) return false
  if (event.repeat) { event.preventDefault(); return true }
  const accepted = action ? context.action(action) : context.command(command!)
  if (!accepted) return false
  handled.add(event)
  event.preventDefault()
  event.stopPropagation()
  return true
}
export function installShortcuts(value: ShortcutContext): () => void {
  context = value
  window.addEventListener('keydown', dispatchShortcut, true)
  return () => { window.removeEventListener('keydown', dispatchShortcut, true); context = undefined }
}
