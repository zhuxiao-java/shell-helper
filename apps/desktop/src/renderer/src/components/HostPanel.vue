<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useHostStore } from '@renderer/stores/host'
import { useSettingsStore } from '@renderer/stores/settings'
import * as hostApi from '@renderer/api/hosts'
import type { Host, HostInput, Protocol } from '@renderer/api/types'
import { isTerminalProto, isFileProto } from '@renderer/api/types'

const emit = defineEmits<{
  (e: 'new-host'): void
  (e: 'edit-host', host: Host): void
  (e: 'open-terminal', id: string): void
  (e: 'open-files', id: string): void
  (e: 'open-default', id: string): void
  (e: 'share-host', host: Host): void
  (e: 'tunnel-host', host: Host): void
}>()

const hostStore = useHostStore()
const settings = useSettingsStore()
const { grouped, loading, keyword, error, hosts } = storeToRefs(hostStore)

// 单击选中 / 双击连接
const selectedId = ref('')
function onSelect(h: Host): void {
  selectedId.value = h.id
}

const contextMenu = ref<{ x: number; y: number; host: Host } | null>(null)
function openContextMenu(event: MouseEvent, host: Host): void {
  const width = 178
  const height = 228
  contextMenu.value = {
    x: Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8)),
    y: Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8)),
    host
  }
}
function closeContextMenu(): void {
  contextMenu.value = null
}
async function runContextAction(command: string): Promise<void> {
  const host = contextMenu.value?.host
  contextMenu.value = null
  if (host) await onRowCommand(command, host)
}

// 加载失败后重试
function retryLoad(): void {
  hostStore.refresh().catch(() => undefined)
}

const COLLAPSE_KEY = 'shell-helper:collapsed-groups'
const GROUP_AVATAR_KEY = 'shell-helper:group-avatars'
const groupAvatars = ref<Record<string, string>>({})
const avatarInput = ref<HTMLInputElement>()
const avatarTarget = ref('')
const collapsed = ref<Set<string>>(new Set())
function rememberGroups(): void {
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsed.value])) } catch { /* 隐私模式写入失败不阻断 */ }
}
function loadGroupAvatars(): void {
  try {
    const stored = JSON.parse(localStorage.getItem(GROUP_AVATAR_KEY) || '{}') as unknown
    groupAvatars.value = stored && typeof stored === 'object' ? stored as Record<string, string> : {}
  } catch { groupAvatars.value = {} }
}
function saveGroupAvatars(): void {
  try { localStorage.setItem(GROUP_AVATAR_KEY, JSON.stringify(groupAvatars.value)) } catch { ElMessage.warning('头像已应用，但本地存储空间不足') }
}
function groupInitial(name: string): string {
  return Array.from((name || '?').trim())[0]?.toUpperCase() || '?'
}
function groupTone(name: string): number {
  let sum = 0
  for (const char of name) sum = (sum + char.charCodeAt(0)) % 5
  return sum
}
function hasGroupAvatar(group: string): boolean {
  return !!groupAvatars.value[group]
}
function onGroupAvatarCommand(command: string, group: string): void {
  if (command === 'upload') {
    avatarTarget.value = group
    avatarInput.value?.click()
    return
  }
  if (command === 'remove') {
    const next = { ...groupAvatars.value }
    delete next[group]
    groupAvatars.value = next
    saveGroupAvatars()
    ElMessage.success('已移除分组头像')
  }
}
function onGroupAvatarChange(event: Event): void {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || !avatarTarget.value) return
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) {
    ElMessage.warning('请选择 PNG、JPEG、WebP 或 GIF 图片')
    return
  }
  if (file.size > 512 * 1024) {
    ElMessage.warning('分组头像不能超过 512 KiB')
    return
  }
  const group = avatarTarget.value
  const reader = new FileReader()
  reader.onload = () => {
    if (typeof reader.result !== 'string') return
    groupAvatars.value = { ...groupAvatars.value, [group]: reader.result }
    saveGroupAvatars()
    ElMessage.success('分组头像已更新')
  }
  reader.onerror = () => ElMessage.error('读取头像失败')
  reader.readAsDataURL(file)
}
function toggleGroup(g: string): void {
  const next = new Set(collapsed.value)
  next.has(g) ? next.delete(g) : next.add(g)
  collapsed.value = next
  rememberGroups()
}
function visibleHosts(): Host[] {
  return grouped.value.flatMap((group) => collapsed.value.has(group.group) ? [] : group.items)
}
function moveSelection(delta: number): void {
  const rows = visibleHosts()
  if (!rows.length) return
  const index = Math.max(0, rows.findIndex((item) => item.id === selectedId.value))
  const next = rows[Math.min(rows.length - 1, Math.max(0, index + delta))]
  selectedId.value = next.id
  void nextTick(() => document.querySelector<HTMLElement>(`[data-host-id="${next.id}"]`)?.focus())
}

function hostIcon(protocol: Protocol): string {
  if (protocol === 'local') return 'Monitor'
  if (protocol === 'telnet') return 'Connection'
  if (protocol === 'ftp' || protocol === 'sftp') return 'FolderOpened'
  return 'Cpu'
}

function protoLabel(h: Host): string {
  return h.protocol.toUpperCase()
}

const canTerminal = (h: Host): boolean => isTerminalProto(h.protocol)
const canFiles = (h: Host): boolean => isFileProto(h.protocol)
const searchInput = ref<{ focus(): void }>()
defineExpose({ focusSearch: () => searchInput.value?.focus() })

function toInput(host: Host, group = host.group): HostInput {
  return {
    name: host.name, group, protocol: host.protocol, host: host.host, port: host.port,
    username: host.username, auth_type: host.auth_type, key_path: host.key_path,
    jump_host_ids: [...host.jump_host_ids], tags: host.tags, remote_cwd: host.remote_cwd, password: null
  }
}

const importInput = ref<HTMLInputElement>()
const dropGroup = ref('')

function onDragStart(event: DragEvent, host: Host): void {
  event.dataTransfer?.setData('text/plain', host.id)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

async function onDropGroup(event: DragEvent, group: string): Promise<void> {
  dropGroup.value = ''
  const id = event.dataTransfer?.getData('text/plain') || ''
  const host = hostStore.byId(id)
  if (!host || host.group === group) return
  try { await hostStore.update(id, toInput(host, group)) }
  catch (error) { ElMessage.error((error as Error).message || '无法移动分组') }
}

async function duplicate(host: Host): Promise<void> {
  try {
    await hostStore.create({ ...toInput(host), name: `${host.name} 副本`.slice(0, 200) })
    ElMessage.success('已复制连接，密码需要重新填写')
  } catch (error) { ElMessage.error((error as Error).message || '复制失败') }
}

async function exportHosts(): Promise<void> {
  try {
    const data = await hostApi.exportHosts()
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = 'shell-helper-hosts.json'
    link.click()
    URL.revokeObjectURL(link.href)
  } catch (error) { ElMessage.error((error as Error).message || '导出失败') }
}

async function onImport(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  try {
    const parsed = JSON.parse(await file.text()) as unknown
    if (!Array.isArray(parsed) || !parsed.length) throw new Error('请选择导出的连接 JSON')
    const items = parsed.map((item) => {
      const host = item as Partial<Host>
      if (!host.name || !host.protocol) throw new Error('连接缺少名称或协议')
      return toInput({
        id: '', name: host.name, group: host.group || '默认分组', protocol: host.protocol,
        host: host.host || '', port: host.port || 22, username: host.username || '',
        auth_type: host.auth_type || 'password', credential_id: null, key_path: host.key_path || '',
        jump_host_ids: Array.isArray(host.jump_host_ids) ? host.jump_host_ids : [],
        tags: host.tags || '', remote_cwd: host.remote_cwd || '~'
      })
    })
    await hostApi.importHosts(items)
    await hostStore.refresh()
    ElMessage.success(`已导入 ${items.length} 条连接，密码需要重新填写`)
  } catch (error) { ElMessage.error((error as Error).message || '导入失败') }
}

async function onRowCommand(cmd: string, host: Host): Promise<void> {
  contextMenu.value = null
  if (cmd === 'terminal' && canTerminal(host)) emit('open-terminal', host.id)
  else if (cmd === 'files' && canFiles(host)) emit('open-files', host.id)
  else if (cmd === 'edit') emit('edit-host', host)
  else if (cmd === 'share') emit('share-host', host)
  else if (cmd === 'tunnel') emit('tunnel-host', host)
  else if (cmd === 'duplicate') await duplicate(host)
  else if (cmd === 'del') {
    try {
      await ElMessageBox.confirm(`确认删除主机「${host.name}」？`, '删除确认', {
        type: 'warning',
        confirmButtonText: '删除',
        cancelButtonText: '取消'
      })
      if (selectedId.value === host.id) selectedId.value = ''
      await hostStore.remove(host.id)
    } catch {
      /* 用户取消 */
    }
  }
}

onMounted(() => {
  try {
    const saved = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]') as unknown
    if (Array.isArray(saved)) collapsed.value = new Set(saved.filter((item): item is string => typeof item === 'string'))
  } catch { /* 忽略损坏的折叠记录 */ }
  loadGroupAvatars()
  window.addEventListener('click', closeContextMenu)
  window.addEventListener('blur', closeContextMenu)
  hostStore.refresh().catch(() => undefined)
})
onBeforeUnmount(() => {
  window.removeEventListener('click', closeContextMenu)
  window.removeEventListener('blur', closeContextMenu)
})
</script>

<template>
  <div class="host-panel">
    <button type="button" class="panel-new" @click="emit('new-host')">
      <el-icon><Plus /></el-icon>
      <span>新建连接</span>
      <kbd v-if="settings.hint('newConnection')" class="panel-new-kbd">{{ settings.hint('newConnection') }}</kbd>
    </button>
    <div class="panel-heading">
      <span>连接库 <span class="library-count">{{ hosts.length }}</span></span>
      <div class="heading-actions">
        <el-tooltip content="导出连接">
          <button type="button" class="panel-icon" aria-label="导出连接" @click="exportHosts"><el-icon><Download /></el-icon></button>
        </el-tooltip>
        <el-tooltip content="导入连接">
          <button type="button" class="panel-icon" aria-label="导入连接" @click="importInput?.click()"><el-icon><Upload /></el-icon></button>
        </el-tooltip>
        <input ref="importInput" class="upload-input" type="file" accept="application/json,.json" aria-label="导入连接" @change="onImport" />
        <input ref="avatarInput" class="upload-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" aria-label="选择分组头像" @change="onGroupAvatarChange" />
      </div>
    </div>
    <div class="panel-toolbar">
      <el-input
        ref="searchInput"
        v-model="keyword"
        placeholder="搜索连接…"
        aria-label="搜索主机、IP 或标签"
        clearable
        :prefix-icon="'Search'"
      />
    </div>

    <el-scrollbar class="panel-scroll" v-loading="loading">
      <!-- 加载失败 -->
      <div v-if="error" class="panel-empty">
        <el-icon :size="34"><WarningFilled /></el-icon>
        <p>主机列表加载失败</p>
        <span class="empty-sub">{{ error }}</span>
        <el-button size="small" @click="retryLoad">重试</el-button>
      </div>

      <!-- 暂无主机 -->
      <div v-else-if="!hosts.length" class="panel-empty">
        <el-icon :size="28"><Connection /></el-icon>
        <p>把常用的连接放在这里</p>
        <span class="empty-sub">点击上方「新建连接」添加第一台主机。</span>
      </div>

      <!-- 搜索无匹配 -->
      <div v-else-if="!grouped.length" class="panel-empty">
        <el-icon :size="34"><Search /></el-icon>
        <p>没有匹配「{{ keyword }}」的主机</p>
        <el-button size="small" text @click="keyword = ''">清除搜索</el-button>
      </div>

      <div v-for="g in grouped" v-else :key="g.group" class="group-block">
        <div class="group-head">
          <el-dropdown trigger="click" @command="(command: string) => onGroupAvatarCommand(command, g.group)">
            <button class="group-avatar" :class="`tone-${groupTone(g.group)}`" type="button" :aria-label="`设置分组 ${g.group} 的头像`" :title="hasGroupAvatar(g.group) ? '更换或移除分组头像' : '设置分组头像'">
              <img v-if="hasGroupAvatar(g.group)" :src="groupAvatars[g.group]" :alt="`${g.group} 头像`" />
              <span v-else>{{ groupInitial(g.group) }}</span>
            </button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="upload" :icon="'Picture'">上传分组头像</el-dropdown-item>
                <el-dropdown-item v-if="hasGroupAvatar(g.group)" command="remove" :icon="'Delete'">移除分组头像</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <button class="group-title" :class="{ drop: dropGroup === g.group }" :aria-expanded="!collapsed.has(g.group)" @click="toggleGroup(g.group)" @dragover.prevent="dropGroup = g.group" @dragleave="dropGroup = ''" @drop.prevent="onDropGroup($event, g.group)">
            <el-icon class="caret" :class="{ collapsed: collapsed.has(g.group) }"><ArrowDown /></el-icon>
            <span class="g-name">{{ g.group }}</span>
            <span class="g-count">{{ g.items.length }}</span>
          </button>
        </div>

        <div v-show="!collapsed.has(g.group)">
          <div
            v-for="h in g.items"
            :key="h.id"
            class="host-row"
            :class="{ selected: selectedId === h.id }"
            tabindex="0"
            role="group"
            :data-host-id="h.id"
            draggable="true"
            :aria-label="h.name"
            :title="h.protocol === 'local' ? '此电脑 · 默认 Shell' : `${h.username}@${h.host}:${h.port}`"
            @click="onSelect(h)"
            @dblclick="emit('open-default', h.id)"
            @keydown.enter.self.prevent="emit('open-default', h.id)"
            @keydown.up.self.prevent="moveSelection(-1)"
            @keydown.down.self.prevent="moveSelection(1)"
            @keydown.space.self.prevent="onSelect(h)"
            @dragstart="onDragStart($event, h)"
            @contextmenu.prevent.stop="openContextMenu($event, h)"
          >
          <div class="host-icon" :class="`proto-${h.protocol}`">
            <el-icon><component :is="hostIcon(h.protocol)" /></el-icon>
          </div>
          <div class="host-body">
            <span class="host-name">{{ h.name }}</span>
            <span v-if="h.tags" class="host-tags">{{ h.tags.split(',').map(tag => tag.trim()).filter(Boolean).slice(0, 3).join(' · ') }}</span>
            <span class="host-addr">{{ h.protocol === 'local' ? '此电脑 · 默认 Shell' : `${h.username}@${h.host}:${h.port}` }}</span>
          </div>
          <span class="proto-tag" :class="`proto-${h.protocol}`">{{ protoLabel(h) }}</span>
          <div class="host-actions" @dblclick.stop>
            <button class="act" title="连接" :aria-label="`连接 ${h.name}`" @click.stop="emit('open-default', h.id)"><el-icon><Right /></el-icon></button>
            <el-dropdown trigger="click" @command="(c: string) => onRowCommand(c, h)">
              <button class="act" :aria-label="`${h.name} 的更多操作`" title="更多操作" @click.stop><el-icon><MoreFilled /></el-icon></button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item v-if="canTerminal(h)" command="terminal" :icon="'Cellphone'">打开终端</el-dropdown-item>
                  <el-dropdown-item v-if="canFiles(h)" command="files" :icon="'FolderOpened'">文件管理</el-dropdown-item>
                  <el-dropdown-item command="edit" :icon="'Edit'">编辑</el-dropdown-item>
                  <el-dropdown-item command="duplicate" :icon="'CopyDocument'">复制连接</el-dropdown-item>
                  <el-dropdown-item command="del" divided :icon="'Delete'" class="is-danger">
                    删除
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
        </div>
        </div>
      </div>
    </el-scrollbar>
    <div class="panel-footer"><el-icon><Pointer /></el-icon><span>方向键移动，Enter 或双击连接</span></div>
    <Teleport to="body">
      <div v-if="contextMenu" class="host-context" role="menu" aria-label="主机操作" :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }" @click.stop>
        <button v-if="canTerminal(contextMenu.host)" type="button" role="menuitem" @click="runContextAction('terminal')">打开终端</button>
        <button v-if="canFiles(contextMenu.host)" type="button" role="menuitem" @click="runContextAction('files')">文件管理</button>
        <button type="button" role="menuitem" @click="runContextAction('edit')">编辑连接</button>
        <button v-if="contextMenu.host.protocol !== 'local'" type="button" role="menuitem" @click="runContextAction('share')">分享到局域网</button>
        <button v-if="contextMenu.host.protocol === 'ssh' || contextMenu.host.protocol === 'sftp'" type="button" role="menuitem" @click="runContextAction('tunnel')">端口转发</button>
        <button type="button" role="menuitem" @click="runContextAction('duplicate')">复制连接</button>
        <button type="button" role="menuitem" class="is-danger" @click="runContextAction('del')">删除连接</button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.host-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.panel-new {
  height: 36px;
  margin: 10px 14px 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  flex-shrink: 0;
  border: 1px solid var(--sh-border-strong);
  border-radius: var(--sh-radius-sm);
  background: var(--sh-bg-panel);
  color: var(--sh-text);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  box-shadow: 0 1px 2px rgba(15, 17, 21, 0.04);
  transition: background 0.14s ease, border-color 0.14s ease;
}
.panel-new:hover { background: var(--sh-bg-hover); border-color: var(--sh-text-muted); }
.panel-new-kbd { padding: 1px 4px; border: 1px solid var(--sh-border); border-radius: 4px; background: var(--sh-bg); color: var(--sh-text-muted); font: 10px var(--sh-font-mono); }
.panel-new:active { background: var(--sh-bg-active); }
.panel-heading {
  height: 32px;
  padding: 0 14px 0 18px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--sh-text-muted);
}
.library-count { margin-left: 7px; font: 11px var(--sh-font-mono); color: var(--sh-text-muted); }
.heading-actions { display: flex; align-items: center; gap: 2px; }
.panel-icon {
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--sh-text-muted);
  cursor: pointer;
}
.panel-icon:hover { background: var(--sh-bg-hover); color: var(--sh-text); }
.upload-input { display: none; }
.panel-toolbar {
  display: flex;
  padding: 4px 14px 14px;
}
.panel-toolbar :deep(.el-input__wrapper) {
  background: var(--sh-bg-panel) !important;
  box-shadow: 0 0 0 1px var(--sh-border) inset !important;
  font-size: 12px;
  height: 34px;
}
.panel-toolbar :deep(.el-input__wrapper.is-focus) { box-shadow: 0 0 0 1px var(--sh-accent) inset !important; }
.panel-toolbar .el-input { flex: 1; }
.group-title.drop { background: var(--sh-bg-active); }
.host-tags { display: block; color: var(--sh-text-muted); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.panel-footer {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 14px 18px;
  border-top: 1px solid var(--sh-border);
  font-size: 11px;
  color: var(--sh-text-muted);
}
.panel-scroll {
  flex: 1;
  min-height: 0;
}
.panel-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 48px 16px;
  color: var(--sh-text-muted);
}
.panel-empty p {
  margin: 0;
  font-size: 13px;
}
.empty-sub {
  font-size: 12px;
  color: var(--sh-text-muted);
  max-width: 220px;
  text-align: center;
  word-break: break-all;
}

/* 分组 */
.group-block {
  padding: 0 8px 10px;
}
.group-head {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 0;
}
.group-avatar {
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  overflow: hidden;
  border: 1px solid transparent;
  border-radius: 7px;
  background: var(--sh-accent-soft);
  color: var(--sh-accent);
  font: 600 10px var(--sh-font-ui);
  cursor: pointer;
  transition: transform 0.12s ease, border-color 0.12s ease;
}
.group-avatar:hover { transform: translateY(-1px); border-color: var(--sh-border-strong); }
.group-avatar img { width: 100%; height: 100%; object-fit: cover; }
.group-avatar.tone-1 { background: var(--sh-file-code-bg); color: var(--sh-file-code); }
.group-avatar.tone-2 { background: var(--sh-file-config-bg); color: var(--sh-file-config); }
.group-avatar.tone-3 { background: var(--sh-file-archive-bg); color: var(--sh-file-archive); }
.group-avatar.tone-4 { background: var(--sh-file-image-bg); color: var(--sh-file-image); }
.group-title {
  flex: 1;
  min-width: 0;
  border: 0;
  background: transparent;
  text-align: left;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--sh-text-muted);
  cursor: pointer;
  user-select: none;
  border-radius: var(--sh-radius-sm);
}
.group-title:hover {
  color: var(--sh-text-secondary);
}
.caret {
  font-size: 10px;
  transition: transform 0.16s ease;
}
.caret.collapsed {
  transform: rotate(-90deg);
}
.g-name {
  flex: 1;
}
.g-count {
  color: var(--sh-text-muted);
  padding: 0 4px;
  font-size: 10px;
  line-height: 16px;
}

/* 主机行 */
.host-row {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px;
  margin-bottom: 2px;
  border-radius: var(--sh-radius-sm);
  cursor: pointer;
  position: relative;
  border: 1px solid transparent;
  transition: background 0.14s ease, border-color 0.14s ease;
}
.host-row:hover {
  background: var(--sh-bg-hover);
}
.host-row.selected {
  background: var(--sh-bg-selected);
  border-color: transparent;
}
.host-row:hover .host-actions,
.host-row:focus-within .host-actions,
.host-row.selected .host-actions {
  opacity: 1;
  pointer-events: auto;
}
.host-icon {
  width: 24px;
  height: 32px;
  flex-shrink: 0;
  border-radius: var(--sh-radius);
  display: grid;
  place-items: center;
  background: transparent;
  font-size: 16px;
}
.host-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  line-height: 1.35;
}
.host-name {
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.host-addr {
  margin-top: 3px;
  font: 11px var(--sh-font-mono);
  color: var(--sh-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.proto-tag {
  flex-shrink: 0;
  font: 10px var(--sh-font-mono);
  letter-spacing: 0.3px;
  padding: 2px 3px;
  color: var(--sh-text-muted);
  transition: opacity 0.14s ease;
}
.host-actions {
  position: absolute;
  right: 8px;
  top: 50%;
  z-index: 1;
  display: flex;
  flex-shrink: 0;
  gap: 2px;
  padding: 2px;
  border-radius: 6px;
  background: var(--sh-bg-sidebar);
  opacity: 0;
  pointer-events: none;
  transform: translateY(-50%);
  transition: opacity 0.12s ease;
}
.host-row:hover .host-actions { background: var(--sh-bg-hover); }
.host-row.selected .host-actions { background: var(--sh-bg-selected); }
.host-row:hover .proto-tag,
.host-row.selected .proto-tag,
.host-row:focus-within .proto-tag { opacity: 0; }

.act {
  width: 26px;
  height: 26px;
  border: none;
  border-radius: var(--sh-radius-sm);
  display: grid;
  place-items: center;
  background: transparent;
  color: var(--sh-text-secondary);
  cursor: pointer;
  transition: all 0.12s ease;
}
.act:hover {
  background: var(--sh-accent-soft);
  color: var(--sh-accent);
}

:deep(.el-dropdown-menu__item.is-danger) {
  color: var(--sh-danger);
}
.host-context {
  position: fixed;
  z-index: 40;
  width: 178px;
  padding: 5px;
  border: 1px solid var(--sh-border-strong);
  border-radius: 9px;
  background: var(--sh-bg-panel);
  box-shadow: var(--sh-shadow-pop);
}
.host-context button {
  display: block;
  width: 100%;
  padding: 8px 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--sh-text);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.host-context button:hover { background: var(--sh-bg-hover); }
.host-context button.is-danger { color: var(--sh-danger); }
</style>
