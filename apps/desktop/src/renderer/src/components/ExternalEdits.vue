<script setup lang="ts">
import { ElMessage } from 'element-plus'
import { useExternalStore } from '@renderer/stores/external'
import { EDIT_STATUS } from '../../../shared/external'
defineProps<{ blocked: boolean }>()
const store = useExternalStore()
async function openDrafts(): Promise<void> {
  try { await window.shellHelper.openStorageLocation('drafts') }
  catch (error) { ElMessage.error((error as Error).message) }
}
</script>

<template>
  <aside v-if="store.prompt && !blocked && !store.visible && !store.confirming" class="edit-prompt" role="status">
    <div><strong>检测到文本修改</strong><p>{{ store.prompt.hostName }} · {{ store.prompt.remotePath }}</p></div>
    <el-button size="small" @click="store.defer(store.prompt)">稍后处理</el-button>
    <el-button size="small" type="primary" @click="store.upload(store.prompt)">回传远程</el-button>
  </aside>
  <el-dialog v-model="store.visible" title="外部编辑与草稿" width="800px" top="8vh" :close-on-click-modal="false">
    <p class="edit-note">修改仅在确认后回传。断开后保留草稿；重新连接并打开同一远程文件可恢复回传，远程冲突不会自动覆盖。</p>
    <el-empty v-if="!store.items.length" description="双击远程文本文件，使用外部编辑器打开" />
    <article v-for="item in store.items" :key="item.id" class="edit-card">
      <div class="edit-heading"><strong>{{ item.remotePath.split('/').pop() }}</strong><el-tag :type="item.dirty ? 'warning' : 'info'" size="small">{{ EDIT_STATUS[item.status] }}{{ item.dirty && item.status !== 'pending' ? ' · 有本地修改' : '' }}</el-tag></div>
      <p>{{ item.hostName }} · {{ item.remotePath }}</p>
      <p v-if="item.message" class="edit-message">{{ item.message }}</p>
      <div class="edit-actions">
        <el-button size="small" @click="store.reopen(item.id)">打开本地副本</el-button>
        <el-button size="small" text @click="store.reopen(item.id, true)">使用默认应用</el-button>
        <span></span>
        <el-button v-if="item.dirty" size="small" text @click="store.defer(item)">稍后处理</el-button>
        <el-button type="primary" size="small" :disabled="!item.dirty || !item.sessionId || item.status === 'conflict' || store.confirming" :loading="item.status === 'uploading'" @click="store.upload(item)">回传远程</el-button>
      </div>
    </article>
    <template #footer><div class="edit-footer"><el-button text :icon="'FolderOpened'" @click="openDrafts">查看本地草稿目录</el-button><el-button @click="store.visible = false">关闭</el-button></div></template>
  </el-dialog>
</template>

<style scoped>
.edit-footer { display: flex; justify-content: space-between; align-items: center; }
.edit-note, .edit-card p { color: var(--sh-text-secondary); font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }
.edit-card { padding: 16px; border: 1px solid var(--sh-border); border-radius: 10px; margin-top: 14px; background: var(--sh-bg-elevated); }
.edit-heading, .edit-actions { display: flex; align-items: center; gap: 10px; }
.edit-heading { justify-content: space-between; font-size: 13px; }
.edit-actions > span { flex: 1; }
.edit-card .edit-message { color: var(--sh-warning); }
.edit-prompt { position: fixed; right: 24px; bottom: 44px; z-index: 1900; max-width: 650px; display: flex; align-items: center; gap: 10px; padding: 16px; border: 1px solid var(--sh-accent-border); border-radius: 12px; background: var(--sh-bg-panel); box-shadow: 0 8px 28px #0002; font-size: 13px; }
.edit-prompt p { max-width: 330px; margin: 6px 0 0; font-size: 12px; color: var(--sh-text-secondary); overflow-wrap: anywhere; }
</style>
