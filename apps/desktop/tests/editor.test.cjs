const { test } = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const ts = require('typescript')
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
}).outputText, file)
let invoked, opened
const original = Module._load
Module._load = function(request, parent, isMain) {
  if (request === 'electron') return { shell: { openPath: async file => { opened = file; return '' } } }
  if (request === 'node:child_process') return { spawn: (command, args, options) => {
    invoked = { command, args, options }
    const child = new EventEmitter()
    child.unref = () => {}
    queueMicrotask(() => { child.emit('spawn'); child.emit('exit', 0) })
    return child
  } }
  return original.call(this, request, parent, isMain)
}
const { launchEditor, validateEditor } = require('../src/main/editor.ts')
Module._load = original

test('编辑器使用参数数组且不启用 shell，默认应用仅打开 txt', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'shell-helper-editor-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const editor = path.join(root, '编辑器 with space.exe')
  const file = path.join(root, 'document.txt')
  await fsp.writeFile(editor, '模拟程序', { mode: 0o700 })
  await validateEditor(editor)
  await launchEditor(file, { mode: 'custom', path: editor })
  assert.equal(invoked.command, editor)
  assert.deepEqual(invoked.args, [file])
  assert.equal(invoked.options.shell, false)
  await launchEditor(file, { mode: 'default', path: '' })
  assert.equal(opened, file)
  await assert.rejects(launchEditor(path.join(root, 'document.sh'), { mode: 'default', path: '' }), /txt/)
  await assert.rejects(validateEditor(path.join(root, 'missing.exe')))
  if (process.platform === 'darwin') {
    const bundle = path.join(root, '编辑器 with space.app')
    await fsp.mkdir(bundle)
    await launchEditor(file, { mode: 'custom', path: bundle })
    assert.equal(invoked.command, '/usr/bin/open')
    assert.deepEqual(invoked.args, ['-a', bundle, file])
  }
})
