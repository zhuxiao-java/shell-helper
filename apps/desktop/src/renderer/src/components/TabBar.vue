<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessageBox } from 'element-plus'
import { useSessionStore } from '@renderer/stores/session'
import { useHostStore } from '@renderer/stores/host'
import type { Protocol } from '@renderer/api/types'

const sessionStore = useSessionStore()
const hostStore = useHostStore()

const scrollRef = ref<HTMLDivElement>()
const canScrollLeft = ref(false)
const canScrollRight = ref(false)
let tabResizeObserver: ResizeObserver | null = null

function updateOverflow(): void {
  const el = scrollRef.value
  if (!el) return
  canScrollLeft.value = el.scrollLeft > 4
  canScrollRight.value = el.scrollLeft + el.clientWidth < el.scrollWidth - 4
}

function scrollTabs(delta: number): void {
  scrollRef.value?.scrollBy({ left: delta, behavior: 'smooth' })
}

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

async function renameTab(id: string, title: string): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt('标签名称', '重命名标签', { inputValue: title, inputPattern: /\S+/ })
    sessionStore.rename(id, value)
  } catch { /* 取消重命名 */ }
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
    updateOverflow()
  }
)
onMounted(() => {
  scrollRef.value?.addEventListener('scroll', updateOverflow)
  window.addEventListener('resize', updateOverflow)
  if (scrollRef.value && typeof ResizeObserver !== 'undefined') {
    tabResizeObserver = new ResizeObserver(updateOverflow)
    tabResizeObserver.observe(scrollRef.value)
  }
  updateOverflow()
})
onBeforeUnmount(() => {
  scrollRef.value?.removeEventListener('scroll', updateOverflow)
  window.removeEventListener('resize', updateOverflow)
  tabResizeObserver?.disconnect()
  tabResizeObserver = null
})
</script>

<template>
  <div class="tab-bar">
    <button class="tab-scroll-btn" :class="{ invisible: !canScrollLeft }" type="button" aria-label="向左滚动标签" :aria-hidden="!canScrollLeft" :tabindex="canScrollLeft ? 0 : -1" @click="scrollTabs(-180)"><el-icon><ArrowLeft /></el-icon></button>
    <div ref="scrollRef" class="tab-scroll" :class="{ 'fade-left': canScrollLeft, 'fade-right': canScrollRight }" role="tablist" aria-label="工作空间标签">
      <!-- 常驻工作台:点击回到工作台,不影响已打开会话 -->
      <button
        id="tab-home"
        class="tab-item home-tab"
        role="tab"
        aria-controls="panel-home"
        :aria-selected="!sessionStore.activeId"
        :tabindex="!sessionStore.activeId ? 0 : -1"
        :class="{ active: !sessionStore.activeId }"
        @click="sessionStore.focus('')"
        @keydown="onNavigate($event, '')"
      >
        <el-icon class="home-icon"><House /></el-icon>
        <span class="tab-title">工作台</span>
      </button>

      <div class="tab-divider"></div>

      <div
        v-for="tab in sessionStore.tabs"
        :key="tab.id"
        :id="`tab-${tab.id}`"
        class="tab-item"
        :class="{ active: tab.id === sessionStore.activeId }"
        role="tab"
        aria-controls="panel-session"
        :aria-selected="tab.id === sessionStore.activeId"
        :tabindex="tab.id === sessionStore.activeId ? 0 : -1"
        :title="tab.title"
        @click="sessionStore.focus(tab.id)"
        @mousedown="(event: MouseEvent) => { if (event.button === 1) event.preventDefault() }"
        @auxclick="(event: MouseEvent) => { if (event.button === 1) sessionStore.close(tab.id) }"
        @keydown="onNavigate($event, tab.id)"
        @keydown.enter.self.prevent="sessionStore.focus(tab.id)"
        @keydown.space.self.prevent="sessionStore.focus(tab.id)"
      >
        <!-- 协议/类型图标(静态) -->
        <span class="tab-proto" :class="`proto-${tabProto(tab.id)}`">
          <el-icon v-if="tab.kind === 'files'"><FolderOpened /></el-icon>
          <el-icon v-else><Monitor /></el-icon>
        </span>
        <span class="tab-title" @dblclick.stop="renameTab(tab.id, tab.title)">{{ tab.title }}</span>
        <!-- 连接状态(与协议图标分离) -->
        <i
          class="status-dot"
          :class="tab.connecting ? 'pending' : (!tab.session || tab.error || tab.session.status === 'closed' ? 'disconnected' : 'connected')"
          :title="tab.connecting ? '连接中' : (!tab.session || tab.error || tab.session.status === 'closed' ? '已结束' : '已连接')"
        ></i>
        <button class="tab-close" :aria-label="`关闭 ${tab.title}`" title="关闭标签" @click.stop="sessionStore.close(tab.id)">
          <el-icon><Close /></el-icon>
        </button>
      </div>
    </div>
    <button class="tab-scroll-btn" :class="{ invisible: !canScrollRight }" type="button" aria-label="向右滚动标签" :aria-hidden="!canScrollRight" :tabindex="canScrollRight ? 0 : -1" @click="scrollTabs(180)"><el-icon><ArrowRight /></el-icon></button>
  </div>
</template>

<style scoped>
.tab-bar {
  display: flex;
  align-items: stretch;
  height: var(--sh-tabbar-h);
  padding: 0 16px;
  flex-shrink: 0;
  gap: 4px;
  background: var(--sh-bg-elevated);
  border-bottom: 1px solid var(--sh-border);
}
.tab-scroll {
  display: flex;
  align-items: stretch;
  gap: 2px;
  overflow-x: auto;
  flex: 1;
  scrollbar-width: thin;
  padding: 0;
  min-width: 0;
}
.tab-scroll::-webkit-scrollbar { height: 4px; }
.tab-scroll.fade-left { mask-image: linear-gradient(90deg, transparent, #000 16px); }
.tab-scroll.fade-right { mask-image: linear-gradient(90deg, #000 calc(100% - 16px), transparent); }
.tab-scroll.fade-left.fade-right { mask-image: linear-gradient(90deg, transparent, #000 16px, #000 calc(100% - 16px), transparent); }
.tab-scroll-btn.invisible { visibility: hidden; pointer-events: none; }
.tab-scroll-btn {
  align-self: center;
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: var(--sh-radius-sm);
  background: transparent;
  color: var(--sh-text-muted);
  cursor: pointer;
}
.tab-divider { display: none; }

/* DSH 风格标签：文字 + 蓝色下划线 */
.tab-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 7px;
  height: 100%;
  padding: 0 10px;
  font-size: 12px;
  color: var(--sh-text-secondary);
  background: transparent;
  border: none;
  border-radius: 0;
  cursor: pointer;
  white-space: nowrap;
  max-width: 220px;
  flex-shrink: 0;
  user-select: none;
  transition: color 0.14s ease, background 0.14s ease;
}
.tab-item::after {
  content: '';
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: 0;
  height: 2px;
  border-radius: 2px 2px 0 0;
  background: transparent;
  transition: background 0.14s ease;
}
.tab-item:hover {
  background: var(--sh-bg-hover);
  color: var(--sh-text);
}
.tab-item.active {
  background: transparent;
  color: var(--sh-text);
  font-weight: 500;
}
.tab-item.active::after { background: var(--sh-accent); }

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
  width: 20px;
  height: 20px;
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
</style>
