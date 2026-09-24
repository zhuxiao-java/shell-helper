const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { createHash } = require('node:crypto')
const ts = require('typescript')
require.extensions['.ts'] = (module, file) => {
  module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  }).outputText, file)
}
const { defaults, validateSettings, fromKey, validCommand, shortcutError } = require('../src/shared/settings.ts')
const { SettingsService } = require('../src/main/settings.ts')
const { StorageService } = require('../src/main/storage.ts')
const { ExternalEditService } = require('../src/main/external-edit.ts')
const { isTerminalProto, isFileProto, fileSessionType } = require('../src/renderer/src/api/types.ts')
const hash = data => createHash('sha256').update(data).digest('hex')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

async function fixture(t, custom = false) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'shell-helper-test-'))
  let remote = Buffer.from('original\r\n')
  const launch = []
  const requests = []
  let uploadHook
  const input = { sessionId: 'a'.repeat(32), path: '/中文 folder/note.py', hostName: '隔离测试主机' }
  const deps = {
    editor: () => ({ mode: custom ? 'custom' : 'default', path: '/mock/editor' }),
    launch: async (file, editor) => { launch.push({ file, editor }) },
    changed: () => {},
    request: async (route, init) => {
      requests.push({ route, init })
      if (route.startsWith('/api/sessions/')) return new Response(JSON.stringify({ host_id: 'isolated-host', type: 'sftp' }))
      if (!init) return new Response(remote, { headers: { 'X-Content-SHA256': hash(remote) } })
      if (init.headers['X-Expected-SHA256'] !== hash(remote)) return new Response(JSON.stringify({ detail: '远程冲突' }), { status: 409 })
      if (uploadHook) await uploadHook()
      remote = Buffer.from(init.body)
      return new Response(JSON.stringify({ sha256: hash(remote) }))
    }
  }
  const service = new ExternalEditService(path.join(root, 'drafts'), deps)
  await service.initialize()
  t.after(async () => { await service.stop(); await fsp.rm(root, { recursive: true, force: true }) })
  return { service, root, deps, input, launch, requests, remote: () => remote, changeRemote: data => { remote = Buffer.from(data) }, onUpload: fn => { uploadHook = fn } }
}

test('存储位置使用实际后端路径、只打开目录、仅允许预定义位置', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'shell-helper-storage-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const dataDir = path.join(root, '自定义 后端')
  const dbDir = path.join(root, '独立数据库')
  await fsp.mkdir(path.join(root, 'drafts'))
  await fsp.mkdir(path.join(dataDir, 'logs'), { recursive: true })
  await fsp.mkdir(dbDir)
  const databasePath = path.join(dbDir, 'connections.db')
  const opened = [], copied = []
  const service = new StorageService({ userData: root, backend: async () => ({ dataDir, databasePath }),
    openPath: async directory => { opened.push(directory); return '' }, copyText: text => copied.push(text) })
  const result = await service.read()
  assert.equal(result.warning, undefined)
  assert.equal(result.locations.find(item => item.id === 'database').path, databasePath)
  assert.equal(result.locations.find(item => item.id === 'logs').path, path.join(dataDir, 'logs'))
  for (const id of ['database', 'drafts', 'settings', 'logs']) { await service.open(id); await service.copy(id) }
  assert.deepEqual(opened, [dbDir, path.join(root, 'drafts'), root, path.join(dataDir, 'logs')])
  assert.equal(copied[0], databasePath)
  for (const id of ['../secrets', '/etc', '__proto__', null, {}, ['drafts']]) {
    await assert.rejects(service.open(id), /不允许/)
    await assert.rejects(service.copy(id), /不允许/)
  }
})

test('后端不可用仍可访问本地草稿，系统打开失败明确报错', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'shell-helper-storage-offline-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  await fsp.mkdir(path.join(root, 'drafts'))
  let opened, copied
  const deps = { userData: root, backend: async () => { throw new Error('offline') },
    openPath: async directory => { opened = directory; return '' }, copyText: text => { copied = text } }
  const service = new StorageService(deps)
  const result = await service.read()
  assert.match(result.warning, /后端暂不可用/)
  assert.equal(result.locations.find(item => item.id === 'database').path, null)
  await service.open('drafts')
  await service.copy('settings')
  assert.equal(opened, path.join(root, 'drafts'))
  assert.equal(copied, path.join(root, 'settings.json'))
  await assert.rejects(service.open('database'), /无法获取/)
  deps.openPath = async () => '拒绝访问'
  await assert.rejects(service.open('drafts'), /拒绝访问/)
})

test('内存数据库不伪造文件路径，非法后端路径不给予打开权限', async () => {
  const deps = { userData: os.tmpdir(), backend: async () => ({ databasePath: null, dataDir: os.tmpdir() }),
    openPath: async () => { throw new Error('不应调用') }, copyText: () => assert.fail('不应复制') }
  const service = new StorageService(deps)
  const result = await service.read()
  assert.equal(result.warning, undefined)
  assert.match(result.locations.find(item => item.id === 'database').unavailable, /不使用本地文件/)
  await assert.rejects(service.open('database'), /不使用本地文件/)
  deps.backend = async () => ({ databasePath: 'relative.db', dataDir: 'file://bad' })
  assert.ok((await service.read()).warning)
  await assert.rejects(service.copy('database'), /无法获取/)
  await assert.rejects(service.open('logs'), /无法获取/)
})

test('设置校验、冲突、控制字符及平台按键归一化', () => {
  const settings = defaults()
  assert.deepEqual(validateSettings(settings), settings)
  settings.commands.push({ id: 'test', name: '状态', command: 'git status', shortcut: 'Mod+N', enabled: false })
  assert.throws(() => validateSettings(settings), /重复/)
  for (const command of ['pwd\nls', 'pwd\r', '\x1b[31m', 'x\x00', 'x\u2028y']) assert.equal(validCommand(command), false)
  assert.equal(validCommand('git status --short'), true)
  assert.ok(shortcutError('Shift+A'))
  assert.ok(shortcutError('Alt+F4'))
  assert.ok(shortcutError('Mod+Q'))
  assert.equal(fromKey({ key: 'N', code: 'KeyN', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false }, false), 'Mod+Shift+N')
  assert.equal(fromKey({ key: ',', code: 'Comma', ctrlKey: false, shiftKey: false, altKey: false, metaKey: true }, true), 'Mod+,')
  assert.equal(fromKey({ key: 'Control', code: 'ControlLeft', ctrlKey: true }, false), '')
})

test('协议能力与非法文件会话', () => {
  for (const protocol of ['sftp', 'ftp']) assert.equal(isTerminalProto(protocol), false)
  assert.equal(isTerminalProto('ssh'), true)
  assert.equal(isFileProto('ssh'), true)
  assert.equal(isFileProto('telnet'), false)
  assert.throws(() => fileSessionType('telnet'))
  assert.equal(fileSessionType('sftp'), 'sftp')
})

test('设置原子保存、重启读取与损坏恢复', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'shell-helper-settings-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'settings.json')
  const first = new SettingsService(file)
  await first.load()
  const settings = defaults()
  settings.bindings.goHome.shortcut = 'Mod+Shift+H'
  await first.save(settings)
  const second = new SettingsService(file)
  await second.load()
  assert.equal(second.get().settings.bindings.goHome.shortcut, 'Mod+Shift+H')
  await fsp.writeFile(file, '{ damaged')
  const third = new SettingsService(file)
  await third.load()
  assert.ok(third.get().warning)
  assert.deepEqual(third.get().settings, defaults())
  assert.ok((await fsp.readdir(root)).some(name => name.includes('.damaged-')))
})

test('快捷键单次分发、输入法、长按、表单、弹窗和终端控制键', () => {
  let callback, terminal = false, editable = false, dialog = false, blocked = false, count = 0
  global.window = { addEventListener: (_, fn) => { callback = fn }, removeEventListener: () => {} }
  global.document = { hasFocus: () => true, querySelectorAll: () => dialog ? [{ getClientRects: () => [1] }] : [] }
  const { installShortcuts, dispatchShortcut } = require('../src/renderer/src/utils/shortcuts.ts')
  const settings = defaults()
  const dispose = installShortcuts({ settings: () => settings, blocked: () => blocked, mac: true,
    action: () => { count++; return true }, command: () => false })
  const event = extra => ({ type: 'keydown', key: 'n', code: 'KeyN', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false,
    repeat: false, isComposing: false, keyCode: 78, preventDefault() {}, stopPropagation() {},
    target: { closest: selector => selector === '.xterm' ? terminal : editable }, ...extra })
  const once = event()
  callback(once); dispatchShortcut(once)
  assert.equal(count, 1)
  callback(event({ repeat: true })); callback(event({ isComposing: true })); callback(event({ keyCode: 229 }))
  editable = true; callback(event()); editable = false
  dialog = true; callback(event()); dialog = false
  blocked = true; callback(event()); blocked = false
  assert.equal(count, 1)
  terminal = true
  callback(event({ metaKey: false, ctrlKey: true }))
  assert.equal(count, 1)
  callback(event())
  assert.equal(count, 2)
  dispose()
})

test('安全默认副本、重复打开复用、未确认不写远程与原子保存', async t => {
  const f = await fixture(t)
  await f.service.open(f.input)
  const file = f.launch[0].file
  assert.equal(path.basename(file), 'document.txt')
  await fsp.writeFile(`${file}.swap`, Buffer.from('中文\r\n', 'utf16le'))
  await fsp.rename(`${file}.swap`, file)
  await f.service.refresh()
  assert.equal(f.service.list()[0].status, 'pending')
  assert.equal(f.requests.filter(r => r.init?.method === 'PUT').length, 0)
  await f.service.open(f.input)
  assert.equal(f.launch[1].file, file)
  assert.equal(f.service.list().length, 1)
  const item = f.service.list()[0]
  await f.service.upload(item.id, item.hash)
  assert.deepEqual(f.remote(), Buffer.from('中文\r\n', 'utf16le'))
  assert.equal(f.service.list()[0].dirty, false)
})

test('上传快照与上传过程中再次保存', async t => {
  const f = await fixture(t, true)
  await f.service.open(f.input)
  const file = f.launch[0].file
  assert.equal(path.extname(file), '.py')
  await fsp.writeFile(file, 'version one')
  await f.service.refresh()
  const item = f.service.list()[0]
  f.onUpload(async () => { await fsp.writeFile(file, 'version two'); await f.service.refresh() })
  await f.service.upload(item.id, item.hash)
  assert.equal(f.remote().toString(), 'version one')
  assert.equal(f.service.list()[0].status, 'pending')
  assert.equal(f.service.list()[0].dirty, true)
})

test('确认后文件变化拒绝上传、远程冲突保留草稿', async t => {
  const f = await fixture(t)
  await f.service.open(f.input)
  const file = f.launch[0].file
  await fsp.writeFile(file, 'local one')
  await f.service.refresh()
  const item = f.service.list()[0]
  await fsp.writeFile(file, 'local two')
  await assert.rejects(f.service.upload(item.id, item.hash), /再次改变/)
  assert.equal(f.requests.filter(r => r.init).length, 0)
  await f.service.refresh()
  f.changeRemote('another editor')
  await assert.rejects(f.service.upload(item.id, f.service.list()[0].hash), /远程冲突/)
  assert.equal(f.service.list()[0].status, 'conflict')
  assert.equal(await fsp.readFile(file, 'utf8'), 'local two')
  assert.equal(f.remote().toString(), 'another editor')
})

test('断线保留草稿、退出提示检查和重启恢复不自动联网', async t => {
  const f = await fixture(t)
  await f.service.open(f.input)
  await fsp.writeFile(f.launch[0].file, 'pending')
  await f.service.detach(f.input.sessionId)
  assert.equal(await f.service.hasPending(), true)
  await assert.rejects(f.service.upload(f.service.list()[0].id, f.service.list()[0].hash), /断开/)
  await f.service.stop()
  const count = f.requests.length
  const restored = new ExternalEditService(path.join(f.root, 'drafts'), f.deps)
  await restored.initialize()
  t.after(() => restored.stop())
  assert.equal(f.requests.length, count)
  assert.equal(restored.list()[0].dirty, true)
  assert.equal(restored.list()[0].sessionId, null)
  assert.equal(restored.list()[0].status, 'disconnected')
  await restored.reopen(restored.list()[0].id)
  assert.equal(f.requests.length, count)
  await restored.stop()
})

test('编辑器失败保留副本、默认应用回退与非法请求', async t => {
  const f = await fixture(t, true)
  f.deps.launch = async (file, editor) => {
    f.launch.push({ file, editor })
    if (editor.mode === 'custom') throw new Error('不存在的编辑器')
  }
  await assert.rejects(f.service.open(f.input), /不存在/)
  assert.equal(f.service.list().length, 1)
  await f.service.reopen(f.service.list()[0].id, true)
  assert.equal(path.extname(f.launch.at(-1).file), '.txt')
  await assert.rejects(f.service.open({ ...f.input, path: '/bad\ncommand' }), /无效/)
  await assert.rejects(f.service.open({ ...f.input, path: '../bad' }), /无效/)
})

test('本地超限与符号链接副本拒绝读取', async t => {
  const f = await fixture(t)
  await f.service.open(f.input)
  const file = f.launch[0].file
  await fsp.writeFile(file, Buffer.alloc(10 * 1024 * 1024 + 1, 65))
  await f.service.refresh()
  assert.equal(f.service.list()[0].status, 'error')
  assert.equal(await f.service.hasPending(), true)
  await fsp.rename(file, `${file}.original`)
  await fsp.symlink(`${file}.original`, file)
  await f.service.refresh()
  assert.match(f.service.list()[0].message, /普通文件/)
})
