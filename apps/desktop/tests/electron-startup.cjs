/* 加载正式主进程、preload、renderer 和 Python 后端；数据完全隔离，不连接远程主机。 */
const { app, dialog, nativeTheme } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { randomBytes } = require('node:crypto')
const desktop = path.resolve(__dirname, '..')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-helper-startup-'))
app.setAppPath(desktop)
app.setPath('userData', root)
process.env.SHELL_HELPER_DATA_DIR = path.join(root, 'backend')
process.env.SHELL_HELPER_MASTER_KEY = randomBytes(32).toString('hex')
if (process.platform !== 'win32') {
  process.env.HOME = root
  process.env.ZDOTDIR = root
  process.env.HISTFILE = path.join(root, 'shell-history')
  process.env.SHELL = fs.existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/sh'
}
app.disableHardwareAcceleration()
let passed = false
let exitPids = []
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const timer = setTimeout(() => { console.error('正式启动测试超时'); app.exit(1) }, 60000)
dialog.showErrorBox = (title, message) => { console.error(title, message); app.exit(1) }

async function verify(win) {
  const evaluate = script => win.webContents.executeJavaScript(script, true)
  const waitFor = async (script, label) => {
    for (let i = 0; i < 150; i++) { if (await evaluate(script)) return; await sleep(60) }
    throw new Error(`未满足：${label}`)
  }
  await waitFor(`document.querySelector('.sh-app') && document.body.textContent.includes('服务就绪')`, '正式后端和界面就绪')
  assert.equal(win.isVisible(), true)
  const locations = await evaluate(`window.shellHelper.readStorageLocations()`)
  assert.equal(locations.warning, undefined)
  assert.equal(locations.locations.find(item => item.id === 'database').path, path.join(fs.realpathSync(root), 'backend', 'shell-helper.db'))
  assert.equal(locations.locations.find(item => item.id === 'drafts').path, path.join(root, 'drafts'))
  win.focus()
  await evaluate(`document.querySelector('.header-new[title]')?.blur(); [...document.querySelectorAll('button')].find(e => e.textContent.trim() === '新建连接').click()`)
  await waitFor(`!!document.querySelector('.hf-form input')`, '连接表单')
  await sleep(400)
  const focus = async selector => {
    app.focus({ steal: true })
    win.focus()
    win.webContents.focus()
    await waitFor(`document.hasFocus()`, '测试窗口获得焦点')
    await evaluate(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); input.blur(); input.focus(); })()`)
    await waitFor(`document.hasFocus() && document.activeElement === document.querySelector(${JSON.stringify(selector)})`, `输入焦点：${selector}`)
    await sleep(350)
  }
  const inputStyle = selector => evaluate(`(() => {
    const e = document.querySelector(${JSON.stringify(selector)});
    const w = e.closest('.el-input__wrapper, .el-select__wrapper') || e;
    const s = getComputedStyle(e), ws = getComputedStyle(w);
    return { outline: s.outlineStyle, userSelect: s.userSelect, height: e.getBoundingClientRect().height,
      wrapperHeight: w.getBoundingClientRect().height, shadow: ws.boxShadow, background: ws.backgroundColor, radius: ws.borderRadius };
  })()`)
  const colors = await evaluate(`(() => {
    const e = document.createElement('span'); document.body.append(e);
    const values = Object.fromEntries(['accent', 'danger', 'border', 'border-strong'].map(name => {
      e.style.color = 'var(--sh-' + name + ')'; return [name, getComputedStyle(e).color];
    })); e.remove(); return values;
  })()`)
  for (const theme of ['light', 'dark']) {
    nativeTheme.themeSource = theme
    await focus('.hf-name input')
    const style = await inputStyle('.hf-name input')
    assert.equal(style.outline, 'none', `${theme}：内部输入框没有重复焦点轮廓`)
    assert.equal(style.userSelect, 'text', `${theme}：允许选择文字`)
    assert.ok(style.shadow.includes(colors.accent), `${theme}：外框仍显示焦点`)
    assert.ok(style.height >= 24 && style.wrapperHeight >= style.height)
    assert.equal(style.background, 'rgb(255, 255, 255)')
    assert.equal(style.radius, '7px')
    await evaluate(`document.querySelector('.hf-name input').select()`)
    await win.webContents.insertText('测试主机 Web-01')
    await evaluate(`document.querySelector('.hf-name input').setSelectionRange(0, 4)`)
    await win.webContents.insertText('中文')
    assert.equal(await evaluate(`document.querySelector('.hf-name input').value`), '中文 Web-01', '选中文字后替换')
    await fsp.writeFile(path.join(os.tmpdir(), 'shell-helper-input-' + theme + '.png'), (await win.webContents.capturePage()).toPNG())
  }
  nativeTheme.themeSource = 'light'
  await focus('.hf-form input[type="password"]')
  await win.webContents.insertText('ui-test-only')
  assert.equal(await evaluate(`document.querySelector('.hf-form input[type="password"]').value`), 'ui-test-only')
  assert.equal((await inputStyle('.hf-form input[type="password"]')).outline, 'none')
  await evaluate(`document.querySelector('.hf-form .el-input__password').click()`)
  assert.ok(await evaluate(`!document.querySelector('.hf-form input[type="password"]')`), '密码显隐按钮正常')
  await evaluate(`document.querySelector('.hf-form .el-input__password').click()`)
  await focus('.hf-port input')
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Up' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Up' })
  await waitFor(`document.querySelector('.hf-port input').value === '23'`, '端口数字键盘交互')
  assert.equal((await inputStyle('.hf-port input')).outline, 'none')
  await focus('.hf-proto input')
  const selectStyle = await inputStyle('.hf-proto input')
  assert.equal(selectStyle.outline, 'none')
  assert.ok(selectStyle.shadow.includes(colors.accent), '下拉框外框显示焦点')
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
  await waitFor(`[...document.querySelectorAll('.el-select-dropdown__item')].some(e => e.getClientRects().length && e.textContent.includes('SFTP'))`, '下拉菜单键盘打开')
  await evaluate(`[...document.querySelectorAll('.el-select-dropdown__item')].find(e => e.getClientRects().length && e.textContent.includes('SFTP')).click()`)
  await waitFor(`document.querySelector('.hf-proto').textContent.includes('SFTP') && document.querySelector('.hf-port input').value === '22'`, '协议与端口联动')
  // 只触发缺少地址的前端校验，不保存连接或发起远程请求。
  await evaluate(`[...document.querySelectorAll('.hf-footer button')].find(e => e.textContent.trim() === '保存连接').click()`)
  await waitFor(`!!document.querySelector('.hf-host.is-error')`, '空地址校验')
  await focus('.hf-host input')
  assert.ok((await inputStyle('.hf-host input')).shadow.includes(colors.danger), '错误状态不被焦点覆盖')
  await focus('.hf-adv-toggle')
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.hf-adv-toggle')).outlineStyle`), 'solid', '保留按钮键盘焦点')
  // 用独立 DOM 样本覆盖当前表单未使用的 textarea 和禁用样式，不改动业务状态。
  await evaluate(`(() => {
    const fixture = document.createElement('div'); fixture.id = 'input-style-fixture';
    fixture.innerHTML = '<div class="el-form-item"><div class="el-form-item__content"><div class="el-textarea"><textarea tabindex="0" class="el-textarea__inner"></textarea></div></div></div>';
    const disabled = document.querySelector('.hf-name .el-input').cloneNode(true);
    disabled.classList.add('is-disabled'); disabled.querySelector('input').disabled = true;
    disabled.querySelector('.el-input__wrapper').classList.remove('is-focus'); fixture.append(disabled);
    const select = document.querySelector('.hf-proto .el-select').cloneNode(true);
    select.querySelector('.el-select__wrapper').classList.remove('is-focused', 'is-hovering');
    select.querySelector('.el-select__wrapper').classList.add('is-disabled'); select.querySelector('input').disabled = true;
    fixture.append(select); document.querySelector('.hf-form').append(fixture);
  })()`)
  await focus('#input-style-fixture textarea')
  const textareaStyle = await inputStyle('#input-style-fixture textarea')
  assert.equal(textareaStyle.outline, 'none')
  assert.equal(textareaStyle.userSelect, 'text')
  assert.ok(textareaStyle.shadow.includes(colors.accent), '多行输入焦点样式')
  for (const selector of ['#input-style-fixture input', '#input-style-fixture .el-select input']) {
    assert.notEqual((await inputStyle(selector)).background, 'rgb(255, 255, 255)', '禁用控件保留区别于可编辑控件的底色')
  }
  await evaluate(`document.querySelector('#input-style-fixture .el-form-item').classList.add('is-error')`)
  await sleep(350)
  assert.ok((await inputStyle('#input-style-fixture textarea')).shadow.includes(colors.danger), '多行输入校验样式')
  await evaluate(`document.querySelector('#input-style-fixture').remove()`)
  win.setSize(960, 600)
  await focus('.hf-name input')
  await sleep(350)
  assert.ok(await evaluate(`(() => {
    const body = document.querySelector('.hf-dialog .el-dialog__body');
    const footer = document.querySelector('.hf-footer').getBoundingClientRect();
    return body.scrollWidth <= body.clientWidth + 1 && footer.top >= 0 && footer.bottom <= innerHeight;
  })()`), '小窗口输入区域无横向溢出且操作按钮可达')
  await fsp.writeFile(path.join(os.tmpdir(), 'shell-helper-input-960.png'), (await win.webContents.capturePage()).toPNG())
  assert.ok(await evaluate(`!!window.shellHelper && document.querySelectorAll('.host-row').length === 0`), '未加载用户真实主机')
  await evaluate(`[...document.querySelectorAll('.hf-footer button')].find(e => e.textContent.trim() === '取消').click()`)
  await sleep(400)
  await verifyLocalTerminal(win, evaluate, waitFor)
  passed = true
  console.log('正式桌面启动通过：真实后端、隔离数据库、输入框交互及小窗口布局。')
  win.close()
}
async function verifyLocalTerminal(win, evaluate, waitFor) {
  if (process.platform === 'win32') {
    console.log('Windows 跳过 POSIX Shell 命令验收；需在 Windows 单独验收 ConPTY。')
    return
  }
  const connection = await evaluate(`window.shellHelper.getBackendInfo()`)
  const sessions = async () => (await fetch(connection.baseUrl + '/api/sessions', { headers: { Authorization: `Bearer ${connection.token}` } })).json()
  const terminal = id => `.terminal-host[data-session-id="${id}"]`
  const hasOutput = (id, text) => waitFor(`document.querySelector(${JSON.stringify(terminal(id))})?.textContent.includes(${JSON.stringify(text)})`, text)
  const command = async (id, text) => {
    app.focus({ steal: true })
    win.focus(); win.webContents.focus()
    await waitFor(`document.hasFocus()`, '终端测试窗口获得焦点')
    await evaluate(`document.querySelector(${JSON.stringify(terminal(id) + ' textarea')}).focus()`)
    await win.webContents.insertText(text)
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
  }
  await evaluate(`document.querySelector('.quick-action.local').click()`)
  await waitFor(`document.querySelector('.terminal-host[data-session-id] textarea') && document.querySelector('[aria-label="终端命令"]')`, '首页打开真实本地终端')
  const first = await evaluate(`document.querySelector('.terminal-host').dataset.sessionId`)
  await command(first, "SH_LOCAL_MARK=first; printf '\\nLOCAL_%s\\n' '中文就绪'; pwd")
  await hasOutput(first, 'LOCAL_中文就绪')
  await hasOutput(first, fs.realpathSync(root))
  assert.ok(await evaluate(`!!document.querySelector('.tab-item.active .proto-local')`), '本地协议图标')
  const beforeRows = await evaluate(`document.querySelector('.terminal-host .xterm-rows').children.length`)
  win.setSize(1280, 820)
  await waitFor(`document.querySelector('.terminal-host .xterm-rows').children.length !== ${beforeRows}`, '窗口缩放重新适配终端')
  await command(first, "printf '\\nSIZE='; stty size")
  await waitFor(`/SIZE=\\d+ \\d+/.test(document.querySelector(${JSON.stringify(terminal(first))}).textContent)`, '窗口尺寸传入真实 PTY')
  await command(first, 'sleep 30')
  await sleep(250)
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'C', modifiers: ['control'] })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'C', modifiers: ['control'] })
  await command(first, "printf '\\nCTRL_%s\\n' 'OK'")
  await hasOutput(first, 'CTRL_OK')
  await evaluate(`document.querySelector('[aria-label="打开本地终端"]').click()`)
  await waitFor(`document.querySelectorAll('.terminal-host[data-session-id] textarea').length === 2 && document.querySelector('[aria-label="终端命令"]')`, '顶栏再开独立终端')
  const second = await evaluate(`document.querySelectorAll('.terminal-host')[1].dataset.sessionId`)
  assert.notEqual(first, second)
  await command(second, "printf '\\nISOLATED_%s\\n' \"\${SH_LOCAL_MARK-unset}\"")
  await hasOutput(second, 'ISOLATED_unset')
  await command(second, 'exit')
  await hasOutput(second, '[终端已结束]')
  assert.ok(await evaluate(`!!document.querySelector('.tab-item.active .status-dot.disconnected')`), '退出后标签显示已结束')
  assert.ok(!(await sessions()).includes(second), 'exit 后后端会话已回收')
  await fsp.writeFile(path.join(os.tmpdir(), 'shell-helper-local-terminal.png'), (await win.webContents.capturePage()).toPNG())
  await evaluate(`document.querySelector('.tab-item:not(.home-tab) .tab-close').click()`)
  for (let i = 0; (await sessions()).includes(first) && i < 100; i++) await sleep(50)
  assert.ok(!(await sessions()).includes(first), '关闭运行中标签释放后端会话')
  await evaluate(`document.querySelector('.tab-item:not(.home-tab) .tab-close').click()`)
  assert.equal(await evaluate(`document.querySelectorAll('.host-row').length`), 0, '快捷打开不产生主机记录')
  // 保留一个运行中的 Shell 和前台任务，由正式应用退出流程负责回收。
  await evaluate(`document.querySelector('[aria-label="打开本地终端"]').click()`)
  await waitFor(`document.querySelector('.terminal-host[data-session-id] textarea') && document.querySelector('[aria-label="终端命令"]')`, '退出前创建运行中终端')
  const last = await evaluate(`document.querySelector('.terminal-host').dataset.sessionId`)
  await command(last, `printf '\\nQUIT_SHELL=%s\\n' "$$"; sh -c 'printf "\\nQUIT_CHILD=%s\\n" "$$"; exec sleep 30'`)
  await waitFor(`/QUIT_CHILD=\\d+/.test(document.querySelector(${JSON.stringify(terminal(last))}).textContent)`, '退出前前台任务已启动')
  exitPids = await evaluate(`[...document.querySelector(${JSON.stringify(terminal(last))}).textContent.matchAll(/QUIT_(?:SHELL|CHILD)=(\\d+)/g)].map(match => Number(match[1]))`)
  assert.equal(exitPids.length, 2, '记录独立 Shell 和前台任务的 PID')
  for (const pid of exitPids) process.kill(pid, 0)
  console.log('本地终端桌面验收通过：首页/顶栏打开、中文输入输出、主目录、窗口缩放、Ctrl+C、多会话隔离、exit 和关闭回收。')
}

app.once('browser-window-created', (_, win) => {
  win.webContents.once('did-finish-load', () => verify(win).catch(async error => {
    console.error(error)
    console.error(await win.webContents.executeJavaScript(`({ focus: document.activeElement?.className,
      controls: [...document.querySelectorAll('.hf-proto input, .hf-proto .el-select__wrapper')].map(e => ({
        className: e.className, tabindex: e.tabIndex, shadow: getComputedStyle(e).boxShadow, outline: getComputedStyle(e).outlineStyle
      })) })`))
    await fsp.writeFile(path.join(os.tmpdir(), 'shell-helper-startup-failure.png'), (await win.webContents.capturePage()).toPNG())
    app.quit()
  }))
})
app.on('will-quit', event => {
  clearTimeout(timer)
  try {
    for (const pid of exitPids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `应用退出后进程 ${pid} 已回收`)
    if (passed && exitPids.length) console.log('应用退出验收通过：运行中的本地 Shell 和前台任务均已回收。')
  } catch (error) { console.error(error); passed = false }
  if (!passed) { event.preventDefault(); app.exit(1) }
})
require(path.join(desktop, 'out/main/index.js'))
