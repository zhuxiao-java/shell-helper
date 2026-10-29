<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox, type TreeInstance } from 'element-plus'
import * as fileApi from '@renderer/api/files'
import type { FileEntry } from '@renderer/api/types'
import type { Tab } from '@renderer/stores/session'
import { useSessionStore } from '@renderer/stores/session'
import { useHostStore } from '@renderer/stores/host'
import { useExternalStore } from '@renderer/stores/external'
import { useSettingsStore } from '@renderer/stores/settings'
import { useLanStore } from '@renderer/stores/lan'
import { useTransfersStore } from '@renderer/stores/transfers'
import LocalPane from './LocalPane.vue'
import { fileBridges, sessionMeta, terminalBridges } from '@renderer/utils/workspace'
import { isTerminalProto } from '@renderer/api/types'
import { EDIT_STATUS, MAX_FILE_BYTES } from '../../../shared/external'
import type { LanFileAction } from '../../../shared/lan'

const props = defineProps<{ tab: Tab; visible: boolean }>()
const sessionStore = useSessionStore()
const external = useExternalStore()
const settings = useSettingsStore()
const lan = useLanStore()
const transfers = useTransfersStore()
const hosts = useHostStore()
const selected = ref<FileEntry | null>(null)
const rowMenu = ref<{ x: number; y: number; row: FileEntry } | null>(null)
const opening = ref(false)
const editState = computed(() => external.items.find(item => item.hostId === props.tab.hostId && item.remotePath === selected.value?.path))
fileBridges.set(props.tab.id, {
  refresh: () => { if (props.visible && !loading.value) void refresh() },
  openSelected: () => {
    if (!props.visible) return
    if (selected.value && !selected.value.is_dir) void open(selected.value)
    else ElMessage.info('请先选择普通文本文件')
  }
})
onBeforeUnmount(() => { fileBridges.delete(props.tab.id); delete sessionMeta.path[props.tab.id]; stopProgress?.(); stopTreeResize?.(); window.removeEventListener('resize', scrollMillerToCurrent); window.removeEventListener('click', closeRowMenu); window.removeEventListener('blur', closeRowMenu); requestId++ })

const cwd = ref('/')
const entries = ref<FileEntry[]>([])
const loading = ref(false)
// 目录加载失败信息(非空时展示错误态 + 重试)
const loadError = ref('')
const loaded = ref(false)
const attemptedPath = ref('/')
const query = ref('')
const sortKey = ref<'name' | 'mtime' | 'size'>('name')
const sortDir = ref<1 | -1>(1)
const uploadInput = ref<HTMLInputElement>()
const directoryInput = ref<HTMLInputElement>()
const transferring = ref(false)
const dragActive = ref(false)
const followTerminal = ref(false)
const picked = ref<string[]>([])
type TransferDirection = 'upload' | 'download'
interface TransferHistory {
  id: string
  label: string
  total: number
  direction: TransferDirection
  status: 'done' | 'error'
  error?: string
  startedAt: number
}
const transfer = ref<{ id: string; label: string; loaded: number; total: number; direction: TransferDirection } | null>(null)
const recentTransfers = ref<TransferHistory[]>([])
const transferDrawer = ref(false)
let stopProgress: (() => void) | undefined
const showTree = ref(true)
const localPaneOpen = ref(false)
const tree = ref<TreeInstance>()
const rootEl = ref<HTMLElement>()
const treeVersion = ref(0)
const expandedTreePaths = ref<string[]>([])
const TREE_WIDTH_KEY = 'shell-helper-tree-width'
const TREE_WIDTH_DEFAULT = 210
const TREE_WIDTH_MIN = 170
const TREE_WIDTH_MAX = 360
const treeWidth = ref(TREE_WIDTH_DEFAULT)
let stopTreeResize: (() => void) | undefined
const VIEW_MODE_KEY = 'shell-helper-file-view'
type ViewMode = 'list' | 'columns'
const viewMode = ref<ViewMode>('list')
const millerColumns = ref<MillerColumn[]>([])
const millerScroll = ref<HTMLElement>()
let millerRequest = 0
interface MillerColumn { path: string; entries: FileEntry[]; loading: boolean; error: string }
function clampTreeWidth(value: number): number {
  return Math.min(TREE_WIDTH_MAX, Math.max(TREE_WIDTH_MIN, value))
}
function loadTreeWidth(): void {
  try {
    const stored = Number(localStorage.getItem(TREE_WIDTH_KEY))
    if (stored >= TREE_WIDTH_MIN && stored <= TREE_WIDTH_MAX) treeWidth.value = stored
  } catch { /* 忽略读取异常 */ }
}
function saveTreeWidth(): void {
  try { localStorage.setItem(TREE_WIDTH_KEY, String(Math.round(treeWidth.value))) } catch { /* 忽略写入异常 */ }
}
function resetTreeWidth(): void {
  treeWidth.value = TREE_WIDTH_DEFAULT
  saveTreeWidth()
}
function startTreeResize(event: MouseEvent): void {
  event.preventDefault()
  stopTreeResize?.()
  const startX = event.clientX
  const startWidth = treeWidth.value
  const previousCursor = document.body.style.cursor
  const previousSelect = document.body.style.userSelect
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  const onMove = (move: MouseEvent): void => {
    treeWidth.value = clampTreeWidth(startWidth + move.clientX - startX)
  }
  const onUp = (): void => {
    document.body.style.cursor = previousCursor
    document.body.style.userSelect = previousSelect
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    stopTreeResize = undefined
    saveTreeWidth()
  }
  stopTreeResize = onUp
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

interface FavoriteFolder { name: string; path: string }
const favorites = ref<FavoriteFolder[]>([])
const favoriteKey = computed(() => `shell-helper-tree-favorites:${props.tab.hostId || 'local'}`)
function favoriteName(path: string): string {
  return path === '/' ? '根目录' : path.split('/').filter(Boolean).at(-1) || path
}
function loadFavorites(): void {
  try {
    const raw = JSON.parse(localStorage.getItem(favoriteKey.value) || '[]')
    favorites.value = Array.isArray(raw)
      ? raw.filter((item): item is FavoriteFolder => !!item && typeof item.path === 'string' && item.path.startsWith('/')).slice(0, 6)
      : []
  } catch { favorites.value = [] }
}
function saveFavorites(): void {
  try { localStorage.setItem(favoriteKey.value, JSON.stringify(favorites.value)) } catch { /* 忽略写入异常 */ }
}
function isFavorite(path: string): boolean {
  return favorites.value.some(item => item.path === path)
}
function toggleFavorite(): void {
  if (!loaded.value) return
  if (isFavorite(cwd.value)) favorites.value = favorites.value.filter(item => item.path !== cwd.value)
  else favorites.value = [{ name: favoriteName(cwd.value), path: cwd.value }, ...favorites.value].slice(0, 6)
  saveFavorites()
}
function removeFavorite(path: string): void {
  favorites.value = favorites.value.filter(item => item.path !== path)
  saveFavorites()
}
function openFavorite(path: string): void {
  if (path !== cwd.value) void load(path)
}


function loadViewMode(): void {
  try {
    const stored = localStorage.getItem(VIEW_MODE_KEY)
    if (stored === 'columns' || stored === 'list') viewMode.value = stored
  } catch { /* 忽略读取异常 */ }
}
function saveViewMode(): void {
  try { localStorage.setItem(VIEW_MODE_KEY, viewMode.value) } catch { /* 忽略写入异常 */ }
}
function millerLabel(path: string): string {
  return path === '/' ? '根目录' : path.split('/').filter(Boolean).at(-1) || path
}
function millerActive(column: MillerColumn, entry: FileEntry): boolean {
  if (entry.path === selected.value?.path) return true
  return column.path !== cwd.value && (cwd.value === entry.path || cwd.value.startsWith(entry.path + '/'))
}
async function buildMillerColumns(path = cwd.value, currentEntries?: FileEntry[]): Promise<void> {
  if (viewMode.value !== 'columns') return
  const request = ++millerRequest
  const segments = path.split('/').filter(Boolean)
  const paths = ['/', ...segments.map((_, index) => `/${segments.slice(0, index + 1).join('/')}`)]
  millerColumns.value = paths.map(columnPath => ({ path: columnPath, entries: [], loading: true, error: '' }))
  await nextTick()
  for (let index = 0; index < paths.length; index++) {
    if (request !== millerRequest || viewMode.value !== 'columns') return
    const columnPath = paths[index]
    const column = millerColumns.value[index]
    if (!column) return
    try {
      const list = columnPath === path && currentEntries ? currentEntries : await readDirectory(columnPath)
      if (request !== millerRequest || viewMode.value !== 'columns') return
      column.entries = sortedEntries(list)
    } catch (error) {
      if (request !== millerRequest) return
      column.error = (error as Error).message || '无法读取目录'
    } finally {
      if (request === millerRequest) column.loading = false
    }
  }
  await nextTick()
  scrollMillerToCurrent()
}

function scrollMillerToCurrent(): void {
  const scroller = millerScroll.value
  if (scroller) scroller.scrollTo({ left: scroller.scrollWidth, behavior: 'smooth' })
}
function setView(mode: ViewMode): void {
  if (viewMode.value === mode) return
  viewMode.value = mode
  saveViewMode()
  millerRequest++
  if (mode === 'columns') {
    picked.value = []
    query.value = ''
    void nextTick().then(() => { if (loaded.value) void buildMillerColumns(cwd.value, entries.value) })
  }
}
function onMillerClick(column: MillerColumn, entry: FileEntry): void {
  if (entry.is_dir) {
    if (entry.path !== cwd.value) void load(entry.path)
    return
  }
  selected.value = entry
}
function onMillerDouble(entry: FileEntry): void {
  if (!entry.is_dir) void open(entry)
}
function onMillerKey(event: KeyboardEvent, column: MillerColumn, entry: FileEntry): void {
  if (event.key !== 'Enter') return
  event.preventDefault()
  if (entry.is_dir) onMillerClick(column, entry)
  else void open(entry)
}

function onTreeResizeKey(event: KeyboardEvent): void {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  event.preventDefault()
  treeWidth.value = clampTreeWidth(treeWidth.value + (event.key === 'ArrowRight' ? 12 : -12))
  saveTreeWidth()
}
const pathEditing = ref(false)
const pathInput = ref('')
const addressInput = ref<HTMLInputElement>()
const directoryRequests = new Map<string, Promise<FileEntry[]>>()
let requestId = 0
interface FolderNode { name: string; path: string }
const breadcrumbs = computed(() => cwd.value.split('/').filter(Boolean).map((name, index, all) => ({ name, path: '/' + all.slice(0, index + 1).join('/') })))
const folderName = computed(() => breadcrumbs.value.at(-1)?.name || '根目录')
const expandedPaths = computed(() => [...new Set(['/', ...breadcrumbs.value.map(segment => segment.path), ...expandedTreePaths.value])])
const host = computed(() => hosts.byId(props.tab.hostId))
function toggleLocalPane(): void {
  localPaneOpen.value = !localPaneOpen.value
}

function notifyLan(path: string, action: LanFileAction): void {
  void lan.notifyFile({ hostName: host.value?.name || props.tab.title, path, action })
}
function sortedEntries(list: FileEntry[]): FileEntry[] {
  return list.slice().sort((a, b) => {
    const directory = Number(b.is_dir) - Number(a.is_dir)
    if (directory) return directory
    if (sortKey.value === 'size') return (a.size - b.size) * sortDir.value
    if (sortKey.value === 'mtime') return (a.mtime - b.mtime) * sortDir.value
    return a.name.localeCompare(b.name, undefined, { numeric: true }) * sortDir.value
  })
}
const visibleEntries = computed(() => sortedEntries(entries.value.filter(e => e.name.toLocaleLowerCase().includes(query.value.toLocaleLowerCase()))))
const linkState = computed(() => props.tab.connecting ? 'pending' : (!props.tab.session || props.tab.session.status === 'closed' || props.tab.error ? 'off' : 'ok'))
const linkedTerminal = computed(() => sessionStore.tabs.find(tab => tab.kind === 'terminal' && tab.hostId === props.tab.hostId))
const shellPath = computed(() => linkedTerminal.value ? sessionMeta.shellPath[linkedTerminal.value.id] || '' : '')
const transferLabel = computed(() => {
  const job = transfer.value
  if (!job) return ''
  if (!job.total) return `${job.label} ${fmtSize(job.loaded)}`
  return `${job.label} ${Math.min(100, Math.round(job.loaded / job.total * 100))}%`
})
const transferPercent = computed(() => {
  const job = transfer.value
  if (!job || !job.total) return 0
  return Math.min(100, Math.round(job.loaded / job.total * 100))
})
const pickedEntries = computed(() => visibleEntries.value.filter(e => picked.value.includes(e.path)))
const pickedCount = computed(() => pickedEntries.value.length)
function toggleSort(key: 'name' | 'mtime' | 'size'): void {
  if (sortKey.value === key) sortDir.value = sortDir.value === 1 ? -1 : 1
  else { sortKey.value = key; sortDir.value = 1 }
}
function ariaSort(key: 'name' | 'mtime' | 'size'): 'ascending' | 'descending' | 'none' {
  if (sortKey.value !== key) return 'none'
  return sortDir.value === 1 ? 'ascending' : 'descending'
}
const folders = computed(() => entries.value.filter(e => e.is_dir).length)
watch(visibleEntries, list => {
  if (selected.value && !list.some(e => e.path === selected.value?.path)) selected.value = null
  picked.value = picked.value.filter(path => list.some(e => e.path === path))
})
// 首次加载标记:避免空目录时 watch 重复触发 load
let initialized = false

/** 会话创建后定位到主机配置的初始目录("~"/空视为根目录) */
function initialCwd(): string {
  const rc = (props.tab.session?.remote_cwd || '').trim()
  if (!rc || rc === '~' || rc === './') return '/'
  return rc.startsWith('/') ? rc : `/${rc}`
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function fmtTime(ts: number): string {
  return ts > 0 ? new Date(ts * 1000).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '—'
}

function join(base: string, name: string): string {
  if (base === '/') return `/${name}`
  return `${base.replace(/\/$/, '')}/${name}`
}

function parent(path: string): string {
  if (path === '/' || path === '') return '/'
  const trimmed = path.replace(/\/$/, '')
  const idx = trimmed.lastIndexOf('/')
  return idx <= 0 ? '/' : trimmed.slice(0, idx)
}

function readDirectory(path: string): Promise<FileEntry[]> {
  const sid = props.tab.session?.session_id
  if (!sid) return Promise.reject(new Error('连接尚未就绪'))
  const key = `${sid}:${path}`
  if (!directoryRequests.has(key)) {
    directoryRequests.set(key, fileApi.listDir(sid, path).finally(() => directoryRequests.delete(key)))
  }
  return directoryRequests.get(key)!
}

async function loadTree(node: { level: number; data: FolderNode }, resolve: (nodes: FolderNode[]) => void, reject: () => void): Promise<void> {
  if (node.level === 0) { resolve([{ name: '根目录', path: '/' }]); return }
  try {
    const list = loaded.value && node.data.path === cwd.value ? entries.value : await readDirectory(node.data.path)
    resolve(list.filter(e => e.is_dir).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })).map(e => ({ name: e.name, path: e.path })))
    await nextTick()
    tree.value?.setCurrentKey(cwd.value)
  } catch (error) {
    reject()
    ElMessage.error(`无法展开目录：${(error as Error).message}，可再次点击箭头重试`)
  }
}

async function load(path = cwd.value): Promise<void> {
  const sid = props.tab.session?.session_id
  if (!sid) return
  const current = ++requestId
  attemptedPath.value = path
  loading.value = true
  loadError.value = ''
  try {
    const result = await readDirectory(path)
    if (current !== requestId || sid !== props.tab.session?.session_id) return
    entries.value = result
    selected.value = null
    if (cwd.value !== path) query.value = ''
    cwd.value = path
    loaded.value = true
    await nextTick()
    tree.value?.setCurrentKey(path)
    if (viewMode.value === 'columns') void buildMillerColumns(path, result)
  } catch (err) {
    if (current !== requestId) return
    loadError.value = (err as Error).message || '未知错误'
    if ((err as { response?: { status: number } }).response?.status === 410) {
      void window.shellHelper.detachEdits(sid)
      if (props.tab.session) props.tab.session.status = 'closed'
    }
  } finally {
    if (current === requestId) loading.value = false
  }
}

function rememberExpanded(path: string): void {
  if (!path || expandedTreePaths.value.includes(path)) return
  expandedTreePaths.value = [...expandedTreePaths.value, path]
}

function forgetExpanded(path: string): void {
  if (!path) return
  expandedTreePaths.value = expandedTreePaths.value.filter(item => item !== path)
}

function collapseTree(): void {
  // 保留当前目录的祖先展开态，只收起其余分支
  expandedTreePaths.value = []
  treeVersion.value++
}

async function revealCurrent(): Promise<void> {
  if (!loaded.value) return
  treeVersion.value++
  await nextTick()
  for (let attempt = 0; attempt < 8; attempt++) {
    const node = rootEl.value?.querySelector<HTMLElement>('.directory-tree .el-tree-node.is-current > .el-tree-node__content')
    if (node) { node.scrollIntoView({ block: 'nearest' }); return }
    await new Promise(resolve => setTimeout(resolve, 60))
  }
}

async function refresh(): Promise<void> {
  await load()
  if (!loadError.value) treeVersion.value++
}

async function editPath(): Promise<void> {
  pathInput.value = cwd.value
  pathEditing.value = true
  await nextTick()
  addressInput.value?.focus()
  addressInput.value?.select()
}

function goToPath(): void {
  const value = pathInput.value.trim()
  if (!value.startsWith('/') || /[\x00-\x1f\x7f]/.test(value)) {
    ElMessage.warning('请输入以 / 开头的远程目录路径')
    return
  }
  const segments: string[] = []
  for (const segment of value.split('/')) {
    if (segment === '..') segments.pop()
    else if (segment && segment !== '.') segments.push(segment)
  }
  pathEditing.value = false
  void load('/' + segments.join('/'))
}

function fileKind(entry: FileEntry): { icon: string; tone: string; label: string } {
  if (entry.is_dir) return { icon: 'Folder', tone: 'folder', label: '文件夹' }
  if (entry.mode.startsWith('l')) return { icon: 'Link', tone: 'link', label: '符号链接' }
  const ext = entry.name.split('.').pop()?.toLowerCase() || ''
  if (['json', 'yaml', 'yml', 'toml', 'ini', 'conf', 'env'].includes(ext)) return { icon: 'Setting', tone: 'config', label: '配置文件' }
  if (['py', 'js', 'ts', 'tsx', 'vue', 'sh', 'html', 'css', 'go', 'java', 'rs'].includes(ext)) return { icon: 'Document', tone: 'code', label: '代码文件' }
  if (['zip', 'gz', 'tar', '7z'].includes(ext)) return { icon: 'Box', tone: 'archive', label: '归档文件' }
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) return { icon: 'Picture', tone: 'image', label: '图片' }
  return { icon: 'Document', tone: 'document', label: '文件' }
}

function onFileKey(event: KeyboardEvent, entry: FileEntry): void {
  if (event.target !== event.currentTarget || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return
  if (event.key === 'Enter') { event.preventDefault(); void open(entry) }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    const index = visibleEntries.value.findIndex(e => e.path === entry.path)
    const next = visibleEntries.value[index + (event.key === 'ArrowDown' ? 1 : -1)]
    if (!next) return
    selected.value = next
    picked.value = [next.path]
    const sibling = event.key === 'ArrowDown' ? (event.currentTarget as HTMLElement).nextElementSibling : (event.currentTarget as HTMLElement).previousElementSibling
    ;(sibling as HTMLElement | null)?.focus()
  }
}

async function open(entry: FileEntry): Promise<void> {
  selected.value = entry
  if (loading.value || loadError.value) return
  if (entry.is_dir) { await load(entry.path); return }
  const sessionId = props.tab.session?.session_id
  if (!sessionId || opening.value) return
  if (entry.mode.startsWith('l') || entry.size > MAX_FILE_BYTES) {
    ElMessage.warning('仅支持 10 MiB 以内的普通文本文件，不支持符号链接')
    return
  }
  opening.value = true
  try { await external.open({ sessionId, path: entry.path, hostName: hosts.byId(props.tab.hostId)?.name || props.tab.title }) }
  finally { opening.value = false }
}

function goUp(): void {
  load(parent(cwd.value))
}

async function onNewDir(): Promise<void> {
  const sid = props.tab.session?.session_id
  if (!sid) return
  const { value } = await ElMessageBox.prompt('目录名称', '新建目录', { inputPattern: /\S+/ })
  const path = join(cwd.value, value)
  await fileApi.mkdir(sid, path)
  ElMessage.success('已创建')
  notifyLan(path, 'created')
  await refresh()
}

async function onNewFile(): Promise<void> {
   const sid = props.tab.session?.session_id
   if (!sid) return
   const { value } = await ElMessageBox.prompt('文件名称', '新建文件', { inputPattern: /\S+/ })
   const newPath = join(cwd.value, value)
   await fileApi.createFile(sid, newPath)
   ElMessage.success('已创建')
   notifyLan(newPath, 'created')
   await refresh()
   const created = entries.value.find(e => e.path === newPath && !e.is_dir)
   if (created) await open(created)
}

async function onDelete(entry: FileEntry): Promise<void> {
  const sid = props.tab.session?.session_id
  if (!sid) return
  await ElMessageBox.confirm(`确认删除「${entry.name}」？`, '删除确认', { type: 'warning' })
  await fileApi.remove(sid, entry.path)
  ElMessage.success('已删除')
  notifyLan(entry.path, 'deleted')
  await refresh()
}

function clearPicked(): void {
  picked.value = []
  selected.value = null
}

async function deletePicked(): Promise<void> {
  const sid = props.tab.session?.session_id
  const rows = pickedEntries.value
  if (!sid || !rows.length) return
  try {
    await ElMessageBox.confirm(
      `确认删除选中的 ${rows.length} 项？文件夹会连同内部内容一起删除。`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
    for (const row of rows) await fileApi.remove(sid, row.path)
    for (const row of rows) notifyLan(row.path, 'deleted')
    ElMessage.success(`已删除 ${rows.length} 项`)
    clearPicked()
    await refresh()
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error((error as Error).message || '删除失败')
  }
}

async function onRename(entry: FileEntry): Promise<void> {
  const sid = props.tab.session?.session_id
  if (!sid) return
  const { value } = await ElMessageBox.prompt('新名称', '重命名', {
    inputValue: entry.name,
    inputPattern: /\S+/
  })
  const newPath = join(cwd.value, value)
  await fileApi.rename(sid, entry.path, newPath)
  ElMessage.success('已重命名')
  notifyLan(newPath, 'renamed')
  await refresh()
}

async function onRowCommand(cmd: string, row: FileEntry): Promise<void> {
  try {
    if (cmd === 'open') await open(row)
    else if (cmd === 'download') await onDownload(row)
    else if (cmd === 'rename') await onRename(row)
    else if (cmd === 'delete') await onDelete(row)
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error((error as Error).message || '操作失败')
  }
}

function openRowMenu(event: MouseEvent, row: FileEntry): void {
  selected.value = row
  const width = 168
  const height = 202
  rowMenu.value = {
    x: Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8)),
    y: Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8)),
    row
  }
}
function closeRowMenu(): void {
  rowMenu.value = null
}
async function runRowMenuCommand(command: string): Promise<void> {
  const row = rowMenu.value?.row
  rowMenu.value = null
  if (!row) return
  if (command === 'copy-path') {
    try { await window.shellHelper.copyText(row.path); ElMessage.success('路径已复制') }
    catch (error) { ElMessage.error((error as Error).message || '复制失败') }
    return
  }
  await onRowCommand(command, row)
}

function localPathOf(file: File): string {
  try {
    return window.shellHelper.getPathForFile(file)
  } catch {
    return ''
  }
}

function chooseRow(event: MouseEvent, row: FileEntry, index: number): void {
  if (event.shiftKey) {
    const anchor = visibleEntries.value.findIndex(item => item.path === (picked.value[0] || selected.value?.path))
    const start = Math.min(anchor < 0 ? index : anchor, index)
    const end = Math.max(anchor < 0 ? index : anchor, index)
    picked.value = visibleEntries.value.slice(start, end + 1).map(item => item.path)
  } else if (event.metaKey || event.ctrlKey) {
    picked.value = picked.value.includes(row.path) ? picked.value.filter(item => item !== row.path) : [...picked.value, row.path]
  } else picked.value = [row.path]
  selected.value = row
}

async function uploadLocalEntries(files: { name: string; path: string; is_dir: boolean }[]): Promise<void> {
  const sid = props.tab.session?.session_id
  const selectedFiles = files.filter(file => !file.is_dir)
  if (!sid || !selectedFiles.length) { ElMessage.info('请选择普通文件；目录同步暂支持逐级打开'); return }
  try {
    await runTransfer(selectedFiles[0].name, async (id) => {
      for (const file of selectedFiles) {
        await uploadOne(id, cwd.value, file.path, file.name, false)
        notifyLan(join(cwd.value, file.name), 'modified')
      }
    }, 'upload')
    ElMessage.success(`已上传 ${selectedFiles.length} 个文件`)
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error((error as Error).message || '上传失败')
  }
}

async function downloadLocalEntries(entriesToDownload: FileEntry[], localDirectory: string): Promise<void> {
  const sid = props.tab.session?.session_id
  const files = entriesToDownload.filter(entry => !entry.is_dir)
  if (!sid || !localDirectory || !files.length) { ElMessage.info('请选择普通文件并先在本地栏选择目录'); return }
  try {
    await runTransfer(files[0].name, async (id) => {
      for (const file of files) {
        await window.shellHelper.downloadTo({ id, sessionId: sid, remotePath: file.path, destPath: `${localDirectory.replace(/[\\/]$/, '')}/${file.name}` })
      }
    }, 'download')
    ElMessage.success(`已下载 ${files.length} 个文件到本地栏目录`)
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error((error as Error).message || '下载失败')
  }
}

async function runTransfer(label: string, work: (id: string) => Promise<void>, direction: TransferDirection = 'upload', resume?: { sessionId: string; remotePath: string; destPath: string }): Promise<void> {
  if (transferring.value) throw new Error('已有传输正在进行，请稍候')
  const id = crypto.randomUUID()
  const startedAt = Date.now()
  transfer.value = { id, label, loaded: 0, total: 0, direction }
  transfers.begin({ id, label, direction, loaded: 0, total: 0, resume })
  transferring.value = true
  try {
    await work(id)
    const current = transfer.value
    recentTransfers.value.unshift({
      id, label: current?.label || label, total: current?.total || 0,
      direction, status: 'done', startedAt
    })
    transfers.complete(id)
  } catch (error) {
    const current = transfer.value
    const message = (error as Error).message || '传输失败'
    recentTransfers.value.unshift({
      id, label: current?.label || label, total: current?.total || 0,
      direction, status: 'error', error: message, startedAt
    })
    transfers.fail(id, message)
    throw error
  } finally {
    recentTransfers.value = recentTransfers.value.slice(0, 8)
    if (transfer.value?.id === id) transfer.value = null
    transferring.value = false
  }
}

async function uploadOne(id: string, directory: string, localPath: string, name: string, overwrite: boolean): Promise<void> {
  const sid = props.tab.session?.session_id
  if (!sid) return
  if (transfer.value) transfer.value.label = name
  try {
    await window.shellHelper.uploadFrom({ id, sessionId: sid, directory, localPath, name, overwrite })
    notifyLan(join(directory, name), 'modified')
  } catch (error) {
    if (!overwrite && (error as Error).message.includes('远程已有同名文件')) {
      await ElMessageBox.confirm(`「${name}」在远程已存在，是否覆盖？`, '覆盖确认', { type: 'warning', confirmButtonText: '覆盖', cancelButtonText: '跳过' })
      await window.shellHelper.uploadFrom({ id, sessionId: sid, directory, localPath, name, overwrite: true })
      notifyLan(join(directory, name), 'modified')
      return
    }
    throw error
  }
}

async function uploadLocal(files: { localPath: string; directory: string; name: string }[]): Promise<void> {
  if (!files.length) return
  const sid = props.tab.session?.session_id
  if (!sid) return
  await runTransfer(files[0].name, async (id) => {
    const made = new Set<string>()
    for (const file of files) {
      const parts = file.directory.split('/').filter(Boolean)
      let current = ''
      for (const part of parts) {
        current += `/${part}`
        if (made.has(current)) continue
        await fileApi.mkdir(sid, current).catch(() => undefined)
        made.add(current)
      }
      try { await uploadOne(id, file.directory, file.localPath, file.name, false) }
      catch (error) {
        if (error === 'cancel' || error === 'close') continue
        throw error
      }
    }
  }, 'upload')
  ElMessage.success(files.length > 1 ? `已上传 ${files.length} 个文件` : '已上传')
  await refresh()
}

async function onUpload(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const files = [...input.files ?? []]
  input.value = ''
  const batch = files.flatMap(file => {
    const localPath = localPathOf(file)
    if (!localPath) return []
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
    const parts = relative.split('/').filter(Boolean)
    const name = parts.pop() || file.name
    const directory = parts.length ? `${cwd.value === '/' ? '' : cwd.value}/${parts.join('/')}` : cwd.value
    return [{ localPath, directory: directory || '/', name }]
  })
  if (files.length && !batch.length) { ElMessage.warning('无法读取本地文件路径'); return }
  try { await uploadLocal(batch) }
  catch (error) {
    const message = (error as Error).message || ''
    if (error !== 'cancel' && error !== 'close' && message !== '已取消') ElMessage.error(message || '上传失败')
  }
}

async function onDropFiles(event: DragEvent): Promise<void> {
  dragActive.value = false
  const files = [...event.dataTransfer?.files ?? []]
  if (!files.length || linkState.value !== 'ok') return
  await onUpload({ target: { files, value: '' } } as unknown as Event)
}

async function saveEntry(entry: { path: string; relative?: string; name?: string }, directory?: string): Promise<void> {
  const sid = props.tab.session?.session_id
  if (!sid) return
  const name = entry.name || entry.relative?.split('/').pop() || 'download'
  const dest = directory
    ? `${directory.replace(/\/$/, '')}/${entry.relative || name}`
    : await window.shellHelper.chooseSavePath(name)
  if (!dest) return
  await runTransfer(name, (id) => window.shellHelper.downloadTo({ id, sessionId: sid, remotePath: entry.path, destPath: dest }), 'download', { sessionId: sid, remotePath: entry.path, destPath: dest })
}

async function onDownload(entry?: FileEntry): Promise<void> {
  const sid = props.tab.session?.session_id
  if (!sid) return
  const targets = entry ? [entry] : visibleEntries.value.filter(item => picked.value.includes(item.path))
  const rows = targets.length ? targets : (selected.value ? [selected.value] : [])
  if (!rows.length) { ElMessage.info('请先选择要下载的文件'); return }
  try {
    if (rows.length === 1 && !rows[0].is_dir) {
      await saveEntry({ path: rows[0].path, name: rows[0].name })
      return
    }
    const directory = await window.shellHelper.chooseDirectory()
    if (!directory) return
    for (const row of rows) {
      const files = row.is_dir
        ? await fileApi.listTree(sid, row.path)
        : [{ path: row.path, relative: row.name, size: row.size }]
      for (const file of files) await saveEntry(file, directory)
    }
    ElMessage.success('下载完成')
  } catch (error) {
    if ((error as Error).message !== '已取消') ElMessage.error((error as Error).message || '下载失败')
  }
}

function cancelTransfer(): void {
  if (transfer.value) void window.shellHelper.cancelTransfer(transfer.value.id)
}

async function openTerminalHere(): Promise<void> {
  const current = host.value
  if (!current || !isTerminalProto(current.protocol)) { ElMessage.info('这个连接没有终端'); return }
  const quoted = `'${cwd.value.replace(/'/g, `'\\''`)}'`
  await sessionStore.openTerminal(current.id, `cd ${quoted}\n`)
}

function readShellDirectory(): void {
  const tab = linkedTerminal.value
  const bridge = tab ? terminalBridges.get(tab.id) : undefined
  if (!tab || !bridge?.queryCwd()) ElMessage.info('请先打开这台主机的终端')
}

async function createFolder(): Promise<void> {
  try { await onNewDir() }
  catch (error) { if (error !== 'cancel' && error !== 'close') ElMessage.error((error as Error).message || '创建失败') }
}

watch(cwd, (path) => { sessionMeta.path[props.tab.id] = path })
watch(() => props.tab.hostId, () => { loadFavorites() })
watch(() => props.visible, (visible) => { if (!visible) transferDrawer.value = false })
watch(shellPath, (path) => {
  if (followTerminal.value && path.startsWith('/') && path !== cwd.value && linkState.value === 'ok') void load(path)
})
onMounted(() => {
  loadTreeWidth()
  loadViewMode()
  loadFavorites()
  window.addEventListener('click', closeRowMenu)
  window.addEventListener('blur', closeRowMenu)
  if (viewMode.value === 'columns' && loaded.value && !loading.value) void buildMillerColumns(cwd.value, entries.value)
  window.addEventListener('resize', scrollMillerToCurrent)
  stopProgress = window.shellHelper.onTransferProgress((event) => {
    if (transfer.value?.id === event.id) {
      transfer.value.loaded = event.loaded
      transfer.value.total = event.total
    }
  })
})

async function createFileAction(): Promise<void> {
  try { await onNewFile() }
  catch (error) { if (error !== 'cancel' && error !== 'close') ElMessage.error((error as Error).message || '创建失败') }
}

watch(
  () => [props.visible, props.tab.session?.session_id, props.tab.connecting] as const,
  ([vis, sessionId, connecting], previous) => {
    if (previous && sessionId !== previous[1]) {
      initialized = false
      loaded.value = false
      entries.value = []
      loadError.value = ''
      expandedTreePaths.value = []
    }
    if (vis && sessionId && !connecting && !initialized) {
      initialized = true
      void load(initialCwd())
    }
  },
  { immediate: true }
)
</script>

<template>
  <div v-show="visible" ref="rootEl" class="file-manager">
    <!-- 工具栏 -->
    <div class="fm-toolbar">
      <div class="nav-btns">
        <button v-if="viewMode === 'list' && !localPaneOpen" class="fm-icon-button" :class="{ active: showTree }" title="切换目录树" aria-label="切换目录树" :aria-pressed="showTree" @click="showTree = !showTree"><el-icon><Fold /></el-icon></button>
        <button class="fm-icon-button" :class="{ active: localPaneOpen }" title="本地/远程双栏" aria-label="本地/远程双栏" :aria-pressed="localPaneOpen" @click="toggleLocalPane"><el-icon><Monitor /></el-icon></button>
        <button class="fm-icon-button" title="上一级目录" aria-label="上一级目录" :disabled="cwd === '/' || loading" @click="goUp"><el-icon><Top /></el-icon></button>
        <button class="fm-icon-button" title="刷新目录" aria-label="刷新目录" :disabled="loading" @click="refresh"><el-icon :class="{ 'is-loading': loading }"><Refresh /></el-icon></button>
        <div class="view-switch" role="group" aria-label="文件视图">
          <button type="button" :class="{ active: viewMode === 'list' }" title="列表视图" aria-label="列表视图" :aria-pressed="viewMode === 'list'" @click="setView('list')"><el-icon><List /></el-icon></button>
          <button type="button" :class="{ active: viewMode === 'columns' }" title="分栏视图" aria-label="分栏视图" :aria-pressed="viewMode === 'columns'" @click="setView('columns')"><el-icon><Grid /></el-icon></button>
        </div>
      </div>
      <div class="path-box" :title="cwd">
        <el-icon class="path-icon"><FolderOpened /></el-icon>
        <form v-if="pathEditing" class="path-form" @submit.prevent="goToPath">
          <input ref="addressInput" v-model="pathInput" aria-label="远程目录路径" @keydown.esc="pathEditing = false" @blur="pathEditing = false" />
        </form>
        <nav v-else class="breadcrumbs" aria-label="目录路径" @dblclick="editPath">
          <button class="path-segment" :aria-current="cwd === '/' ? 'location' : undefined" @click="load('/')">根目录</button>
          <template v-for="segment in breadcrumbs" :key="segment.path">
            <el-icon class="path-divider"><ArrowRight /></el-icon>
            <button class="path-segment" :aria-current="cwd === segment.path ? 'location' : undefined" @click="load(segment.path)">{{ segment.name }}</button>
          </template>
        </nav>
        <button class="path-edit fm-icon-button" title="输入目录路径" aria-label="输入目录路径" @click="editPath"><el-icon><EditPen /></el-icon></button>
      </div>
    </div>

    <div class="fm-workspace">
      <aside v-show="showTree && viewMode === 'list' && !localPaneOpen" class="directory-sidebar" :style="{ width: `${treeWidth}px` }" aria-label="远程目录树">
        <div class="tree-top">
          <div class="tree-heading">
            <span class="tree-title">导航</span>
            <span class="tree-proto" :class="(tab.session?.type || host?.protocol) === 'ftp' ? 'is-ftp' : 'is-sftp'">{{ (tab.session?.type || host?.protocol || '远程').toUpperCase() }}</span>
            <div class="tree-tools">
              <button class="tree-tool" type="button" title="刷新目录树" aria-label="刷新目录树" :disabled="!loaded || loading || linkState !== 'ok'" @click="refresh"><el-icon :class="{ 'is-loading': loading }"><Refresh /></el-icon></button>
              <button class="tree-tool" type="button" title="收起其他分支" aria-label="收起其他分支" :disabled="!loaded" @click="collapseTree"><el-icon><Fold /></el-icon></button>
            </div>
          </div>
          <div class="tree-path-row">
            <button class="tree-path" type="button" :title="`定位当前目录：${cwd}`" :disabled="!loaded" @click="revealCurrent">
              <el-icon><FolderOpened /></el-icon>
              <span>{{ cwd }}</span>
              <el-icon class="tree-locate"><Pointer /></el-icon>
            </button>
            <button class="tree-fav-toggle" :class="{ active: isFavorite(cwd) }" type="button" :title="isFavorite(cwd) ? '取消收藏当前目录' : '收藏当前目录'" :aria-label="isFavorite(cwd) ? '取消收藏当前目录' : '收藏当前目录'" :aria-pressed="isFavorite(cwd)" :disabled="!loaded" @click="toggleFavorite">
              <el-icon><StarFilled v-if="isFavorite(cwd)" /><Star v-else /></el-icon>
            </button>
          </div>
          <div v-if="favorites.length" class="tree-favorites">
            <div class="tree-section-label"><span>收藏</span><span>{{ favorites.length }}</span></div>
            <div v-for="favorite in favorites" :key="favorite.path" class="tree-favorite">
              <button class="tree-favorite-main" type="button" :title="favorite.path" @click="openFavorite(favorite.path)">
                <el-icon><StarFilled /></el-icon><span>{{ favorite.name }}</span>
              </button>
              <button class="tree-fav-remove" type="button" :aria-label="`移除收藏 ${favorite.name}`" @click="removeFavorite(favorite.path)"><el-icon><Close /></el-icon></button>
            </div>
          </div>
          <div class="tree-section-label tree-section-directory"><span>全部目录</span></div>
        </div>
        <el-tree v-if="loaded" :key="treeVersion" ref="tree" class="directory-tree" node-key="path" lazy :load="loadTree" :props="{ label: 'name' }" :default-expanded-keys="expandedPaths" :current-node-key="cwd" :expand-on-click-node="false" highlight-current :indent="12" @node-click="(node: FolderNode) => load(node.path)" @node-expand="(node: FolderNode) => rememberExpanded(node.path)" @node-collapse="(node: FolderNode) => forgetExpanded(node.path)">
          <template #default="{ node, data }">
            <span class="tree-label" :title="data.path">
              <el-icon class="tree-folder"><FolderOpened v-if="node.expanded" /><Folder v-else /></el-icon>
              <span>{{ data.name }}</span>
            </span>
          </template>
        </el-tree>
        <div v-else class="tree-placeholder">
          <el-icon :class="{ 'is-loading': linkState === 'pending' }"><Loading v-if="linkState === 'pending'" /><Connection v-else /></el-icon>
          <span>{{ loadError ? '目录加载失败，请重试' : linkState === 'pending' ? '正在读取目录…' : '连接后显示目录' }}</span>
          <button v-if="loadError" class="tree-retry" type="button" @click="load(attemptedPath)">重试</button>
        </div>
        <div class="tree-host"><el-icon><Connection /></el-icon><span :title="host?.host">{{ host?.host || '远程主机' }}</span><span class="connection-dot" :class="linkState" :title="linkState === 'ok' ? '已连接' : linkState === 'pending' ? '连接中' : '已断开'"></span></div>
      </aside>
      <div v-if="showTree && viewMode === 'list' && !localPaneOpen" class="tree-resizer" role="separator" aria-orientation="vertical" aria-label="调整目录树宽度" :aria-valuenow="treeWidth" :aria-valuemin="TREE_WIDTH_MIN" :aria-valuemax="TREE_WIDTH_MAX" tabindex="0" title="拖动调整目录树宽度，双击复位" @mousedown.prevent="startTreeResize" @dblclick="resetTreeWidth" @keydown="onTreeResizeKey"></div>

      <LocalPane v-if="localPaneOpen" :remote-entries="entries" :remote-path="cwd" @upload="uploadLocalEntries" @download="downloadLocalEntries" @close="localPaneOpen = false" />
      <section class="fm-content" aria-label="远程文件" :class="{ 'is-drag': dragActive }" @dragover.prevent="dragActive = true" @dragleave="dragActive = false" @drop.prevent="onDropFiles">
        <header class="folder-heading">
          <div class="folder-title"><el-icon class="folder-hero"><Folder /></el-icon><div><h2 :title="folderName">{{ folderName }}</h2><p>{{ folders }} 个文件夹<span>·</span>{{ entries.length - folders }} 个文件</p></div></div>
          <div class="fm-actions">
            <input ref="uploadInput" class="upload-input" type="file" multiple aria-label="选择要上传的文件" @change="onUpload" />
            <input ref="directoryInput" class="upload-input" type="file" webkitdirectory multiple aria-label="选择要上传的目录" @change="onUpload" />
            <el-button text :loading="opening" :disabled="!selected || selected.is_dir || loading || !!loadError" :title="settings.hint('openFile') ? `外部打开 ${settings.hint('openFile')}` : '外部打开选中文件'" aria-label="外部打开选中文件" :icon="'TopRight'" @click="selected && open(selected)">外部打开</el-button>
            <el-button type="primary" :icon="'Upload'" :loading="transferring" :disabled="!loaded || loading || !!loadError || linkState !== 'ok'" title="上传文件" aria-label="上传文件" @click="uploadInput?.click()">上传</el-button>
            <el-button :icon="'FolderOpened'" :disabled="!loaded || loading || !!loadError || linkState !== 'ok' || transferring" title="上传目录" aria-label="上传目录" @click="directoryInput?.click()">上传目录</el-button>
            <el-button :icon="'Download'" :loading="transferring" :disabled="!loaded || loading || !!loadError || linkState !== 'ok'" title="下载选中项" aria-label="下载选中项" @click="onDownload()">下载</el-button>
            <el-button v-if="host && isTerminalProto(host.protocol)" :icon="'Monitor'" :disabled="linkState !== 'ok'" title="在此目录打开终端" aria-label="在此目录打开终端" @click="openTerminalHere">在此目录打开终端</el-button>
            <el-button :icon="'DocumentAdd'" :disabled="!loaded || loading || !!loadError" title="新建文件" aria-label="新建文件" @click="createFileAction">新建文件</el-button>
            <el-button :icon="'FolderAdd'" :disabled="!loaded || loading || !!loadError" title="新建文件夹" aria-label="新建文件夹" @click="createFolder">新建文件夹</el-button>
          </div>
        </header>
        <div class="file-controls">
          <span class="list-label">{{ viewMode === 'columns' ? '分栏' : '文件' }} <span>{{ viewMode === 'columns' ? entries.length : visibleEntries.length }}</span></span>
          <button v-if="linkedTerminal" class="follow-toggle" type="button" :aria-pressed="followTerminal" @click="followTerminal = !followTerminal">{{ followTerminal ? '正在跟随终端' : '跟随终端目录' }}</button>
          <button v-if="linkedTerminal" class="follow-toggle" type="button" @click="readShellDirectory">读取终端目录</button>
          <el-input v-if="viewMode === 'list'" v-model="query" class="file-search" :prefix-icon="'Search'" clearable placeholder="筛选当前目录…" aria-label="筛选当前目录" />
        </div>
        <div v-if="pickedCount > 1" class="batch-bar" role="status">
          <span>已选 {{ pickedCount }} 项</span>
          <button type="button" @click="onDownload()">下载</button>
          <button type="button" @click="deletePicked">删除</button>
          <button type="button" @click="clearPicked">取消选择</button>
        </div>
        <!-- 加载失败 -->
        <div v-if="loadError" class="fm-error" role="alert">
          <el-icon :size="32"><WarningFilled /></el-icon><p class="fm-error-title">无法打开此目录</p>
          <p class="fm-error-msg">{{ attemptedPath }} — {{ loadError }}</p>
          <div class="error-actions"><el-button :icon="'Refresh'" @click="load(attemptedPath)">重试</el-button><el-button v-if="linkState !== 'ok'" @click="sessionStore.reconnect(tab.id)">重新连接</el-button></div>
        </div>
        <!-- Miller columns -->
        <div v-else-if="viewMode === 'columns'" ref="millerScroll" class="miller-view" aria-label="分栏目录视图">
          <div v-if="!millerColumns.length" class="miller-view-empty">正在准备分栏视图…</div>
          <section v-for="(column, index) in millerColumns" :key="column.path" class="miller-column" :class="{ current: column.path === cwd }" :aria-label="`第 ${index + 1} 列：${column.path}`">
            <header class="miller-head">
              <el-icon><FolderOpened /></el-icon>
              <span class="miller-head-name" :title="column.path">{{ millerLabel(column.path) }}</span>
              <span class="miller-count">{{ column.entries.length }}</span>
            </header>
            <div class="miller-body">
              <div v-if="column.loading" class="miller-state"><el-icon class="is-loading"><Loading /></el-icon><span>加载中…</span></div>
              <div v-else-if="column.error" class="miller-state miller-state-error"><el-icon><WarningFilled /></el-icon><span>加载失败</span><button type="button" @click="buildMillerColumns()">重试</button></div>
              <template v-else>
                <button
                  v-for="entry in column.entries"
                  :key="entry.path"
                  type="button"
                  class="miller-row"
                  :class="{ active: millerActive(column, entry), 'is-hidden': entry.name.startsWith('.') }"
                  :title="`${entry.name}\n${entry.path}`"
                  @click="onMillerClick(column, entry)"
                  @dblclick="onMillerDouble(entry)"
                  @keydown="onMillerKey($event, column, entry)"
                >
                  <el-icon v-if="entry.is_dir" class="miller-folder"><FolderOpened v-if="cwd === entry.path || cwd.startsWith(entry.path + '/')" /><Folder v-else /></el-icon>
                  <span v-else class="file-glyph miller-file" :class="fileKind(entry).tone"><el-icon><component :is="fileKind(entry).icon" /></el-icon></span>
                  <span class="miller-name">{{ entry.name }}</span>
                  <el-icon v-if="entry.is_dir" class="miller-arrow"><ArrowRight /></el-icon>
                </button>
                <p v-if="!column.entries.length" class="miller-state">空文件夹</p>
              </template>
            </div>
          </section>
        </div>
        <!-- 文件表 -->
        <div v-else v-loading="loading" class="fm-table-wrap" :aria-busy="loading">
          <div class="file-list" role="grid" aria-label="目录内容" :aria-rowcount="visibleEntries.length + 1" :aria-colcount="4">
            <div class="file-columns" role="row">
              <button type="button" role="columnheader" :aria-sort="ariaSort('name')" @click="toggleSort('name')">名称 <el-icon v-if="sortKey === 'name'"><component :is="sortDir === 1 ? 'Top' : 'Bottom'" /></el-icon></button>
              <button type="button" role="columnheader" :aria-sort="ariaSort('mtime')" @click="toggleSort('mtime')">修改时间 <el-icon v-if="sortKey === 'mtime'"><component :is="sortDir === 1 ? 'Top' : 'Bottom'" /></el-icon></button>
              <button type="button" role="columnheader" class="f-size" :aria-sort="ariaSort('size')" @click="toggleSort('size')">大小 <el-icon v-if="sortKey === 'size'"><component :is="sortDir === 1 ? 'Top' : 'Bottom'" /></el-icon></button>
              <span role="columnheader" aria-label="操作"></span>
            </div>
            <div class="file-rows" role="rowgroup">
              <div v-for="(row, index) in visibleEntries" :key="row.path" class="fm-row" :class="{ selected: selected?.path === row.path || picked.includes(row.path), 'is-hidden': row.name.startsWith('.') }" role="row" :aria-selected="picked.includes(row.path)" :tabindex="selected ? (selected.path === row.path ? 0 : -1) : (index === 0 ? 0 : -1)" :title="`${row.name}\n${row.mode}\n${fmtTime(row.mtime)}`" @click="chooseRow($event, row, index)" @focus="selected = row" @dblclick="open(row)" @contextmenu.prevent.stop="openRowMenu($event, row)" @keydown="onFileKey($event, row)">
                <div class="f-name" role="gridcell">
                  <el-icon v-if="row.is_dir" class="folder-icon"><Folder /></el-icon>
                  <span v-else class="file-glyph" :class="fileKind(row).tone" aria-hidden="true"><el-icon><component :is="fileKind(row).icon" /></el-icon></span>
                  <span class="file-name-text">{{ row.name }}</span><el-icon v-if="row.is_dir" class="folder-arrow"><ArrowRight /></el-icon>
                </div>
                <span class="f-time" role="gridcell">{{ fmtTime(row.mtime) }}</span>
                <span class="f-size" role="gridcell">{{ row.is_dir ? '—' : fmtSize(row.size) }}</span>
                <div role="gridcell" @dblclick.stop>
                  <el-dropdown trigger="click" @command="(command: string) => onRowCommand(command, row)">
                    <button class="row-more fm-icon-button" :aria-label="`${row.name} 的更多操作`" :disabled="loading" @click.stop="selected = row"><el-icon><MoreFilled /></el-icon></button>
                    <template #dropdown><el-dropdown-menu>
                      <el-dropdown-item command="open" :icon="row.is_dir ? 'FolderOpened' : 'TopRight'">{{ row.is_dir ? '打开文件夹' : '外部打开' }}</el-dropdown-item>
                      <el-dropdown-item v-if="!row.is_dir" command="download" :icon="'Download'">下载</el-dropdown-item>
                      <el-dropdown-item command="rename" :icon="'Edit'">重命名</el-dropdown-item>
                      <el-dropdown-item command="delete" divided :icon="'Delete'" style="color: var(--sh-danger)">删除</el-dropdown-item>
                    </el-dropdown-menu></template>
                  </el-dropdown>
                </div>
              </div>
            </div>
          </div>
          <div v-if="!visibleEntries.length" class="fm-blank">
            <el-icon :size="36"><component :is="query ? 'Search' : 'FolderOpened'" /></el-icon>
            <strong>{{ !loaded ? '正在连接并加载目录…' : query ? '没有匹配的文件' : '这个文件夹还是空的' }}</strong>
            <span>{{ query ? '换个关键词，或清除筛选查看全部文件' : '双击文件夹进入，双击文本文件使用外部编辑器打开' }}</span>
            <el-button v-if="query" text @click="query = ''">清除筛选</el-button>
          </div>
        </div>
      </section>
    </div>
    <!-- 底部统计 -->
    <div v-if="!tab.connecting && linkState === 'off'" class="fm-recovery" role="alert">
      <span>{{ tab.error || '文件连接已断开' }}</span>
      <button type="button" @click="sessionStore.reconnect(tab.id)">重新连接</button>
      <button type="button" @click="sessionStore.close(tab.id)">关闭标签</button>
    </div>
    <footer class="fm-status" role="status">
      <span class="protocol-badge" :class="(tab.session?.type || host?.protocol) === 'ftp' ? 'proto-ftp' : 'proto-sftp'">{{ (tab.session?.type || host?.protocol || 'sftp').toUpperCase() }}</span>
      <span class="status-detail" v-if="transfer">{{ transferLabel }}</span>
      <span class="status-detail" v-else-if="opening">正在下载并打开…</span>
      <span class="status-detail" v-else-if="editState" :title="editState.message">{{ EDIT_STATUS[editState.status] }} {{ editState.message }}</span>
      <span class="status-detail" v-else-if="selected" :title="selected.path">{{ selected.name }} <span class="status-kind">{{ fileKind(selected).label }} · {{ selected.mode }}</span></span>
      <span class="status-detail" v-else>双击打开 · Enter 进入 · 可拖入文件上传</span>
      <button v-if="transfer || recentTransfers.length" class="follow-toggle" type="button" @click="transferDrawer = true">{{ transfer ? '传输详情' : '传输记录' }}</button>
      <button v-if="transfer" class="follow-toggle" type="button" @click="cancelTransfer">取消传输</button>
      <span class="status-count">{{ query ? `${visibleEntries.length} / ` : '' }}{{ entries.length }} 项</span>
    </footer>
    <Teleport to="body">
      <div v-if="rowMenu" class="fm-row-context" role="menu" aria-label="文件操作" :style="{ left: rowMenu.x + 'px', top: rowMenu.y + 'px' }" @click.stop>
        <button type="button" role="menuitem" @click="runRowMenuCommand('open')">{{ rowMenu.row.is_dir ? '打开文件夹' : '外部打开' }}</button>
        <button v-if="!rowMenu.row.is_dir" type="button" role="menuitem" @click="runRowMenuCommand('download')">下载</button>
        <button type="button" role="menuitem" @click="runRowMenuCommand('rename')">重命名</button>
        <button type="button" role="menuitem" @click="runRowMenuCommand('copy-path')">复制路径</button>
        <button type="button" role="menuitem" class="is-danger" @click="runRowMenuCommand('delete')">删除</button>
      </div>
    </Teleport>
    <el-drawer v-model="transferDrawer" title="传输" size="360px" append-to-body>
      <div v-if="transfer" class="transfer-active">
        <div class="transfer-active-head"><strong>{{ transfer.direction === 'upload' ? '正在上传' : '正在下载' }}</strong><span>{{ transferPercent }}%</span></div>
        <p class="transfer-name" :title="transfer.label">{{ transfer.label }}</p>
        <el-progress :percentage="transferPercent" :show-text="false" :stroke-width="6" />
        <div class="transfer-meta"><span>{{ fmtSize(transfer.loaded) }}<template v-if="transfer.total"> / {{ fmtSize(transfer.total) }}</template></span><el-button text @click="cancelTransfer">取消</el-button></div>
      </div>
      <p v-if="!transfer && !recentTransfers.length" class="transfer-empty">暂无传输记录。上传或下载文件后，进度会显示在这里。</p>
      <div v-for="item in recentTransfers" :key="item.id" class="transfer-history" :class="item.status">
        <span class="transfer-kind" aria-hidden="true"><el-icon><Upload v-if="item.direction === 'upload'" /><Download v-else /></el-icon></span>
        <div class="transfer-body"><strong>{{ item.label }}</strong><small>{{ item.error || (item.status === 'done' ? '已完成' : '失败') }} · {{ fmtSize(item.total) }}</small></div>
        <time>{{ new Date(item.startedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }}</time>
      </div>
      <template v-if="recentTransfers.length" #footer>
        <el-button text @click="recentTransfers = []">清空记录</el-button>
      </template>
    </el-drawer>
  </div>
</template>

<style scoped>
.file-manager { flex: 1; display: flex; flex-direction: column; min-height: 0; min-width: 0; background: var(--sh-bg-panel); container-type: inline-size; }
.fm-toolbar { display: flex; align-items: center; gap: 14px; padding: 12px 18px; background: var(--sh-bg-elevated); border-bottom: 1px solid var(--sh-border); }
.nav-btns, .fm-actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
.fm-actions { flex-shrink: 1; flex-wrap: wrap; justify-content: flex-end; max-width: 100%; }
.fm-icon-button { display: inline-grid; place-items: center; width: 30px; height: 30px; border: 0; border-radius: 6px; background: transparent; color: var(--sh-text-secondary); cursor: pointer; flex-shrink: 0; }
.fm-icon-button:hover:not(:disabled), .fm-icon-button.active { background: var(--sh-bg-hover); color: var(--sh-accent); }
.fm-icon-button:disabled { opacity: .35; cursor: default; }
.path-box { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; height: 34px; padding: 0 5px 0 12px; border: 1px solid var(--sh-border); border-radius: 8px; background: var(--sh-bg-panel); }
.path-icon { color: var(--sh-text-muted); flex-shrink: 0; }
.breadcrumbs { display: flex; align-items: center; gap: 7px; flex: 1; overflow-x: auto; white-space: nowrap; scrollbar-width: none; }
.path-segment { border: 0; padding: 5px 4px; border-radius: 4px; background: transparent; color: var(--sh-text-secondary); font-size: 12px; cursor: pointer; flex-shrink: 0; }
.path-segment:hover { background: var(--sh-bg); color: var(--sh-accent); }
.path-segment[aria-current] { color: var(--sh-text); font-weight: 600; }
.path-divider { font-size: 10px; color: var(--sh-path-divider); flex-shrink: 0; }
.path-edit { width: 26px; height: 26px; color: var(--sh-text-muted); }
.path-form { flex: 1; min-width: 0; }
.path-form input { width: 100%; border: 0; outline: 0; color: var(--sh-text); background: transparent; font: 12px var(--sh-font-mono); user-select: text; }
.path-box:focus-within { border-color: var(--sh-accent); }
.view-switch { flex-shrink: 0; display: flex; align-items: center; gap: 1px; height: 32px; padding: 2px; border: 1px solid var(--sh-border); border-radius: 7px; background: var(--sh-bg); }
.view-switch button { width: 26px; height: 26px; display: grid; place-items: center; border: 0; border-radius: 5px; background: transparent; color: var(--sh-text-muted); font-size: 13px; cursor: pointer; }
.view-switch button:hover { color: var(--sh-text); }
.view-switch button.active { background: var(--sh-bg-panel); color: var(--sh-accent); box-shadow: 0 0 0 1px var(--sh-border); }
.view-switch button:focus-visible { outline: 2px solid var(--sh-accent); outline-offset: 1px; }
.fm-workspace { display: flex; flex: 1; min-height: 0; background: var(--sh-bg); }
.directory-sidebar { box-sizing: border-box; display: flex; flex-direction: column; padding: 10px 8px; margin: 10px 0 10px 10px; flex-shrink: 0; min-width: 0; overflow: hidden; border: 1px solid var(--sh-tree-border); border-radius: 12px; background: var(--sh-bg-panel); box-shadow: 0 1px 2px rgba(15, 17, 21, 0.03); }
.tree-top { flex-shrink: 0; padding: 0 2px; }
.tree-heading { display: flex; align-items: center; gap: 6px; padding: 0 4px 8px; color: var(--sh-text-secondary); }
.tree-title { font-size: 12px; font-weight: 600; color: var(--sh-text); }
.tree-proto { height: 16px; display: inline-flex; align-items: center; padding: 0 4px; border: 1px solid var(--sh-border); border-radius: 4px; color: var(--sh-sftp); font: 600 8px var(--sh-font-mono); letter-spacing: 0.04em; }
.tree-proto.is-ftp { color: var(--sh-ftp); }
.tree-tools { margin-left: auto; display: flex; align-items: center; gap: 1px; }
.tree-tool { width: 22px; height: 22px; display: grid; place-items: center; border: 0; border-radius: 5px; background: transparent; color: var(--sh-text-muted); font-size: 12px; cursor: pointer; }
.tree-tool:hover:not(:disabled) { background: var(--sh-bg-hover); color: var(--sh-text); }
.tree-tool:disabled { opacity: 0.35; cursor: not-allowed; }
.tree-tool:focus-visible { outline: 2px solid var(--sh-accent); outline-offset: 1px; }
.tree-path-row { display: flex; align-items: center; gap: 4px; margin: 0 0 7px; }
.tree-path { flex: 1; min-width: 0; height: 28px; display: flex; align-items: center; gap: 6px; padding: 0 7px; border: 1px solid var(--sh-border); border-radius: 6px; background: var(--sh-bg-panel); color: var(--sh-text-muted); font: 10px var(--sh-font-mono); text-align: left; cursor: pointer; }
.tree-path > span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tree-path:hover:not(:disabled) { border-color: var(--sh-border-strong); color: var(--sh-text); }
.tree-fav-toggle { width: 28px; height: 28px; flex-shrink: 0; display: grid; place-items: center; border: 1px solid var(--sh-border); border-radius: 6px; background: var(--sh-bg-panel); color: var(--sh-text-muted); font-size: 13px; cursor: pointer; }
.tree-fav-toggle:hover:not(:disabled) { border-color: var(--sh-border-strong); color: var(--sh-warning); }
.tree-fav-toggle.active { border-color: var(--sh-warning-border, var(--sh-border-strong)); color: var(--sh-warning); background: var(--sh-warning-bg); }
.tree-fav-toggle:disabled { opacity: 0.45; cursor: default; }
.tree-fav-toggle:focus-visible { outline: 2px solid var(--sh-accent); outline-offset: 1px; }
.tree-path:disabled { opacity: 0.55; cursor: default; }
.tree-locate { flex-shrink: 0; font-size: 11px; opacity: 0; transition: opacity 0.12s ease; }
.tree-path:hover .tree-locate, .tree-path:focus-visible .tree-locate { opacity: 1; }
.directory-tree { flex: 1; overflow: auto; padding: 0 2px; background: transparent; --el-tree-node-hover-bg-color: var(--sh-tree-hover); --el-tree-text-color: var(--sh-text-secondary); }
.directory-tree :deep(.el-tree-node__content) { height: 32px; margin: 1px 0; padding-right: 7px; border-radius: 6px; }
.directory-tree :deep(.el-tree-node.is-current > .el-tree-node__content) { background: var(--sh-tree-current); color: var(--sh-tree-current-text); font-weight: 600; box-shadow: inset 2px 0 var(--sh-accent); }
.directory-tree :deep(.el-tree-node__expand-icon) { color: var(--sh-tree-arrow); padding: 5px; font-size: 12px; }
.directory-tree :deep(.el-tree-node__expand-icon.is-leaf) { color: transparent; }
.tree-label { display: flex; align-items: center; gap: 8px; min-width: 0; padding-right: 6px; font-size: 12px; }
.tree-label > span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tree-section-label { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 6px 3px; color: var(--sh-text-muted); font-size: 10px; font-weight: 600; letter-spacing: 0.04em; }
.tree-section-label > span:last-child { font: 9px var(--sh-font-mono); font-weight: 400; opacity: 0.7; }
.tree-section-directory { margin-top: 4px; }
.tree-favorites { max-height: 128px; overflow: auto; padding: 0 1px 2px; }
.tree-favorite { display: flex; align-items: center; gap: 1px; }
.tree-favorite-main { min-width: 0; flex: 1; height: 27px; display: flex; align-items: center; gap: 7px; padding: 0 7px; border: 0; border-radius: 6px; background: transparent; color: var(--sh-text-secondary); font-size: 11px; text-align: left; cursor: pointer; }
.tree-favorite-main:hover { background: var(--sh-bg-hover); color: var(--sh-text); }
.tree-favorite-main .el-icon { flex-shrink: 0; color: var(--sh-warning); font-size: 11px; }
.tree-favorite-main span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tree-fav-remove { width: 22px; height: 22px; flex-shrink: 0; display: grid; place-items: center; border: 0; border-radius: 5px; background: transparent; color: var(--sh-text-muted); font-size: 10px; opacity: 0.55; cursor: pointer; }
.tree-fav-remove:hover { background: var(--sh-bg-hover); color: var(--sh-danger); opacity: 1; }
.tree-fav-remove:focus-visible { outline: 2px solid var(--sh-accent); outline-offset: 1px; opacity: 1; }
.tree-placeholder { flex: 1; display: flex; align-items: flex-start; gap: 8px; padding: 10px 8px; color: var(--sh-text-muted); font-size: 11px; line-height: 1.6; }
.tree-placeholder .el-icon { margin-top: 2px; font-size: 14px; }
.tree-retry { margin-left: auto; padding: 0; border: 0; background: transparent; color: var(--sh-accent); font-size: 11px; cursor: pointer; }
.tree-host { display: flex; align-items: center; gap: 7px; color: var(--sh-text-muted); font-size: 10px; border-top: 1px solid var(--sh-border); padding: 12px 6px 0; margin-top: 10px; }
.tree-host > span:first-of-type { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tree-resizer { width: 5px; margin-left: 1px; flex-shrink: 0; position: relative; z-index: 2; cursor: col-resize; background: transparent; outline: none; }
.tree-resizer::before { content: ''; position: absolute; top: calc(50% - 12px); left: 2px; width: 1px; height: 24px; border-radius: 1px; background: var(--sh-border-strong); opacity: 0.55; }
.tree-resizer::after { content: ''; position: absolute; top: 12%; bottom: 12%; left: 2px; width: 1px; border-radius: 1px; background: transparent; transition: background 0.12s ease; }
.tree-resizer:hover, .tree-resizer:focus-visible { background: var(--sh-accent-soft); }
.tree-resizer:hover::before, .tree-resizer:focus-visible::before { opacity: 0; }
.tree-resizer:hover::after, .tree-resizer:focus-visible::after { left: 1.5px; width: 2px; background: var(--sh-accent); }
.connection-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--sh-text-muted); }
.connection-dot.ok { background: var(--sh-success); }
.connection-dot.pending { background: var(--sh-warning); }
.tree-folder, .folder-icon, .folder-hero { flex-shrink: 0; color: var(--sh-accent); }
.folder-hero { font-size: 28px; }
.folder-icon, .tree-folder { font-size: 16px; }
.fm-content { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; padding: 0 22px; background: var(--sh-bg-panel); }
.folder-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 26px 0 22px; flex-wrap: wrap; }
.folder-title { display: flex; align-items: center; gap: 14px; min-width: 0; flex: 1; }
.folder-title > div { min-width: 0; }
.folder-title h2 { margin: 0 0 6px; font-size: 21px; font-weight: 650; letter-spacing: -.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.folder-title p { margin: 0; font-size: 11px; color: var(--sh-text-muted); white-space: nowrap; }
.folder-title p span { margin: 0 7px; }
.fm-actions :deep(.el-button) { margin-left: 0; font-size: 12px; }
.file-controls { display: flex; align-items: center; justify-content: space-between; padding-bottom: 14px; gap: 12px; flex-wrap: wrap; }
.list-label { font-size: 12px; color: var(--sh-text-secondary); font-weight: 600; white-space: nowrap; }
.list-label > span { display: inline-block; margin-left: 5px; padding: 2px 6px; background: var(--sh-count-bg); border-radius: 5px; font-size: 11px; font-weight: 500; color: var(--sh-text-muted); }
.file-search { max-width: 218px; font-size: 12px; }
.file-search :deep(.el-input__wrapper) { background: var(--sh-search-bg) !important; box-shadow: none !important; }
.upload-input { display: none; }
.miller-view { flex: 1; min-height: 0; display: flex; overflow-x: auto; overflow-y: hidden; border-top: 1px solid var(--sh-border); background: var(--sh-bg-panel); scrollbar-width: thin; }
.miller-view::-webkit-scrollbar { height: 6px; }
.miller-column { width: 230px; flex-shrink: 0; min-height: 0; display: flex; flex-direction: column; border-right: 1px solid var(--sh-border); }
.miller-column:last-child { border-right: 0; }
.miller-head { height: 38px; flex-shrink: 0; display: flex; align-items: center; gap: 7px; padding: 0 12px; border-bottom: 1px solid var(--sh-border); background: var(--sh-bg); color: var(--sh-text-secondary); font-size: 11px; }
.miller-column.current .miller-head { background: var(--sh-bg-elevated); color: var(--sh-text); box-shadow: inset 0 -2px var(--sh-accent); }
.miller-head > .el-icon { flex-shrink: 0; color: var(--sh-accent); font-size: 14px; }
.miller-head-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.miller-count { margin-left: auto; color: var(--sh-text-muted); font: 9px var(--sh-font-mono); }
.miller-body { flex: 1; min-height: 0; overflow: auto; padding: 4px; }
.miller-row { width: 100%; height: 32px; display: flex; align-items: center; gap: 8px; padding: 0 8px; border: 0; border-radius: 6px; background: transparent; color: var(--sh-text-secondary); font-size: 12px; text-align: left; cursor: pointer; }
.miller-row:hover { background: var(--sh-bg-hover); color: var(--sh-text); }
.miller-row.active { background: var(--sh-accent-soft); color: var(--sh-text); box-shadow: inset 2px 0 var(--sh-accent); }
.miller-row.is-hidden { opacity: 0.55; }
.miller-row:focus-visible { outline: 2px solid var(--sh-accent); outline-offset: -2px; }
.miller-folder { flex-shrink: 0; color: var(--sh-accent); font-size: 15px; }
.miller-row .miller-file { width: 20px; height: 22px; flex-shrink: 0; display: grid; place-items: center; border: 1px solid var(--sh-file-glyph-border); border-radius: 4px; background: var(--sh-file-glyph-bg); color: var(--sh-file-glyph-color); font-size: 13px; }
.miller-name { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.miller-arrow { flex-shrink: 0; color: var(--sh-text-muted); font-size: 10px; opacity: 0; }
.miller-row:hover .miller-arrow, .miller-row.active .miller-arrow { opacity: 1; }
.miller-state { display: flex; align-items: center; gap: 6px; padding: 12px 9px; color: var(--sh-text-muted); font-size: 11px; line-height: 1.6; }
.miller-state-error { color: var(--sh-danger); flex-wrap: wrap; }
.miller-state button { padding: 0; border: 0; background: transparent; color: var(--sh-accent); font-size: 11px; cursor: pointer; }
.miller-view-empty { flex: 1; display: grid; place-items: center; color: var(--sh-text-muted); font-size: 12px; }
.fm-table-wrap { flex: 1; min-height: 0; overflow: auto; padding-bottom: 12px; }
.file-columns, .fm-row { display: grid; grid-template-columns: minmax(130px, 1fr) 138px 65px 28px; align-items: center; gap: 14px; padding: 0 10px; }
.file-columns { position: sticky; top: 0; z-index: 1; height: 34px; background: var(--sh-bg-panel); color: var(--sh-text-muted); border-top: 1px solid var(--sh-column-line); border-bottom: 1px solid var(--sh-column-line); font-size: 11px; }
.file-columns > button { display: flex; align-items: center; gap: 7px; border: 0; padding: 0; background: transparent; color: inherit; font: inherit; cursor: pointer; text-align: left; }
.file-columns .el-icon { font-size: 10px; }
.file-rows { padding-top: 5px; }
/* 紧凑行高≈ 36px */
.fm-row { min-height: 38px; border: 1px solid transparent; border-radius: 7px; cursor: default; margin: 1px 0; transition: background .12s; content-visibility: auto; contain-intrinsic-size: auto 38px; }
.fm-content.is-drag { outline: 1px dashed var(--sh-accent-border); outline-offset: -8px; }
.follow-toggle { border: 0; background: transparent; color: var(--sh-text-secondary); font-size: 11px; cursor: pointer; }
.follow-toggle[aria-pressed="true"] { color: var(--sh-text); }
.fm-row:hover { background: var(--sh-row-hover); }
.fm-row.selected { background: var(--sh-row-selected); border-color: var(--sh-row-selected-border); }
.fm-row:focus-visible { outline-offset: -2px; }
.f-name { display: flex; align-items: center; gap: 12px; min-width: 0; font-size: 12px; }
.file-name-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.is-hidden .file-name-text { color: var(--sh-text-muted); }
.folder-arrow { opacity: 0; color: var(--sh-text-muted); margin-left: auto; flex-shrink: 0; font-size: 10px; }
.fm-row:hover .folder-arrow { opacity: 1; }
.file-glyph { width: 27px; height: 29px; display: grid; place-items: center; border: 1px solid var(--sh-file-glyph-border); border-radius: 6px; color: var(--sh-file-glyph-color); background: var(--sh-file-glyph-bg); flex-shrink: 0; font-size: 18px; box-sizing: border-box; }
.file-glyph.code { color: var(--sh-file-code); background: var(--sh-file-code-bg); border-color: var(--sh-file-code-border); }
.file-glyph.config { color: var(--sh-file-config); background: var(--sh-file-config-bg); border-color: var(--sh-file-config-border); }
.file-glyph.archive { color: var(--sh-file-archive); background: var(--sh-file-archive-bg); border-color: var(--sh-file-archive-border); }
.file-glyph.image { color: var(--sh-file-image); background: var(--sh-file-image-bg); border-color: var(--sh-file-image-border); }
.f-size { font-size: 11px; color: var(--sh-text-muted); text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.f-time { font-size: 11px; color: var(--sh-text-muted); white-space: nowrap; }
.row-more { width: 26px; height: 26px; opacity: .25; }
.fm-row:hover .row-more, .fm-row:focus-within .row-more, .fm-row.selected .row-more { opacity: 1; }
.fm-error, .fm-blank { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 44px 16px; text-align: center; color: var(--sh-text-muted); font-size: 12px; }
.fm-error { flex: 1; }
.fm-blank > .el-icon { color: var(--sh-blank-icon); margin-bottom: 4px; }
.error-actions, .fm-recovery { display: flex; align-items: center; gap: 8px; }
.fm-recovery { min-height: 36px; padding: 0 16px; border-top: 1px solid var(--sh-border); background: var(--sh-warning-bg); color: var(--sh-warning-text); font-size: 12px; }
.fm-recovery span { flex: 1; }
.fm-recovery button { border: 0; border-radius: 6px; background: transparent; color: var(--sh-text); font-size: 12px; cursor: pointer; }
.fm-blank strong, .fm-error-title { color: var(--sh-text-secondary); font-size: 14px; font-weight: 500; margin: 0; }
.fm-error-msg { max-width: 420px; overflow-wrap: anywhere; margin: 0 0 8px; }
.batch-bar { display: flex; align-items: center; gap: 8px; margin: 0 0 12px; padding: 8px 10px; border: 1px solid var(--sh-accent-border); border-radius: 8px; background: var(--sh-accent-soft); font-size: 12px; color: var(--sh-text-secondary); }
.batch-bar > span { margin-right: auto; }
.batch-bar button { border: 0; background: transparent; color: var(--sh-accent); font-size: 12px; cursor: pointer; }
.batch-bar button:hover { color: var(--sh-text); }
.transfer-active { padding: 4px 2px 18px; border-bottom: 1px solid var(--sh-border); margin-bottom: 8px; }
.transfer-active-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 12px; color: var(--sh-text-secondary); }
.transfer-active-head span { font-family: var(--sh-font-mono); color: var(--sh-text-muted); }
.transfer-name { margin: 10px 0; font-size: 13px; color: var(--sh-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.transfer-meta { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 8px; font: 11px var(--sh-font-mono); color: var(--sh-text-muted); }
.transfer-meta :deep(.el-button) { padding: 0; font-size: 11px; }
.transfer-history { display: flex; align-items: center; gap: 10px; padding: 10px 0; border-bottom: 1px solid var(--sh-border); }
.transfer-kind { width: 28px; height: 28px; display: grid; place-items: center; flex-shrink: 0; border-radius: 7px; background: var(--sh-bg); color: var(--sh-text-secondary); }
.transfer-history.error .transfer-kind { color: var(--sh-danger); }
.transfer-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.transfer-body strong { font-size: 12px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.transfer-body small { font-size: 11px; color: var(--sh-text-muted); }
.transfer-history.error .transfer-body small { color: var(--sh-danger); }
.transfer-history time { font: 11px var(--sh-font-mono); color: var(--sh-text-muted); }
.transfer-empty { margin: 12px 2px; font-size: 12px; line-height: 1.7; color: var(--sh-text-muted); }

.fm-row-context { position: fixed; z-index: 120; min-width: 168px; padding: 4px; border: 1px solid var(--sh-border); border-radius: 8px; background: var(--sh-bg-panel); box-shadow: var(--sh-shadow-pop); }
.fm-row-context button { display: block; width: 100%; padding: 7px 9px; border: 0; border-radius: 5px; background: transparent; color: var(--sh-text-secondary); font-size: 12px; text-align: left; cursor: pointer; }
.fm-row-context button:hover { background: var(--sh-bg-hover); color: var(--sh-text); }
.fm-row-context button.is-danger { color: var(--sh-danger); }
.fm-status { min-height: 34px; flex-shrink: 0; display: flex; align-items: center; gap: 12px; padding: 0 16px; font-size: 11px; color: var(--sh-text-muted); border-top: 1px solid var(--sh-border); background: var(--sh-bg); }
.protocol-badge { font-size: 10px; letter-spacing: .6px; font-weight: 600; }
.protocol-badge.proto-sftp { color: var(--sh-sftp); }
.protocol-badge.proto-ftp { color: var(--sh-ftp); }
.status-detail { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.status-kind { margin-left: 10px; color: var(--sh-text-muted); }
.status-count { margin-left: auto; white-space: nowrap; }
/* 窄窗口只留图标，避免操作按钮被挤成孤立的一行 */
@container (max-width: 900px) {
  .fm-actions { gap: 2px; }
  .fm-actions :deep(.el-button) { padding-inline: 9px; }
  .fm-actions :deep(.el-button > span) { display: none; }
}
@container (max-width: 780px) {
  .directory-sidebar { padding-inline: 6px; }
  .fm-content { padding: 0 14px; }
  .folder-heading { padding-block: 20px 16px; }
  .folder-title h2 { font-size: 18px; }
  .folder-hero { font-size: 22px; }
  .file-columns, .fm-row { grid-template-columns: minmax(100px, 1fr) 65px 26px; gap: 10px; }
  .f-time, .file-columns > :nth-child(2) { display: none; }
}
@container (max-width: 540px) {
  .fm-toolbar { padding-inline: 10px; gap: 8px; }
  .folder-heading { align-items: flex-start; }
  .fm-actions { flex-wrap: wrap; }
  .folder-title { flex-basis: 100%; }
  .status-kind { display: none; }
}
</style>
