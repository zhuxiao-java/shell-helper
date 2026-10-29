<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  state: 'loading' | 'error'
  message: string
  detail?: string
  error?: string
  step?: number
}>(), { step: 0 })
const emit = defineEmits<{ (e: 'retry'): void; (e: 'logs'): void }>()

const steps = [
  { label: '读取应用设置', detail: '外观、快捷键与本地偏好' },
  { label: '恢复编辑草稿', detail: '检查待回传的外部编辑' },
  { label: '启动本地服务', detail: 'Python 后端与安全握手' },
  { label: '加载连接库', detail: '主机、最近连接与标签' }
]

const currentStep = computed(() => Math.max(0, Math.min(props.step ?? 0, steps.length - 1)))
const progress = computed(() => props.state === 'error' ? 0 : ((currentStep.value + (props.state === 'loading' ? 0.55 : 1)) / steps.length) * 100)

function stepState(index: number): 'done' | 'active' | 'error' | 'pending' {
  if (index < currentStep.value) return 'done'
  if (index === currentStep.value) return props.state === 'error' ? 'error' : 'active'
  return 'pending'
}
</script>

<template>
  <section class="startup-screen" :class="{ 'is-error': state === 'error' }" role="status" aria-live="polite">
    <div class="startup-glow" aria-hidden="true"></div>
    <div class="startup-grid" aria-hidden="true"></div>

    <div class="startup-shell">
      <aside class="startup-brand">
        <div class="startup-wordmark"><span class="startup-mark" aria-hidden="true">›_</span><span>SHELL HELPER</span></div>
        <p class="startup-eyebrow">SSH · SFTP · FTP · TELNET</p>
        <h1>{{ state === 'error' ? '启动没有完成' : '正在准备工作区' }}</h1>
        <p class="startup-lead">{{ state === 'error' ? '本地服务暂时没有响应。你可以重试，或打开日志定位具体原因。' : '本地优先的远程工作台，正在恢复你的连接与编辑现场。' }}</p>
        <div class="startup-meta">
          <span><i></i>本地服务</span>
          <span><i></i>凭据不离开设备</span>
        </div>
      </aside>

      <section class="startup-panel" :class="{ failed: state === 'error' }">
        <header class="startup-panel-head">
          <div class="startup-panel-title">
            <span class="startup-status" :class="state"></span>
            <span>{{ state === 'error' ? '启动中止' : '启动检查' }}</span>
          </div>
          <span class="startup-step-count">{{ currentStep + 1 }} / {{ steps.length }}</span>
        </header>
        <div class="startup-progress" aria-hidden="true"><span :style="{ width: progress + '%' }"></span></div>

        <div v-if="state === 'loading'" class="startup-current">
          <span class="startup-spinner" aria-hidden="true"></span>
          <div class="startup-copy">
            <strong>{{ message }}</strong>
            <small>{{ detail || '首次启动会拉起本地服务，可能需要几秒钟。' }}</small>
          </div>
        </div>
        <div v-else class="startup-failure" role="alert">
          <div class="startup-failure-title"><span class="startup-failure-icon" aria-hidden="true">!</span><strong>{{ message || '启动没有完成' }}</strong></div>
          <p>{{ error || '本地服务没有响应，请重试或查看日志。' }}</p>
          <div class="startup-actions">
            <el-button type="primary" @click="emit('retry')">重新启动</el-button>
            <el-button @click="emit('logs')">打开日志目录</el-button>
          </div>
        </div>

        <ol class="startup-checklist">
          <li v-for="(item, index) in steps" :key="item.label" :class="stepState(index)">
            <span class="startup-marker">
              <template v-if="stepState(index) === 'done'">✓</template>
              <template v-else-if="stepState(index) === 'error'">!</template>
              <template v-else>{{ index + 1 }}</template>
            </span>
            <div><strong>{{ item.label }}</strong><small>{{ item.detail }}</small></div>
          </li>
        </ol>

        <footer class="startup-panel-foot">{{ state === 'error' ? '可以重试，或打开日志目录查看本地服务输出' : '正在准备本地终端、连接库与编辑草稿' }}</footer>
      </section>
    </div>

    <p class="startup-foot">本地优先 · 不上传连接凭据 · 首次启动可能需要几秒钟</p>
  </section>
</template>

<style scoped>
.startup-screen {
  position: fixed;
  inset: 0;
  z-index: 3000;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 28px;
  padding: 34px;
  color: var(--sh-text);
  background: var(--sh-bg);
}
.startup-glow {
  position: absolute;
  top: -28%;
  left: 6%;
  width: 760px;
  height: 520px;
  border-radius: 50%;
  background: radial-gradient(circle, var(--sh-accent-soft), transparent 68%);
  opacity: .85;
  pointer-events: none;
}
.startup-grid {
  position: absolute;
  inset: 0;
  background-image: linear-gradient(var(--sh-border) 1px, transparent 1px), linear-gradient(90deg, var(--sh-border) 1px, transparent 1px);
  background-size: 36px 36px;
  opacity: .18;
  mask-image: radial-gradient(ellipse at 50% 45%, #000 0%, transparent 72%);
  pointer-events: none;
}
.startup-shell {
  position: relative;
  width: min(940px, 100%);
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(360px, 420px);
  align-items: center;
  gap: clamp(34px, 6vw, 72px);
}
.startup-brand { max-width: 440px; }
.startup-wordmark { display: flex; align-items: center; gap: 11px; color: var(--sh-text); font: 600 12px var(--sh-font-brand); letter-spacing: .16em; }
.startup-mark {
  width: 36px;
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding-bottom: 2px;
  border-radius: 10px;
  background: var(--sh-ink);
  color: var(--sh-on-ink);
  font: 600 25px var(--sh-font-mono);
  letter-spacing: -4px;
}
.startup-eyebrow { margin: 24px 0 12px; color: var(--sh-text-muted); font: 10px var(--sh-font-mono); letter-spacing: .13em; }
h1 { margin: 0; font-family: var(--sh-font-brand); font-size: clamp(28px, 3.4vw, 40px); font-weight: 500; letter-spacing: -.035em; line-height: 1.12; color: var(--sh-text); }
.startup-lead { max-width: 390px; margin: 15px 0 0; color: var(--sh-text-secondary); font-size: 13px; line-height: 1.8; }
.startup-meta { display: flex; flex-wrap: wrap; gap: 16px; margin-top: 24px; color: var(--sh-text-muted); font-size: 10px; }
.startup-meta span { display: inline-flex; align-items: center; gap: 6px; }
.startup-meta i { width: 4px; height: 4px; border-radius: 50%; background: var(--sh-accent); }
.startup-panel {
  position: relative;
  padding: 16px;
  border: 1px solid var(--sh-border);
  border-radius: 15px;
  background: color-mix(in srgb, var(--sh-bg-panel) 94%, transparent);
  box-shadow: 0 22px 60px rgba(15, 17, 21, .08), 0 1px 2px rgba(15, 17, 21, .04);
  backdrop-filter: blur(12px);
  animation: startup-enter .42s cubic-bezier(.2, .8, .2, 1) both;
}
@keyframes startup-enter { from { opacity: 0; transform: translateY(8px); } }
.startup-panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.startup-panel-title { display: flex; align-items: center; gap: 7px; color: var(--sh-text-secondary); font-size: 11px; }
.startup-status { width: 6px; height: 6px; border-radius: 50%; background: var(--sh-success); box-shadow: 0 0 0 3px var(--sh-success-soft, transparent); }
.startup-status.loading { background: var(--sh-accent); animation: startup-status 1.1s ease-in-out infinite; }
.startup-status.error { background: var(--sh-danger); }
@keyframes startup-status { 50% { opacity: .35; } }
.startup-step-count { color: var(--sh-text-muted); font: 10px var(--sh-font-mono); }
.startup-progress { height: 2px; margin: 11px 0 14px; overflow: hidden; border-radius: 2px; background: var(--sh-border); }
.startup-progress span { display: block; height: 100%; border-radius: inherit; background: var(--sh-accent); transition: width .35s ease; }
.startup-current { display: flex; align-items: flex-start; gap: 11px; padding: 11px 12px; border: 1px solid var(--sh-border); border-radius: 9px; background: var(--sh-bg); }
.startup-spinner { width: 15px; height: 15px; flex-shrink: 0; margin-top: 1px; border: 2px solid var(--sh-border-strong); border-top-color: var(--sh-accent); border-radius: 50%; animation: startup-spin .8s linear infinite; }
@keyframes startup-spin { to { transform: rotate(360deg); } }
.startup-copy { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.startup-copy strong { color: var(--sh-text); font-size: 12px; font-weight: 500; }
.startup-copy small { color: var(--sh-text-muted); font-size: 10px; line-height: 1.55; }
.startup-failure { padding: 11px 12px; border: 1px solid color-mix(in srgb, var(--sh-danger) 22%, transparent); border-radius: 9px; background: var(--sh-warning-bg); color: var(--sh-warning-text); }
.startup-failure-title { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.startup-failure-icon { width: 17px; height: 17px; display: grid; place-items: center; border-radius: 50%; background: var(--sh-danger); color: #fff; font: 700 11px var(--sh-font-mono); }
.startup-failure p { max-height: 86px; margin: 8px 0 11px; overflow: auto; color: var(--sh-warning-text); font: 10px/1.6 var(--sh-font-mono); overflow-wrap: anywhere; }
.startup-actions { display: flex; gap: 7px; }
.startup-actions :deep(.el-button + .el-button) { margin-left: 0; }
.startup-checklist { list-style: none; margin: 14px 0 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.startup-checklist li { display: flex; align-items: flex-start; gap: 9px; padding: 7px 3px; color: var(--sh-text-muted); }
.startup-marker { width: 19px; height: 19px; flex-shrink: 0; display: grid; place-items: center; border: 1px solid var(--sh-border); border-radius: 50%; color: var(--sh-text-muted); font: 9px var(--sh-font-mono); }
.startup-checklist li.done .startup-marker { border-color: var(--sh-success); background: var(--sh-success); color: #fff; }
.startup-checklist li.active .startup-marker { border-color: var(--sh-accent); color: var(--sh-accent); box-shadow: 0 0 0 3px var(--sh-accent-soft); animation: startup-marker 1.2s ease-in-out infinite; }
.startup-checklist li.error .startup-marker { border-color: var(--sh-danger); background: var(--sh-danger); color: #fff; }
@keyframes startup-marker { 50% { box-shadow: 0 0 0 5px transparent; } }
.startup-checklist li > div { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.startup-checklist strong { color: inherit; font-size: 11px; font-weight: 500; }
.startup-checklist li.done strong, .startup-checklist li.active strong { color: var(--sh-text); }
.startup-checklist small { color: var(--sh-text-muted); font-size: 9px; line-height: 1.45; }
.startup-checklist li.pending { opacity: .52; }
.startup-panel-foot { margin-top: 8px; padding-top: 10px; border-top: 1px solid var(--sh-border); color: var(--sh-text-muted); font-size: 9px; line-height: 1.5; }
.startup-foot { position: relative; margin: 0; color: var(--sh-text-muted); font: 9px var(--sh-font-mono); letter-spacing: .03em; text-align: center; }
.is-error .startup-glow { background: radial-gradient(circle, color-mix(in srgb, var(--sh-danger) 10%, transparent), transparent 68%); }
@media (max-width: 820px) {
  .startup-shell { grid-template-columns: 1fr; max-width: 460px; gap: 24px; }
  .startup-brand { text-align: center; }
  .startup-wordmark, .startup-meta { justify-content: center; }
  .startup-lead { margin-left: auto; margin-right: auto; }
  .startup-eyebrow { margin-top: 18px; }
}
@media (max-height: 640px) {
  .startup-screen { gap: 16px; padding: 22px; }
  .startup-eyebrow { margin-top: 16px; }
  .startup-meta { margin-top: 16px; }
  .startup-panel { padding: 13px; }
  .startup-checklist { margin-top: 10px; }
  .startup-checklist li { padding: 5px 3px; }
  .startup-foot { display: none; }
}
</style>
