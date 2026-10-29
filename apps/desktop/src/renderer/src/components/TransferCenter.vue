<script setup lang="ts">
import { computed } from 'vue'
import { useTransfersStore, type TransferTask, type TransferRecord } from '@renderer/stores/transfers'

const open = defineModel<boolean>({ required: true })
const transfers = useTransfersStore()
const active = computed(() => transfers.activeList)
const recent = computed(() => transfers.recentList)

function fmtSize(bytes: number): string {
  if (!bytes) return '—'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}
function percent(task: TransferTask): number {
  return task.total ? Math.min(100, Math.round(task.loaded / task.total * 100)) : 0
}
function rate(task: TransferTask): number {
  const seconds = (Date.now() - task.startedAt) / 1000
  return seconds > 0 ? task.loaded / seconds : 0
}
function rateLabel(task: TransferTask): string {
  const speed = rate(task)
  if (!speed) return '准备中'
  const eta = task.total > task.loaded ? Math.max(1, Math.round((task.total - task.loaded) / speed)) : 0
  return `${fmtSize(speed)}/s${eta ? ` · 剩余 ${eta}s` : ''}`
}
function directionLabel(task: TransferTask | TransferRecord): string {
  return task.direction === 'upload' ? '上传' : '下载'
}
function time(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}
</script>

<template>
  <el-drawer v-model="open" :with-header="false" size="380px" append-to-body destroy-on-close class="transfer-center">
    <div class="tc-panel">
      <header class="tc-head">
        <div><h2>传输</h2><p>{{ active.length ? `${active.length} 个任务进行中` : '所有传输任务' }}</p></div>
        <button class="tc-close" type="button" aria-label="关闭传输面板" @click="open = false"><el-icon><Close /></el-icon></button>
      </header>

      <section class="tc-section">
        <div class="tc-section-head"><h3>进行中</h3><span>{{ active.length }} 个</span></div>
        <div v-if="active.length" class="tc-active-list">
          <div v-for="task in active" :key="task.id" class="tc-task">
            <span class="tc-kind"><el-icon><Upload v-if="task.direction === 'upload'" /><Download v-else /></el-icon></span>
            <div class="tc-task-body">
              <div class="tc-task-title"><strong :title="task.label">{{ task.label }}</strong><span>{{ directionLabel(task) }}</span></div>
              <el-progress :percentage="percent(task)" :stroke-width="5" :show-text="false" />
              <div class="tc-task-meta"><span>{{ fmtSize(task.loaded) }}<template v-if="task.total"> / {{ fmtSize(task.total) }}</template> · {{ rateLabel(task) }}</span><button type="button" @click="transfers.cancel(task.id)">取消</button></div>
            </div>
          </div>
        </div>
        <div v-else class="tc-empty"><el-icon><Connection /></el-icon><span>当前没有进行中的传输</span></div>
      </section>

      <section class="tc-section">
        <div class="tc-section-head"><h3>最近</h3><button v-if="recent.length" type="button" class="tc-text-button" @click="transfers.clearRecent">清空</button></div>
        <div v-if="recent.length" class="tc-recent-list">
          <div v-for="item in recent" :key="`${item.id}-${item.finishedAt}`" class="tc-recent" :class="item.status">
            <span class="tc-kind"><el-icon><Upload v-if="item.direction === 'upload'" /><Download v-else /></el-icon></span>
            <div class="tc-recent-body"><strong :title="item.label">{{ item.label }}</strong><small>{{ item.error || (item.status === 'done' ? '已完成' : '失败') }} · {{ fmtSize(item.total || item.loaded) }}</small></div>
            <button v-if="item.status === 'error' && item.resume" class="tc-retry" type="button" @click="transfers.retry(item)">续传</button>
            <time>{{ time(item.finishedAt) }}</time>
          </div>
        </div>
        <div v-else class="tc-empty"><el-icon><Document /></el-icon><span>上传或下载文件后，任务会显示在这里。</span></div>
      </section>
    </div>
  </el-drawer>
</template>

<style scoped>
.transfer-center :deep(.el-drawer__body) { padding: 0; }
.tc-panel { min-height: 100%; padding: 18px; display: flex; flex-direction: column; gap: 20px; background: var(--sh-bg-panel); }
.tc-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.tc-head h2 { margin: 0 0 3px; font-size: 19px; font-weight: 600; letter-spacing: -0.3px; }
.tc-head p { margin: 0; color: var(--sh-text-muted); font-size: 11px; }
.tc-close { width: 28px; height: 28px; display: grid; place-items: center; border: 0; border-radius: 6px; background: transparent; color: var(--sh-text-muted); cursor: pointer; }
.tc-close:hover { background: var(--sh-bg-hover); color: var(--sh-text); }
.tc-section { min-height: 0; }
.tc-section-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.tc-section-head h3 { margin: 0; font-size: 12px; font-weight: 600; color: var(--sh-text); }
.tc-section-head span { color: var(--sh-text-muted); font-size: 10px; }
.tc-retry { flex-shrink: 0; padding: 0; border: 0; background: transparent; color: var(--sh-accent); font-size: 10px; cursor: pointer; }
.tc-text-button { padding: 0; border: 0; background: transparent; color: var(--sh-accent); font-size: 11px; cursor: pointer; }
.tc-active-list, .tc-recent-list { display: flex; flex-direction: column; gap: 7px; }
.tc-task { display: flex; align-items: flex-start; gap: 9px; padding: 10px; border: 1px solid var(--sh-border); border-radius: 10px; background: var(--sh-bg); }
.tc-kind { width: 26px; height: 26px; flex-shrink: 0; display: grid; place-items: center; border-radius: 7px; background: var(--sh-accent-soft); color: var(--sh-accent); font-size: 13px; }
.tc-task-body { min-width: 0; flex: 1; }
.tc-task-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
.tc-task-title strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 500; color: var(--sh-text); }
.tc-task-title span { flex-shrink: 0; color: var(--sh-text-muted); font-size: 10px; }
.tc-task-meta { display: flex; justify-content: space-between; gap: 8px; margin-top: 5px; color: var(--sh-text-muted); font-size: 10px; }
.tc-task-meta button { padding: 0; border: 0; background: transparent; color: var(--sh-danger); font-size: 10px; cursor: pointer; }
.tc-recent { display: flex; align-items: center; gap: 8px; padding: 7px; border-radius: 8px; }
.tc-recent:hover { background: var(--sh-bg-hover); }
.tc-recent-body { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
.tc-recent-body strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; font-weight: 500; color: var(--sh-text); }
.tc-recent-body small { color: var(--sh-text-muted); font-size: 10px; }
.tc-recent.error .tc-recent-body small { color: var(--sh-danger); }
.tc-recent time { flex-shrink: 0; color: var(--sh-text-muted); font-size: 9px; }
.tc-empty { display: flex; align-items: flex-start; gap: 8px; padding: 12px 9px; color: var(--sh-text-muted); font-size: 11px; line-height: 1.6; }
.tc-empty .el-icon { margin-top: 1px; font-size: 14px; }
</style>
