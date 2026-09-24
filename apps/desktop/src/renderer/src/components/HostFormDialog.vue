<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import type { FormInstance, FormRules } from 'element-plus'
import { useHostStore } from '@renderer/stores/host'
import type { Host, HostInput, Protocol, AuthType } from '@renderer/api/types'

const visible = defineModel<boolean>({ required: true })
const props = defineProps<{ editHost?: Host | null; initialProtocol?: Protocol }>()
const hostStore = useHostStore()

const formRef = ref<FormInstance>()
const submitting = ref(false)
const showAdvanced = ref(false)
// 服务端保存错误,就地展示在表单顶部
const saveError = ref('')

const isEdit = computed(() => !!props.editHost)
// 原主机是否已存凭据(密码认证且有 credential_id)
const hasStoredCredential = computed(
  () => isEdit.value && props.editHost?.auth_type === 'password' && !!props.editHost?.credential_id
)

function defaults(): HostInput {
  const protocol = props.initialProtocol ?? 'ssh'
  const local = protocol === 'local'
  return {
    name: local ? '本地终端' : '',
    group: '默认分组',
    protocol,
    host: '',
    port: { ssh: 22, sftp: 22, ftp: 21, telnet: 23, local: 0 }[protocol],
    username: local ? '' : 'root',
    auth_type: local ? 'none' : 'password',
    key_path: '',
    tags: '',
    remote_cwd: local ? '~' : '/',
    password: ''
  }
}

const form = reactive<HostInput>(defaults())

function fillFromHost(h: Host): void {
  Object.assign(form, {
    name: h.name,
    group: h.group,
    protocol: h.protocol,
    host: h.host,
    port: h.port,
    username: h.username,
    auth_type: h.auth_type,
    key_path: h.key_path,
    tags: h.tags,
    remote_cwd: h.remote_cwd,
    password: '' // 不回显已存储密码
  })
}

// 按协议与新建/编辑态动态生成校验规则(本地终端隐藏远程字段,同步不校验)
const rules = computed<FormRules>(() => {
  const local = form.protocol === 'local'
  const r: FormRules = {
    name: [{ required: true, message: '请输入主机名称', trigger: 'blur' }]
  }
  if (!local) {
    r.host = [
      { required: true, message: '请输入主机地址', trigger: 'blur' },
      {
        validator: (_f, value: string, cb) =>
          /\s/.test(value ?? '') ? cb(new Error('地址不能含空格')) : cb(),
        trigger: 'blur'
      }
    ]
    r.port = [{ required: true, message: '请输入端口', trigger: 'blur' }]
  }
  if (!local && form.username !== undefined) {
    r.username = [{ required: true, message: '请输入用户名', trigger: 'blur' }]
  }
  if (!local && !isEdit.value && form.auth_type === 'password') {
    r.password = [{ required: true, message: '请输入密码', trigger: 'blur' }]
  }
  if (!local && form.auth_type === 'pubkey') {
    r.key_path = [{ required: true, message: '请输入私钥路径', trigger: 'blur' }]
  }
  return r
})

const protocols: { label: string; value: Protocol }[] = [
  { label: 'SSH (Shell 终端)', value: 'ssh' },
  { label: 'SFTP (文件管理)', value: 'sftp' },
  { label: 'FTP (文件管理)', value: 'ftp' },
  { label: 'Telnet (终端)', value: 'telnet' },
  { label: '本地终端', value: 'local' }
]

const DEFAULT_PORTS: Record<Protocol, number> = {
  ssh: 22,
  sftp: 22,
  ftp: 21,
  telnet: 23,
  local: 0
}

const ALL_AUTH: { label: string; value: AuthType }[] = [
  { label: '密码', value: 'password' },
  { label: '公钥/私钥', value: 'pubkey' },
  { label: 'SSH Agent', value: 'agent' },
  { label: '免认证', value: 'none' }
]

// 仅 SSH/SFTP 支持公钥与 agent;其余协议只留密码/免认证
const authTypes = computed(() => {
  const p = form.protocol as Protocol
  if (p === 'ssh' || p === 'sftp') return ALL_AUTH
  return ALL_AUTH.filter((a) => a.value === 'password' || a.value === 'none')
})

function onProtocolChange(p: Protocol): void {
  form.port = DEFAULT_PORTS[p] ?? 22
  if (p === 'local') {
    form.auth_type = 'none'
    form.name ||= '本地终端'
    form.host = ''
    form.username = ''
    form.password = ''
    form.key_path = ''
    form.remote_cwd = '~'
  } else if (!form.username) form.username = 'root'
  // 切换协议时修正不兼容的认证方式
  if (p !== 'ssh' && p !== 'sftp' && (form.auth_type === 'pubkey' || form.auth_type === 'agent')) {
    form.auth_type = 'password'
  }
  // 文件类协议默认根目录
  if (p === 'sftp' || p === 'ftp') form.remote_cwd = '/'
}

watch(visible, (v) => {
  if (!v) return
  if (props.editHost) {
    fillFromHost(props.editHost)
  } else {
    Object.assign(form, defaults())
  }
  showAdvanced.value = false
  saveError.value = ''
  formRef.value?.clearValidate()
})

async function submit(): Promise<void> {
  const inst = formRef.value
  if (!inst || submitting.value) return
  await inst.validate(async (ok) => {
    if (!ok) return
    submitting.value = true
    saveError.value = ''
    try {
      if (isEdit.value && props.editHost) {
        const payload: HostInput = { ...form }
        // 编辑时密码留空表示不修改已存凭据
        if (payload.auth_type === 'password' && !payload.password) payload.password = null
        await hostStore.update(props.editHost.id, payload)
      } else {
        await hostStore.create({ ...form })
      }
      visible.value = false
    } catch (err) {
      saveError.value = (err as Error).message || '保存失败'
    } finally {
      submitting.value = false
    }
  })
}
</script>

<template>
  <el-dialog
    v-model="visible"
    :title="isEdit ? '编辑连接' : '新建连接'"
    width="600px"
    class="hf-dialog"
    :close-on-click-modal="false"
    append-to-body
  >
    <template #header="{ titleId }">
      <div class="hf-heading">
        <span class="hf-heading-icon"><el-icon><Connection /></el-icon></span>
        <div>
          <h2 :id="titleId">{{ isEdit ? '编辑连接' : '新的连接，新的起点。' }}</h2>
          <p>{{ isEdit ? '更新连接信息，下次连接时生效。' : '保存常用主机，随时回到你的工作。' }}</p>
        </div>
      </div>
    </template>
    <el-form ref="formRef" :model="form" :rules="rules" label-position="top" size="default" class="hf-form">
      <el-alert
        v-if="saveError"
        class="hf-error"
        type="error"
        :title="`保存失败:${saveError}`"
        show-icon
        :closable="false"
      />
      <div class="hf-section">
        <div class="hf-section-title">连接信息</div>
        <div class="hf-row">
          <el-form-item label="名称" prop="name" class="hf-name">
            <el-input v-model="form.name" placeholder="例如：生产 Web-01" />
          </el-form-item>
          <el-form-item label="协议" class="hf-proto">
            <el-select v-model="form.protocol" @change="onProtocolChange">
              <el-option v-for="p in protocols" :key="p.value" :label="p.label" :value="p.value" />
            </el-select>
          </el-form-item>
        </div>
        <p v-if="form.protocol === 'local'" class="hf-local-hint">使用系统默认 Shell，在此电脑执行命令；可在高级设置中指定初始目录。</p>
        <!-- 本地终端无远程字段,直接隐藏而非禁用 -->
        <template v-if="form.protocol !== 'local'">
          <div class="hf-row">
            <el-form-item label="主机地址" prop="host" class="hf-host">
              <el-input v-model="form.host" placeholder="IP 或域名" />
            </el-form-item>
            <el-form-item label="端口" prop="port" class="hf-port">
              <el-input-number
                v-model="form.port"
                :min="1"
                :max="65535"
                controls-position="right"
              />
            </el-form-item>
          </div>
          <el-form-item label="用户名" prop="username">
            <el-input v-model="form.username" />
          </el-form-item>
        </template>
      </div>

      <div v-if="form.protocol !== 'local'" class="hf-section">
        <div class="hf-section-title">身份认证</div>
        <el-form-item label="认证方式">
          <el-select v-model="form.auth_type">
            <el-option v-for="a in authTypes" :key="a.value" :label="a.label" :value="a.value" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="form.auth_type === 'password'" label="密码" prop="password">
          <el-input
            v-model="form.password"
            type="password"
            show-password
            :placeholder="hasStoredCredential ? '留空则保持原密码' : '将以 AES-256-GCM 加密存储'"
          />
        </el-form-item>
        <el-form-item v-if="form.auth_type === 'pubkey'" label="私钥路径" prop="key_path">
          <el-input v-model="form.key_path" placeholder="~/.ssh/id_ed25519" />
        </el-form-item>
      </div>

      <button type="button" class="hf-adv-toggle" :aria-expanded="showAdvanced" @click="showAdvanced = !showAdvanced">
        <el-icon class="hf-caret" :class="{ open: showAdvanced }"><CaretRight /></el-icon>
        <span>分组与高级设置</span>
      </button>
      <div v-show="showAdvanced" class="hf-section hf-section--adv">
        <el-form-item label="分组">
          <el-input v-model="form.group" placeholder="默认分组" />
        </el-form-item>
        <el-form-item :label="form.protocol === 'local' ? '本地初始目录' : '初始目录'">
          <el-input v-model="form.remote_cwd" :placeholder="form.protocol === 'local' ? '~（用户主目录）' : '/'" />
        </el-form-item>
        <el-form-item label="标签">
          <el-input v-model="form.tags" placeholder="逗号分隔，如：生产,nginx" />
        </el-form-item>
      </div>
    </el-form>
    <template #footer>
      <div class="hf-footer">
        <span>保存后可从连接库快速打开</span>
        <div>
          <el-button :disabled="submitting" @click="visible = false">取消</el-button>
          <el-button type="primary" :loading="submitting" @click="submit">{{ isEdit ? '保存修改' : '保存连接' }}</el-button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.hf-heading { display: flex; align-items: center; gap: 14px; padding: 2px 20px 12px 0; }
.hf-heading-icon { display: grid; place-items: center; width: 42px; height: 42px; border-radius: 12px; background: var(--sh-accent-soft); color: var(--sh-accent); font-size: 22px; flex-shrink: 0; }
.hf-heading h2 { margin: 0; font-size: 19px; font-weight: 600; color: var(--sh-text); }
.hf-heading p { margin: 7px 0 0; font-size: 12px; color: var(--sh-text-muted); }
.hf-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.hf-footer > span { color: var(--sh-text-muted); font-size: 11px; }
.hf-form {
  padding-top: 2px;
}
.hf-error {
  margin-bottom: 12px;
}
.hf-local-hint { color: var(--sh-text-secondary); font-size: 12px; line-height: 1.8; }
.hf-section {
  padding: 4px 0 2px;
}
.hf-section + .hf-section {
  margin-top: 10px;
  border-top: 1px solid var(--sh-border);
  padding-top: 18px;
}
.hf-section-title {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.3px;
  color: var(--sh-text-muted);
  margin-bottom: 10px;
}
.hf-row {
  display: flex;
  gap: 12px;
}
.hf-name {
  flex: 1;
  min-width: 0;
}
.hf-proto {
  width: 190px;
  flex-shrink: 0;
}
.hf-host {
  flex: 1;
  min-width: 0;
}
.hf-port {
  width: 130px;
  flex-shrink: 0;
}
.hf-port :deep(.el-input-number) {
  width: 100%;
}
.hf-form :deep(.el-form-item) {
  margin-bottom: 18px;
}
.hf-form :deep(.el-form-item.is-error) { margin-bottom: 24px; }
.hf-form :deep(.el-form-item__label) {
  padding-bottom: 4px;
  font-size: 12px;
  color: var(--sh-text-secondary);
}
.hf-adv-toggle {
  border: 0;
  background: transparent;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  padding: 6px 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--sh-text-secondary);
  cursor: pointer;
  user-select: none;
}
.hf-adv-toggle:hover {
  color: var(--sh-accent);
}
.hf-caret {
  font-size: 11px;
  transition: transform 0.16s ease;
}
.hf-caret.open {
  transform: rotate(90deg);
}
.hf-section--adv {
  border-top: 1px solid var(--sh-border);
  padding-top: 12px;
}
</style>
