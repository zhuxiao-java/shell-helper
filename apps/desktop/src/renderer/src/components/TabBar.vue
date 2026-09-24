<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { useSessionStore } from '@renderer/stores/session'
import { useHostStore } from '@renderer/stores/host'
import type { Protocol } from '@renderer/api/types'

const emit = defineEmits<{ (e: 'new-host'): void }>()
const sessionStore = useSessionStore()
const hostStore = useHostStore()

const scrollRef = ref<HTMLDivElement>()

function onNavigate(event: KeyboardEvent, id: string): void {
  if (event.target !== event.currentTarget) return
  const ids = ['', ...sessionStore.tabs.map((tab) => tab.id)]
  let index = ids.indexOf(id)
  if (event.key === 'ArrowRight') index = (index + 1) % ids.length
  else if (event.key === 'ArrowLeft') index = (index - 1 + ids.length) % ids.length
  else if (event.key === 'Home') index = 0
  else if (event.key === 'End') index = ids.length - 1
  else return
  event.preventDefault()
  sessionStore.focus(ids[index])
  scrollRef.value?.querySelectorAll<HTMLElement>('[role="tab"]')[index]?.focus()
}

function tabProto(tabId: string): Protocol {
  const tab = sessionStore.tabs.find((t) => t.id === tabId)
  if (tab?.hostId === '') return 'local'
  const host = hostStore.byId(tab?.hostId ?? '')
  return host?.protocol ?? 'ssh'
}

// 切换/新增标签后,让当前标签滚动可见
watch(
  () => [sessionStore.activeId, sessionStore.tabs.length] as const,
  async () => {
    await nextTick()
    scrollRef.value
      ?.querySelector('.tab-item.active')
      ?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  }
)
</script>

<template>
  <div class="tab-bar">
    <div ref="scrollRef" class="tab-scroll" role="tablist" aria-label="工作空间标签">
      <!-- 常驻起始页:点击回到工作台,不影响已打开会话 -->
      <button
        class="tab-item home-tab"
        role="tab"
        :aria-selected="!sessionStore.activeId"
        :tabindex="!sessionStore.activeId ? 0 : -1"
        :class="{ active: !sessionStore.activeId }"
        @click="sessionStore.focus('')"
        @keydown="onNavigate($event, '')"
      >
        <el-icon class="home-icon"><House /></el-icon>
        <span class="tab-title">开始</span>
      </button>

      <div class="tab-divider"></div>

      <div
        v-for="tab in sessionStore.tabs"
        :key="tab.id"
        class="tab-item"
        :class="{ active: tab.id === sessionStore.activeId }"
        role="tab"
        :aria-selected="tab.id === sessionStore.activeId"
        :tabindex="tab.id === sessionStore.activeId ? 0 : -1"
        :title="tab.title"
        @click="sessionStore.focus(tab.id)"
        @keydown="onNavigate($event, tab.id)"
        @keydown.enter.self.prevent="sessionStore.focus(tab.id)"
        @keydown.space.self.prevent="sessionStore.focus(tab.id)"
      >
        <!-- 协议/类型图标(静态) -->
        <span class="tab-proto" :class="`proto-${tabProto(tab.id)}`">
          <el-icon v-if="tab.kind === 'files'"><FolderOpened /></el-icon>
          <el-icon v-else><Monitor /></el-icon>
        </span>
        <span class="tab-title">{{ tab.title }}</span>
        <!-- 连接状态(与协议图标分离) -->
        <i
          class="status-dot"
          :class="tab.connecting ? 'pending' : tab.session?.status === 'closed' ? 'disconnected' : 'connected'"
          :title="tab.connecting ? '连接中' : tab.session?.status === 'closed' ? '已结束' : '已连接'"
        ></i>
        <button class="tab-close" :aria-label="`关闭 ${tab.title}`" title="关闭标签" @click.stop="sessionStore.close(tab.id)">
          <el-icon><Close /></el-icon>
        </button>
      </div>
    </div>
    <button class="tab-add" title="新建连接" aria-label="新建连接" @click="emit('new-host')"><el-icon><Plus /></el-icon></button>
  </div>
</template>

<style scoped>
.tab-bar {
  display: flex;
  align-items: stretch;
  height: var(--sh-tabbar-h);
  padding: 0 10px;
  flex-shrink: 0;
  gap: 8px;
  background: var(--sh-bg);
  border-bottom: 1px solid var(--sh-border);
}
.tab-scroll {
  display: flex;
  align-items: center;
  gap: 4px;
  overflow-x: auto;
  flex: 1;
  scrollbar-width: none;
  padding: 4px 2px;
  min-width: 0;
}
.tab-scroll::-webkit-scrollbar {
  display: none;
}
.tab-divider {
  width: 1px;
  height: 14px;
  background: var(--sh-border);
  flex-shrink: 0;
  margin: 0 4px;
}

/* 桌面工作区标签:未选中浅灰,选中白底 + 蓝色下划线 */
.tab-item {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 30px;
  padding: 0 9px 0 12px;
  font-size: 12px;
  color: var(--sh-text-secondary);
  background: transparent;
  border: none;
  border-radius: 7px;
  cursor: pointer;
  white-space: nowrap;
  max-width: 220px;
  flex-shrink: 0;
  user-select: none;
  transition: color 0.14s ease, background 0.14s ease, border-color 0.14s ease;
}
.tab-item:hover {
  background: var(--sh-bg-hover);
  color: var(--sh-text);
}
.tab-item.active {
  background: var(--sh-bg-panel);
  box-shadow: 0 1px 3px rgba(39, 50, 39, 0.07), 0 0 0 1px var(--sh-border);
  color: var(--sh-text);
  font-weight: 500;
}

.tab-proto {
  display: grid;
  place-items: center;
  font-size: 14px;
  flex-shrink: 0;
}
.home-icon {
  font-size: 14px;
  color: var(--sh-text-secondary);
}
.home-tab.active .home-icon {
  color: var(--sh-accent);
}
.tab-title {
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 连接状态点 */
.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.status-dot.connected {
  background: var(--sh-success);
}
.status-dot.disconnected { background: var(--sh-text-muted); }
.status-dot.pending {
  background: var(--sh-ftp);
  animation: dot-pulse 1s ease-in-out infinite;
}
@keyframes dot-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.25;
  }
}

.tab-close {
  width: 18px;
  height: 18px;
  border: none;
  border-radius: var(--sh-radius-sm);
  display: grid;
  place-items: center;
  background: transparent;
  color: var(--sh-text-muted);
  cursor: pointer;
  opacity: 0;
  flex-shrink: 0;
  transition: all 0.12s ease;
}
.tab-item:hover .tab-close,
.tab-item:focus-within .tab-close,
.tab-item.active .tab-close {
  opacity: 1;
}
.tab-close:hover {
  background: rgba(220, 38, 38, 0.12);
  color: var(--sh-danger);
}
.tab-add {
  align-self: center;
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--sh-text-muted);
  cursor: pointer;
}
.tab-add:hover { background: var(--sh-bg-hover); color: var(--sh-text); }
</style>
