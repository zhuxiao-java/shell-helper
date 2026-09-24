export const ACTIONS = {
  newConnection: '新建连接', searchConnections: '搜索连接', toggleSidebar: '切换侧栏',
  goHome: '返回起始页', closeTab: '关闭当前标签', previousTab: '前一个标签',
  nextTab: '后一个标签', refreshFiles: '刷新文件目录', openFile: '外部打开选中文件',
  openSettings: '打开设置'
} as const
export type ActionId = keyof typeof ACTIONS
export interface Binding { shortcut: string; enabled: boolean }
export interface TerminalCommand extends Binding { id: string; name: string; command: string }
export interface Settings {
  version: 1
  bindings: Record<ActionId, Binding>
  commands: TerminalCommand[]
  editor: { mode: 'default' | 'custom'; path: string }
}
export interface SettingsResult { settings: Settings; warning?: string }
export type StorageLocationId = 'drafts' | 'database' | 'settings' | 'logs'
export interface StorageLocation { id: StorageLocationId; path: string | null; unavailable?: string }
export interface StorageLocations { locations: StorageLocation[]; warning?: string }

export function defaults(): Settings {
  const bindings = Object.fromEntries(Object.keys(ACTIONS).map(id => [id, { shortcut: '', enabled: true }])) as Settings['bindings']
  bindings.newConnection.shortcut = 'Mod+N'
  bindings.toggleSidebar.shortcut = 'Mod+B'
  bindings.openSettings.shortcut = 'Mod+,'
  return { version: 1, bindings, commands: [], editor: { mode: 'default', path: '' } }
}

export function validCommand(command: string): boolean {
  return typeof command === 'string' && !!command.trim() && command.length <= 4096 && !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(command)
}

export function shortcutError(shortcut: string): string | undefined {
  if (!shortcut) return
  const parts = shortcut.split('+')
  const key = parts.pop()!
  const order = ['Mod', 'Ctrl', 'Alt', 'Shift']
  if (!/^(?:[A-Z0-9]|F(?:[1-9]|1\d|2[0-4])|[,./\\;'\[\]\-=\x60]|Tab|Space|Enter|Escape|Backspace|Delete|ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Home|End|PageUp|PageDown)$/.test(key) ||
      parts.some(p => !order.includes(p)) || new Set(parts).size !== parts.length ||
      [...parts].sort((a, b) => order.indexOf(a) - order.indexOf(b)).join('+') !== parts.join('+')) return '无效的快捷键组合'
  if (!parts.some(p => p !== 'Shift') && !/^F\d+$/.test(key)) return '请包含 Ctrl/Cmd 或 Alt 修饰键'
  if ((parts.includes('Mod') && parts.includes('Ctrl')) ||
      ['Mod+Q', 'Mod+H', 'Mod+M', 'Mod+Tab', 'Mod+Space', 'Ctrl+Space', 'Alt+Tab', 'Alt+F4', 'Ctrl+Alt+Delete', 'Mod+Alt+Delete', 'Mod+L', 'Mod+Alt+Escape'].includes(shortcut)) return '该组合由系统保留'
}

export function validateSettings(value: unknown): Settings {
  if (!value || typeof value !== 'object') throw new Error('设置格式无效')
  const v = value as Settings
  if (v.version !== 1 || !v.bindings || !Array.isArray(v.commands) || v.commands.length > 100) throw new Error('设置版本或内容无效')
  const result = defaults()
  const seen = new Set<string>()
  function binding(b: Binding): Binding {
    if (!b || typeof b.shortcut !== 'string' || typeof b.enabled !== 'boolean') throw new Error('快捷键格式无效')
    const error = shortcutError(b.shortcut)
    if (error) throw new Error(error)
    if (b.shortcut) {
      if (seen.has(b.shortcut)) throw new Error(`快捷键重复：${b.shortcut}`)
      seen.add(b.shortcut)
    }
    return { shortcut: b.shortcut, enabled: b.enabled }
  }
  for (const id of Object.keys(ACTIONS) as ActionId[]) result.bindings[id] = binding(v.bindings[id])
  const ids = new Set<string>()
  result.commands = v.commands.map(c => {
    if (!c || typeof c.id !== 'string' || !/^[\w-]{1,64}$/.test(c.id) || ids.has(c.id) ||
        typeof c.name !== 'string' || !c.name.trim() || c.name.length > 100 || !validCommand(c.command)) throw new Error('命令必须有名称且为不含控制字符的单行文本')
    ids.add(c.id)
    return { ...binding(c), id: c.id, name: c.name.trim(), command: c.command }
  })
  if (!v.editor || !['default', 'custom'].includes(v.editor.mode) || typeof v.editor.path !== 'string' ||
      v.editor.path.length > 4096 || /[\x00-\x1f]/.test(v.editor.path) || (v.editor.mode === 'custom' && !v.editor.path)) throw new Error('请选择有效的文本编辑器')
  result.editor = { mode: v.editor.mode, path: v.editor.path }
  return result
}

export interface KeyInput {
  key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean
}
export function fromKey(event: KeyInput, mac: boolean): string {
  if (['Meta', 'Control', 'Alt', 'Shift', 'Dead', 'Unidentified', 'Process'].includes(event.key)) return ''
  if (!mac && event.metaKey) return ''
  const parts: string[] = []
  if (mac ? event.metaKey : event.ctrlKey) parts.push('Mod')
  if (mac && event.ctrlKey) parts.push('Ctrl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  const punctuation: Record<string, string> = { Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Backquote: '`', Space: 'Space' }
  const key = /^(Key[A-Z]|Digit[0-9])$/.test(event.code) ? event.code.replace(/^(Key|Digit)/, '') : punctuation[event.code] || event.key
  return [...parts, key].join('+')
}
export function terminalControl(event: KeyInput): boolean {
  return event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
}
export function displayShortcut(shortcut: string, mac: boolean): string {
  return shortcut.replace('Mod', mac ? '⌘' : 'Ctrl').replace('Alt', mac ? '⌥' : 'Alt')
}
