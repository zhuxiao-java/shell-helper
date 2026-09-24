const { test } = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const fs = require('node:fs')
const ts = require('typescript')
const { createPinia, setActivePinia } = require('pinia')
const { webcrypto } = require('node:crypto')
global.crypto = webcrypto
global.window = { shellHelper: { detachEdits: async () => {} } }
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
}).outputText, file)
const hosts = ['ssh', 'sftp', 'ftp', 'telnet', 'local'].map(protocol => ({ id: protocol, protocol, name: protocol }))
let opened = [], closed = [], recorded = [], pending, localCount = 0
const original = Module._load
Module._load = function (request, parent, isMain) {
  if (request === '@renderer/api/sessions') return {
    openSession: async (host_id, type) => { opened.push({ host_id, type }); if (pending) await pending; return { session_id: host_id, host_id, type, remote_cwd: '/', status: 'active' } },
    openLocalSession: async () => { const session_id = `local-${++localCount}`; opened.push({ host_id: '', type: 'terminal' }); if (pending) await pending; return { session_id, host_id: '', type: 'terminal', remote_cwd: '~', status: 'active' } },
    closeSession: async id => { closed.push(id) }
  }
  if (request === 'element-plus') return { ElMessage: { error() {} } }
  if (request === './host' && parent.filename.endsWith('session.ts')) return { useHostStore: () => ({ byId: id => hosts.find(host => host.id === id) }) }
  if (request === '@renderer/utils/recent') return { recordConnect(id) { recorded.push(id) } }
  if (request === '@renderer/api/types') return require('../src/renderer/src/api/types.ts')
  return original.call(this, request, parent, isMain)
}
const { useSessionStore } = require('../src/renderer/src/stores/session.ts')
Module._load = original

test('前端非法协议在创建标签和请求前拒绝，SSH 保留双能力', async () => {
  setActivePinia(createPinia())
  opened = []; closed = []
  const store = useSessionStore()
  for (const id of ['sftp', 'ftp', 'missing']) assert.equal(await store.openTerminal(id), '')
  assert.equal(await store.openFiles('telnet'), '')
  assert.equal(opened.length, 0)
  assert.equal(store.tabs.length, 0)
  await store.openDefault('sftp')
  await store.openTerminal('ssh')
  await store.openFiles('ssh')
  assert.deepEqual(opened.map(s => s.type), ['sftp', 'terminal', 'sftp'])
})

test('连接尚未完成时关闭标签，不遗留后端会话', async () => {
  setActivePinia(createPinia())
  closed = []
  let release
  pending = new Promise(resolve => { release = resolve })
  const store = useSessionStore()
  const connecting = store.openTerminal('ssh')
  store.close(store.activeId)
  release()
  await connecting
  pending = undefined
  assert.equal(store.tabs.length, 0)
  assert.deepEqual(closed, ['ssh'])
})

test('本地终端无需主机记录，可开多个独立标签且不记录虚假最近连接', async () => {
  setActivePinia(createPinia())
  opened = []; recorded = []
  const store = useSessionStore()
  const first = await store.openLocalTerminal()
  const second = await store.openLocalTerminal()
  assert.notEqual(first, second)
  assert.notEqual(store.tabs[0].session.session_id, store.tabs[1].session.session_id)
  assert.deepEqual(opened, [{ host_id: '', type: 'terminal' }, { host_id: '', type: 'terminal' }])
  assert.deepEqual(recorded, [])
  assert.equal(await store.openFiles('local'), '')
  await store.openDefault('local')
  assert.equal(store.tabs.at(-1).kind, 'terminal')
})

test('本地进程创建完成前关闭标签，迟到会话仍被回收', async () => {
  setActivePinia(createPinia())
  closed = []; localCount = 0
  let release
  pending = new Promise(resolve => { release = resolve })
  const store = useSessionStore()
  const connecting = store.openLocalTerminal()
  store.close(store.activeId)
  release()
  await connecting
  pending = undefined
  assert.equal(store.tabs.length, 0)
  assert.deepEqual(closed, ['local-1'])
})
