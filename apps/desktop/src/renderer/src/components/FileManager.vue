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
import { fileBridges, sessionMeta, terminalBridges } from '@renderer/utils/workspace'
import { isTerminalProto } from '@renderer/api/types'
import { EDIT_STATUS, MAX_FILE_BYTES } from '../../../shared/external'

const props = defineProps<{ tab: Tab; visible: boolean }>()
const sessionStore = useSessionStore()
const external = useExternalStore()
const settings = useSettingsStore()
const hosts = useHostStore()
const selected = ref<FileEntry | null>(null)
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
onBeforeUnmount(() => { fileBridges.delete(props.tab.id); delete sessionMeta.path[props.tab.id]; stopProgress?.(); requestId++ })

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
const transfer = ref<{ id: string; label: string; loaded: number; total: number } | null>(null)
let stopProgress: (() => void) | undefined
const showTree = ref(true)
const tree = ref<TreeInstance>()
const treeVersion = ref(0)
const pathEditing = ref(false)
const pathInput = ref('')
const addressInput = ref<HTMLInputElement>()
const directoryRequests = new Map<string, Promise<FileEntry[]>>()
let requestId = 0
interface FolderNode { name: string; path: string }
const breadcrumbs = computed(() => cwd.value.split('/').filter(Boolean).map((name, index, all) => ({ name, path: '/' + all.slice(0, index + 1).join('/') })))
const folderName = computed(() => breadcrumbs.value.at(-1)?.name || '根目录')
const expandedPaths = computed(() => ['/', ...breadcrumbs.value.map(segment => segment.path)])
const host = computed(() => hosts.byId(props.tab.hostId))
const visibleEntries = computed(() => entries.value.filter(e => e.name.toLocaleLowerCase().includes(query.value.toLocaleLowerCase())).slice().sort((a, b) => {
  const directory = Number(b.is_dir) - Number(a.is_dir)
  if (directory) return directory
  if (sortKey.value === 'size') return (a.size - b.size) * sortDir.value
  if (sortKey.value === 'mtime') return (a.mtime - b.mtime) * sortDir.value
  return a.name.localeCompare(b.name, undefined, { numeric: true }) * sortDir.value
}))
const linkState = computed(() => props.tab.connecting ? 'pending' : (!props.tab.session || props.tab.session.status === 'closed' || props.tab.error ? 'off' : 'ok'))
const linkedTerminal = computed(() => sessionStore.tabs.find(tab => tab.kind === 'terminal' && tab.hostId === props.tab.hostId))
const shellPath = computed(() => linkedTerminal.value ? sessionMeta.shellPath[linkedTerminal.value.id] || '' : '')
const transferLabel = computed(() => {
  const job = transfer.value
  if (!job) return ''
  if (!job.total) return `${job.label} ${fmtSize(job.loaded)}`
  return `${job.label} ${Math.min(100, Math.round(job.loaded / job.total * 100))}%`
})
function toggleSort(key: 'name' | 'mtime' | 'size'): void {
  if (sortKey.value === key) sortDir.value = sortDir.value === 1 ? -1 : 1
  else { sortKey.value = key; sortDir.value = 1 }
}
const folders = computed(() => entries.value.filter(e => e.is_dir).length)
watch(visibleEntries, list => { if (selected.value && !list.some(e => e.path === selected.value?.path)) selected.value = null })
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
  await fileApi.mkdir(sid, join(cwd.value, value))
  ElMessage.success('已创建')
  await refresh()
}

async function onNewFile(): Promise<void> {
   const sid = props.tab.session?.session_id
   if (!sid) return
   const { value } = await ElMessageBox.prompt('文件名称', '新建文件', { inputPattern: /\S+/ })
   const newPath = join(cwd.value, value)
   await fileApi.createFile(sid, newPath)
   ElMessage.success('已创建')
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
  await refresh()
}

async function onRename(entry: FileEntry): Promise<void> {
  const sid = props.tab.session?.session_id
  if (!sid) return
  const { value } = await ElMessageBox.prompt('新名称', '重命名', {
    inputValue: entry.name,
    inputPattern: /\S+/
  })
  await fileApi.rename(sid, entry.path, join(cwd.value, value))
  ElMessage.success('已重命名')
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

function localPathOf(file: File): string {
  return (file as File & { path?: string }).path || ''
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

async function runTransfer(label: string, work: (id: string) => Promise<void>): Promise<void> {
  const id = crypto.randomUUID()
  transfer.value = { id, label, loaded: 0, total: 0 }
  transferring.value = true
  try { await work(id) }
  finally {
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
  } catch (error) {
    if (!overwrite && (error as Error).message.includes('远程已有同名文件')) {
      await ElMessageBox.confirm(`「${name}」在远程已存在，是否覆盖？`, '覆盖确认', { type: 'warning', confirmButtonText: '覆盖', cancelButtonText: '跳过' })
      await window.shellHelper.uploadFrom({ id, sessionId: sid, directory, localPath, name, overwrite: true })
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
  })
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
  await runTransfer(name, (id) => window.shellHelper.downloadTo({ id, sessionId: sid, remotePath: entry.path, destPath: dest }))
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
watch(shellPath, (path) => {
  if (followTerminal.value && path.startsWith('/') && path !== cwd.value && linkState.value === 'ok') void load(path)
})
onMounted(() => {
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
  <div v-show="visible" class="file-manager">
    <!-- 工具栏 -->
    <div class="fm-toolbar">
      <div class="nav-btns">
        <button class="fm-icon-button" :class="{ active: showTree }" title="切换目录树" aria-label="切换目录树" :aria-pressed="showTree" @click="showTree = !showTree"><el-icon><Fold /></el-icon></button>
        <button class="fm-icon-button" title="上一级目录" aria-label="上一级目录" :disabled="cwd === '/' || loading" @click="goUp"><el-icon><Top /></el-icon></button>
        <button class="fm-icon-button" title="刷新目录" aria-label="刷新目录" :disabled="loading" @click="refresh"><el-icon :class="{ 'is-loading': loading }"><Refresh /></el-icon></button>
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
      <aside v-show="showTree" class="directory-sidebar" aria-label="远程目录树">
        <div class="tree-heading">目录 <span>远程</span></div>
        <el-tree v-if="loaded" :key="treeVersion" ref="tree" class="directory-tree" node-key="path" lazy :load="loadTree" :props="{ label: 'name' }" :default-expanded-keys="expandedPaths" :current-node-key="cwd" :expand-on-click-node="false" highlight-current :indent="14" @node-click="(node: FolderNode) => load(node.path)">
          <template #default="{ node, data }">
            <span class="tree-label" :title="data.path"><el-icon class="tree-folder"><Folder /></el-icon><span>{{ data.name }}</span></span>
          </template>
        </el-tree>
        <p v-else class="tree-placeholder">连接后显示目录</p>
        <div class="tree-host"><el-icon><Connection /></el-icon><span :title="host?.host">{{ host?.host || '远程主机' }}</span><span class="connection-dot" :class="linkState" :title="linkState === 'ok' ? '已连接' : linkState === 'pending' ? '连接中' : '已断开'"></span></div>
      </aside>

      <section class="fm-content" aria-label="远程文件" :class="{ 'is-drag': dragActive }" @dragover.prevent="dragActive = true" @dragleave="dragActive = false" @drop.prevent="onDropFiles">
        <header class="folder-heading">
          <div class="folder-title"><el-icon class="folder-hero"><Folder /></el-icon><div><h2 :title="folderName">{{ folderName }}</h2><p>{{ folders }} 个文件夹<span>·</span>{{ entries.length - folders }} 个文件</p></div></div>
          <div class="fm-actions">
            <input ref="uploadInput" class="upload-input" type="file" multiple aria-label="选择要上传的文件" @change="onUpload" />
            <input ref="directoryInput" class="upload-input" type="file" webkitdirectory multiple aria-label="选择要上传的目录" @change="onUpload" />
            <el-button text :loading="opening" :disabled="!selected || selected.is_dir || loading || !!loadError" :title="settings.hint('openFile')" :icon="'TopRight'" @click="selected && open(selected)">外部打开</el-button>
            <el-button :icon="'Upload'" :loading="transferring" :disabled="!loaded || loading || !!loadError || linkState !== 'ok'" @click="uploadInput?.click()">上传</el-button>
            <el-button :disabled="!loaded || loading || !!loadError || linkState !== 'ok'" @click="directoryInput?.click()">上传目录</el-button>
            <el-button :icon="'Download'" :loading="transferring" :disabled="!loaded || loading || !!loadError || linkState !== 'ok'" @click="onDownload()">下载</el-button>
            <el-button v-if="host && isTerminalProto(host.protocol)" :disabled="linkState !== 'ok'" @click="openTerminalHere">在此目录打开终端</el-button>
            <el-button :icon="'DocumentAdd'" :disabled="!loaded || loading || !!loadError" @click="createFileAction">新建文件</el-button>
            <el-button :icon="'FolderAdd'" :disabled="!loaded || loading || !!loadError" @click="createFolder">新建文件夹</el-button>
          </div>
        </header>
        <div class="file-controls">
          <span class="list-label">文件 <span>{{ visibleEntries.length }}</span></span>
          <button v-if="linkedTerminal" class="follow-toggle" type="button" :aria-pressed="followTerminal" @click="followTerminal = !followTerminal">{{ followTerminal ? '正在跟随终端' : '跟随终端目录' }}</button>
          <button v-if="linkedTerminal" class="follow-toggle" type="button" @click="readShellDirectory">读取终端目录</button>
          <el-input v-model="query" class="file-search" :prefix-icon="'Search'" clearable placeholder="筛选当前目录…" aria-label="筛选当前目录" />
        </div>
        <!-- 加载失败 -->
        <div v-if="loadError" class="fm-error" role="alert">
          <el-icon :size="32"><WarningFilled /></el-icon><p class="fm-error-title">无法打开此目录</p>
          <p class="fm-error-msg">{{ attemptedPath }} — {{ loadError }}</p>
          <div class="error-actions"><el-button :icon="'Refresh'" @click="load(attemptedPath)">重试</el-button><el-button v-if="linkState !== 'ok'" @click="sessionStore.reconnect(tab.id)">重新连接</el-button></div>
        </div>
        <!-- 文件表 -->
        <div v-else v-loading="loading" class="fm-table-wrap" :aria-busy="loading">
          <div class="file-list" role="grid" aria-label="目录内容" :aria-rowcount="visibleEntries.length + 1" :aria-colcount="4">
            <div class="file-columns" role="row">
              <button type="button" role="columnheader" @click="toggleSort('name')">名称 <el-icon v-if="sortKey === 'name'"><component :is="sortDir === 1 ? 'Top' : 'Bottom'" /></el-icon></button>
              <button type="button" role="columnheader" @click="toggleSort('mtime')">修改时间 <el-icon v-if="sortKey === 'mtime'"><component :is="sortDir === 1 ? 'Top' : 'Bottom'" /></el-icon></button>
              <button type="button" role="columnheader" class="f-size" @click="toggleSort('size')">大小 <el-icon v-if="sortKey === 'size'"><component :is="sortDir === 1 ? 'Top' : 'Bottom'" /></el-icon></button>
              <span role="columnheader" aria-label="操作"></span>
            </div>
            <div class="file-rows" role="rowgroup">
              <div v-for="(row, index) in visibleEntries" :key="row.path" class="fm-row" :class="{ selected: selected?.path === row.path || picked.includes(row.path), 'is-hidden': row.name.startsWith('.') }" role="row" :aria-selected="selected?.path === row.path" :tabindex="selected ? (selected.path === row.path ? 0 : -1) : (index === 0 ? 0 : -1)" :title="`${row.name}\n${row.mode}\n${fmtTime(row.mtime)}`" @click="chooseRow($event, row, index)" @focus="selected = row" @dblclick="open(row)" @keydown="onFileKey($event, row)">
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
      <span class="protocol-badge">{{ tab.session?.type.toUpperCase() || 'SFTP' }}</span>
      <span class="status-detail" v-if="opening">正在下载并打开…</span>
      <span class="status-detail" v-else-if="editState" :title="editState.message">{{ EDIT_STATUS[editState.status] }} {{ editState.message }}</span>
      <span class="status-detail" v-else-if="selected" :title="selected.path">{{ selected.name }} <span class="status-kind">{{ fileKind(selected).label }} · {{ selected.mode }}</span></span>
      <span class="status-detail" v-else-if="transfer">{{ transferLabel }}</span>
      <span class="status-detail" v-else>双击打开 · Enter 进入 · 可拖入文件上传</span>
      <button v-if="transfer" class="follow-toggle" type="button" @click="cancelTransfer">取消传输</button>
      <span class="status-count">{{ query ? `${visibleEntries.length} / ` : '' }}{{ entries.length }} 项</span>
    </footer>
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
.fm-workspace { display: flex; flex: 1; min-height: 0; }
.directory-sidebar { display: flex; flex-direction: column; width: clamp(132px, 28%, 220px); padding: 18px 10px 12px; flex-shrink: 0; min-width: 0; background: var(--sh-tree-bg); border-right: 1px solid var(--sh-tree-border); }
.tree-heading { display: flex; justify-content: space-between; padding: 0 10px 16px; font-size: 12px; font-weight: 600; color: var(--sh-text-secondary); }
.tree-heading > span { font-size: 10px; font-weight: 400; color: var(--sh-text-muted); }
.directory-tree { flex: 1; overflow: auto; background: transparent; --el-tree-node-hover-bg-color: var(--sh-tree-hover); --el-tree-text-color: var(--sh-text-secondary); }
.directory-tree :deep(.el-tree-node__content) { height: 34px; border-radius: 6px; margin: 2px 0; }
.directory-tree :deep(.el-tree-node.is-current > .el-tree-node__content) { background: var(--sh-tree-current); color: var(--sh-tree-current-text); font-weight: 600; }
.directory-tree :deep(.el-tree-node__expand-icon) { color: var(--sh-tree-arrow); padding: 6px; }
.directory-tree :deep(.el-tree-node__expand-icon.is-leaf) { color: transparent; }
.tree-label { display: flex; align-items: center; gap: 9px; min-width: 0; padding-right: 10px; font-size: 12px; }
.tree-label > span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tree-placeholder { color: var(--sh-text-muted); font-size: 12px; padding: 0 10px; flex: 1; }
.tree-host { display: flex; align-items: center; gap: 7px; color: var(--sh-text-muted); font-size: 10px; border-top: 1px solid var(--sh-border); padding: 14px 8px 0; margin-top: 12px; }
.tree-host > span:first-of-type { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.connection-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--sh-text-muted); }
.connection-dot.ok { background: var(--sh-success); }
.connection-dot.pending { background: var(--sh-warning); }
.tree-folder, .folder-icon, .folder-hero { flex-shrink: 0; color: var(--sh-ftp); }
.folder-hero { font-size: 28px; }
.folder-icon, .tree-folder { font-size: 16px; }
.fm-content { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; padding: 0 22px; }
.folder-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 26px 0 22px; flex-wrap: wrap; }
.folder-title { display: flex; align-items: center; gap: 14px; min-width: 0; flex: 1; }
.folder-title > div { min-width: 0; }
.folder-title h2 { margin: 0 0 6px; font-size: 21px; font-weight: 650; letter-spacing: -.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.folder-title p { margin: 0; font-size: 11px; color: var(--sh-text-muted); white-space: nowrap; }
.folder-title p span { margin: 0 7px; }
.fm-actions :deep(.el-button) { margin-left: 0; font-size: 12px; }
.file-controls { display: flex; align-items: center; justify-content: space-between; padding-bottom: 14px; gap: 12px; flex-wrap: wrap; }
.list-label { font-size: 12px; color: var(--sh-text-secondary); font-weight: 600; white-space: nowrap; }
.list-label > span { display: inline-block; margin-left: 5px; padding: 2px 6px; background: var(--sh-count-bg); border-radius: 5px; font-size: 10px; font-weight: 500; color: var(--sh-text-muted); }
.file-search { max-width: 218px; font-size: 12px; }
.file-search :deep(.el-input__wrapper) { background: var(--sh-search-bg) !important; box-shadow: none !important; }
.upload-input { display: none; }
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
.file-glyph { width: 27px; height: 29px; display: grid; place-items: center; border: 1px solid var(--sh-file-glyph-border); border-radius: 4px; color: var(--sh-file-glyph-color); background: var(--sh-file-glyph-bg); flex-shrink: 0; font-size: 18px; box-sizing: border-box; }
.file-glyph.code { color: #6d8fa5; background: #f0f5f8; border-color: #dae6ed; }
.file-glyph.config { color: #8a87aa; background: #f4f2f9; border-color: #e3dfef; }
.file-glyph.archive { color: #ad916a; background: #faf5ec; border-color: #eae1cf; }
.file-glyph.image { color: #6b9b86; background: #f0f7f3; border-color: #d9e8e0; }
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
.fm-status { min-height: 34px; flex-shrink: 0; display: flex; align-items: center; gap: 12px; padding: 0 16px; font-size: 10px; color: var(--sh-text-muted); border-top: 1px solid var(--sh-border); background: var(--sh-bg-elevated); }
.protocol-badge { font-size: 9px; letter-spacing: .6px; font-weight: 600; color: var(--sh-sftp); }
.status-detail { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.status-kind { margin-left: 10px; color: var(--sh-text-muted); }
.status-count { margin-left: auto; white-space: nowrap; }
@container (max-width: 780px) {
  .directory-sidebar { width: clamp(120px, 24%, 160px); padding-inline: 6px; }
  .fm-content { padding: 0 14px; }
  .folder-heading { padding-block: 20px 16px; }
  .folder-title h2 { font-size: 18px; }
  .folder-hero { font-size: 22px; }
  .file-columns, .fm-row { grid-template-columns: minmax(100px, 1fr) 65px 26px; gap: 10px; }
  .f-time, .file-columns > :nth-child(2) { display: none; }
}
@container (max-width: 540px) {
  .directory-sidebar { width: 120px; }
  .fm-toolbar { padding-inline: 10px; gap: 8px; }
  .folder-heading { align-items: flex-start; }
  .fm-actions { flex-wrap: wrap; }
  .folder-title { flex-basis: 100%; }
  .status-kind { display: none; }
}
</style>
