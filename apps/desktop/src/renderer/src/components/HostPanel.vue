<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessageBox } from 'element-plus'
import { useHostStore } from '@renderer/stores/host'
import type { Host, Protocol } from '@renderer/api/types'
import { isTerminalProto, isFileProto } from '@renderer/api/types'

const emit = defineEmits<{
  (e: 'new-host'): void
  (e: 'edit-host', host: Host): void
  (e: 'open-terminal', id: string): void
  (e: 'open-files', id: string): void
  (e: 'open-default', id: string): void
}>()

const hostStore = useHostStore()
const { grouped, loading, keyword, error, hosts } = storeToRefs(hostStore)

// 单击选中 / 双击连接
const selectedId = ref('')
function onSelect(h: Host): void {
  selectedId.value = h.id
}

// 加载失败后重试
function retryLoad(): void {
  hostStore.refresh().catch(() => undefined)
}

// 已折叠的分组名集合
const collapsed = ref<Set<string>>(new Set())
function toggleGroup(g: string): void {
  const next = new Set(collapsed.value)
  next.has(g) ? next.delete(g) : next.add(g)
  collapsed.value = next
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

async function onRowCommand(cmd: string, host: Host): Promise<void> {
  if (cmd === 'terminal' && canTerminal(host)) emit('open-terminal', host.id)
  else if (cmd === 'files' && canFiles(host)) emit('open-files', host.id)
  else if (cmd === 'edit') emit('edit-host', host)
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
  hostStore.refresh().catch(() => undefined)
})
</script>

<template>
  <div class="host-panel">
    <div class="panel-heading">
      <span>连接库 <span class="library-count">{{ hosts.length }}</span></span>
      <el-tooltip content="新建连接">
        <button class="panel-add" aria-label="新建连接" @click="emit('new-host')"><el-icon><Plus /></el-icon></button>
      </el-tooltip>
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
        <span class="empty-sub">常用主机与远程文件，随时切换。</span>
        <el-button text size="small" :icon="'Plus'" @click="emit('new-host')">添加连接</el-button>
      </div>

      <!-- 搜索无匹配 -->
      <div v-else-if="!grouped.length" class="panel-empty">
        <el-icon :size="34"><Search /></el-icon>
        <p>没有匹配「{{ keyword }}」的主机</p>
        <el-button size="small" text @click="keyword = ''">清除搜索</el-button>
      </div>

      <div v-for="g in grouped" v-else :key="g.group" class="group-block">
        <button class="group-title" :aria-expanded="!collapsed.has(g.group)" @click="toggleGroup(g.group)">
          <el-icon class="caret" :class="{ collapsed: collapsed.has(g.group) }"><ArrowDown /></el-icon>
          <span class="g-name">{{ g.group }}</span>
          <span class="g-count">{{ g.items.length }}</span>
        </button>

        <div v-show="!collapsed.has(g.group)">
          <div
            v-for="h in g.items"
            :key="h.id"
            class="host-row"
            :class="{ selected: selectedId === h.id }"
            tabindex="0"
            role="group"
            :aria-label="h.name"
            :title="h.protocol === 'local' ? '此电脑 · 默认 Shell' : `${h.username}@${h.host}:${h.port}`"
            @click="onSelect(h)"
            @dblclick="emit('open-default', h.id)"
            @keydown.enter.self.prevent="emit('open-default', h.id)"
            @keydown.space.self.prevent="onSelect(h)"
          >
          <div class="host-icon" :class="`proto-${h.protocol}`">
            <el-icon><component :is="hostIcon(h.protocol)" /></el-icon>
          </div>
          <div class="host-body">
            <span class="host-name">{{ h.name }}</span>
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
    <div class="panel-footer"><el-icon><Pointer /></el-icon><span>双击连接，或选中后按 Enter</span></div>
  </div>
</template>

<style scoped>
.host-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.panel-heading {
  height: 44px;
  padding: 0 16px 0 20px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
  font-size: 12px;
  font-weight: 600;
}
.library-count { margin-left: 7px; font: 11px var(--sh-font-mono); color: var(--sh-text-muted); }
.panel-add {
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--sh-text-secondary);
  cursor: pointer;
}
.panel-add:hover { background: var(--sh-bg-active); color: var(--sh-text); }
.panel-toolbar {
  display: flex;
  padding: 8px 14px 14px;
}
.panel-toolbar :deep(.el-input__wrapper) {
  background: rgba(255, 255, 255, 0.46) !important;
  box-shadow: none !important;
  font-size: 12px;
}
.panel-toolbar :deep(.el-input__wrapper.is-focus) { box-shadow: 0 0 0 1px var(--sh-accent-border) inset !important; }
.panel-toolbar .el-input {
  flex: 1;
}
.panel-footer {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 16px 20px;
  font-size: 10px;
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
  padding: 0 10px 12px;
}
.group-title {
  width: 100%;
  border: 0;
  background: transparent;
  text-align: left;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 9px 8px;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.4px;
  color: var(--sh-text-muted);
  text-transform: uppercase;
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
  padding: 9px 8px;
  margin-bottom: 2px;
  border-radius: var(--sh-radius);
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
.host-row:hover .proto-tag,
.host-row:focus-within .proto-tag,
.host-row.selected .proto-tag {
  opacity: 0;
}
.host-icon {
  width: 24px;
  height: 28px;
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
  font: 10px var(--sh-font-mono);
  color: var(--sh-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.proto-tag {
  flex-shrink: 0;
  font: 9px var(--sh-font-mono);
  letter-spacing: 0.3px;
  padding: 2px 3px;
  color: var(--sh-text-muted);
  transition: opacity 0.14s ease;
}
.host-actions {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  gap: 2px;
  border-radius: 6px;
  background: var(--sh-bg-sidebar);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.14s ease;
}
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
</style>
