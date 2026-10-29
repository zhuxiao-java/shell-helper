import { app, BrowserWindow, desktopCapturer, ipcMain, nativeTheme, session, shell, dialog, clipboard, type IpcMainInvokeEvent } from 'electron'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { backendManager } from './backend'
import { SettingsService } from './settings'
import { StorageService } from './storage'
import { ExternalEditService } from './external-edit'
import { LanService } from './lan'
import { launchEditor, validateEditor } from './editor'
import { adoptLegacyDirectory, legacyDataDirectory } from './data-home'
import { cancelTransfer, downloadTo, listLocalDirectory, listLocalFiles, uploadFrom } from './transfer'
import { validateSettings, type StorageLocationId } from '../shared/settings'
import type { OpenFileRequest } from '../shared/external'
import type { LanFileNotice } from '../shared/lan'

let settings: SettingsService
let storage: StorageService
let edits: ExternalEditService
let lan: LanService
const approvedEditors = new Set<string>()
let exitAllowed = false
let exitChecking = false

function trusted(event: IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('不允许的 IPC 来源')
}

function registerServices(): void {
  ipcMain.handle('storage:read', event => { trusted(event); return storage.read() })
  ipcMain.handle('storage:open', (event, id: StorageLocationId) => { trusted(event); return storage.open(id) })
  ipcMain.handle('storage:copy', (event, id: StorageLocationId) => { trusted(event); return storage.copy(id) })
  ipcMain.handle('settings:read', event => { trusted(event); return settings.get() })
  ipcMain.handle('settings:save', async (event, input: unknown) => {
    trusted(event)
    const value = validateSettings(input)
    if (value.editor.path && !approvedEditors.has(value.editor.path)) throw new Error('请通过系统选择器选择编辑器')
    if (value.editor.mode === 'custom') await validateEditor(value.editor.path)
    return settings.save(value)
  })
  ipcMain.handle('editor:choose', async event => {
    trusted(event)
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '选择文本编辑器', properties: ['openFile'],
      filters: process.platform === 'win32' ? [{ name: '编辑器', extensions: ['exe'] }] : undefined
    })
    if (result.canceled || !result.filePaths[0]) return null
    const file = result.filePaths[0]
    await validateEditor(file)
    approvedEditors.add(file)
    return file
  })
  ipcMain.handle('edits:list', event => { trusted(event); return edits.refresh() })
  ipcMain.handle('edits:open', (event, input: OpenFileRequest) => { trusted(event); return edits.open(input) })
  ipcMain.handle('edits:reopen', (event, id: string, useDefault: boolean) => { trusted(event); return edits.reopen(id, useDefault === true) })
  ipcMain.handle('edits:upload', (event, id: string, hash: string) => { trusted(event); return edits.upload(id, hash) })
  ipcMain.handle('edits:reload', (event, id: string) => { trusted(event); return edits.reload(id) })
  ipcMain.handle('edits:detach', (event, sessionId: string) => { trusted(event); return edits.detach(sessionId) })
  ipcMain.handle('dialog:save', async (event, name: string) => {
    trusted(event)
    const result = await dialog.showSaveDialog(mainWindow!, { defaultPath: typeof name === 'string' ? name : 'download' })
    return result.canceled ? null : result.filePath
  })
  ipcMain.handle('dialog:directory', async event => {
    trusted(event)
    const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : result.filePaths[0] ?? null
  })
  ipcMain.handle('files:list-local', (event, root: string) => { trusted(event); return listLocalFiles(root) })
  ipcMain.handle('files:list-local-dir', (event, directory: string) => { trusted(event); return listLocalDirectory(directory) })
  ipcMain.handle('files:download', (event, input) => {
    trusted(event)
    const info = backendManager.backendInfo
    if (!info || !mainWindow) throw new Error('后端尚未就绪')
    return downloadTo(mainWindow, info, input)
  })
  ipcMain.handle('files:upload', (event, input) => {
    trusted(event)
    const info = backendManager.backendInfo
    if (!info || !mainWindow) throw new Error('后端尚未就绪')
    return uploadFrom(mainWindow, info, input)
  })
  ipcMain.handle('files:cancel', (event, id: string) => { trusted(event); cancelTransfer(id) })
  ipcMain.handle('lan:state', event => { trusted(event); return lan.state() })
  ipcMain.handle('lan:set-enabled', (event, enabled: unknown) => { trusted(event); return lan.setEnabled(enabled === true) })
  ipcMain.handle('lan:set-name', (event, name: unknown) => { trusted(event); return lan.setName(typeof name === 'string' ? name : '') })
  ipcMain.handle('lan:set-avatar', (event, avatar: unknown) => { trusted(event); return lan.setAvatar(avatar) })
  ipcMain.handle('lan:share', (event, targetId: unknown, host: unknown) => { trusted(event); return lan.shareHost(typeof targetId === 'string' ? targetId : '', host) })
  ipcMain.handle('lan:notify-file', (event, input: unknown) => { trusted(event); lan.notifyFile(input as LanFileNotice) })
  ipcMain.handle('lan:mark-read', event => { trusted(event); return lan.markRead() })
  ipcMain.handle('lan:start-terminal-share', (event, input: unknown) => { trusted(event); return lan.startTerminalShare(input as { title: string; hostName: string }) })
  ipcMain.handle('lan:stop-terminal-share', (event, id: unknown) => { trusted(event); lan.stopTerminalShare(typeof id === 'string' ? id : '') })
  ipcMain.handle('lan:join-terminal', (event, id: unknown) => { trusted(event); lan.joinTerminal(typeof id === 'string' ? id : '') })
  ipcMain.handle('lan:leave-terminal', (event, id: unknown) => { trusted(event); lan.leaveTerminal(typeof id === 'string' ? id : '') })
  ipcMain.handle('lan:terminal-output', (event, id: unknown, data: unknown) => { trusted(event); if (typeof id === 'string' && typeof data === 'string') lan.sendTerminalOutput(id, data) })
  ipcMain.handle('lan:assist-send', (event, peerId: unknown, payload: unknown) => { trusted(event); return lan.sendAssist(typeof peerId === 'string' ? peerId : '', payload as Record<string, unknown>) })
  ipcMain.handle('recording:save', async (event, input: unknown) => {
    trusted(event)
    const payload = input as { name?: unknown; content?: unknown }
    if (typeof payload?.content !== 'string') throw new Error('录制内容无效')
    if (payload.content.length > 50 * 1024 * 1024) throw new Error('录制内容超过 50 MiB')
    const name = path.basename(typeof payload.name === 'string' ? payload.name : 'terminal-recording.txt').replace(/[\x00-\x1f\x7f]/g, '')
    const result = await dialog.showSaveDialog(mainWindow!, { defaultPath: path.join(app.getPath('downloads'), name.endsWith('.txt') ? name : `${name}.txt`) })
    if (result.canceled || !result.filePath) return null
    await fsp.writeFile(result.filePath, payload.content, 'utf8')
    return result.filePath
  })
  ipcMain.handle('clipboard:write', (event, text: string) => {
    trusted(event)
    if (typeof text !== 'string' || text.length > 1_000_000) throw new Error('无法复制')
    clipboard.writeText(text)
  })
}

async function confirmExit(): Promise<void> {
  if (exitChecking) return
  exitChecking = true
  try {
    if (await edits.hasPending()) {
      const result = await dialog.showMessageBox(mainWindow!, {
        type: 'warning', title: '保留未回传的修改？',
        message: '仍有未回传修改或传输中的文件。退出后保留本地草稿，下次启动可恢复，不会自动上传。',
        buttons: ['取消退出', '保留草稿并退出'], defaultId: 0, cancelId: 0
      })
      if (result.response !== 1) return
    }
    lan?.stop()
    await edits.stop()
    await backendManager.stop()
    exitAllowed = true
    app.quit()
  } catch (error) {
    dialog.showErrorBox('无法安全退出', (error as Error).message)
  } finally { exitChecking = false }
}

// 是否开发态(electron-vite 注入)
const isDev = !!process.env['ELECTRON_RENDERER_URL']

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: 'Shell Helper',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    // 启动/缩放时使用当前外观底色，避免白闪或深浅错位
    backgroundColor: settings.get().settings.appearance === 'dark' || (settings.get().settings.appearance === 'system' && nativeTheme.shouldUseDarkColors) ? '#151517' : '#F5F6F7',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('close', event => {
    if (!exitAllowed) { event.preventDefault(); void confirmExit() }
  })
  mainWindow.webContents.on('will-navigate', event => event.preventDefault())

  // 外链用系统浏览器打开,禁止窗口内导航
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // macOS 隐藏原生标题栏后，把 inset 标记传给渲染层，仅这里需要给红绿灯留出空间
  const insetTitlebar = process.platform === 'darwin'
  if (isDev) {
    const url = new URL(process.env['ELECTRON_RENDERER_URL']!)
    if (insetTitlebar) url.searchParams.set('titlebar', 'inset')
    mainWindow.loadURL(url.toString())
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'), insetTitlebar ? { query: { titlebar: 'inset' } } : undefined)
  }
}

// ---- IPC: 前端获取后端连接信息(baseUrl + token) ----
ipcMain.handle('backend:info', async () => {
  const info = await backendManager.start()
  return {
    baseUrl: `http://${info.host}:${info.port}`,
    wsUrl: `ws://${info.host}:${info.port}`,
    token: info.token
  }
})

ipcMain.handle('app:version', () => app.getVersion())

function bootstrap(): void {
  if (process.platform === 'win32') app.setAppUserModelId('com.shellhelper.app')
  app.whenReady().then(async () => {
    const userData = app.getPath('userData')
    const home = app.getPath('home')
    adoptLegacyDirectory(legacyDataDirectory({
      home, platform: process.platform,
      appData: process.env.APPDATA, xdgDataHome: process.env.XDG_DATA_HOME
    }), userData, home)
    storage = new StorageService({
      userData, backend: () => backendManager.start(),
      openPath: directory => shell.openPath(directory), copyText: text => clipboard.writeText(text)
    })
    settings = new SettingsService(path.join(userData, 'settings.json'))
    await settings.load()
    if (settings.get().settings.editor.path) approvedEditors.add(settings.get().settings.editor.path)
    edits = new ExternalEditService(path.join(userData, 'drafts'), {
      editor: () => settings.get().settings.editor,
      launch: launchEditor,
      changed: items => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('edits:changed', items) },
      request: async (route, init) => {
        const info = await backendManager.start()
        return fetch(`http://${info.host}:${info.port}${route}`, {
          ...init, headers: { ...init?.headers, Authorization: `Bearer ${info.token}` },
          signal: AbortSignal.timeout(120000), redirect: 'error'
        })
      }
    })
    await edits.initialize()
    lan = new LanService(userData)
    lan.subscribe(state => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('lan:update', state)
      }
    })
    lan.subscribeTerminal(payload => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('lan:terminal-output', payload)
      }
    })
    lan.subscribeAssist(payload => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('lan:assist', payload)
      }
    })
    lan.init()
    session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
      callback({ video: sources[0] })
    })
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
      callback(permission === 'media' || permission === 'display-capture')
    })
    registerServices()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  }).catch(error => {
    dialog.showErrorBox('启动失败', (error as Error).message)
    exitAllowed = true
    app.quit()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  // 退出前优雅关闭后端
  app.on('before-quit', (e) => {
    if (exitAllowed) { lan?.stop(); return }
    e.preventDefault()
    if (edits) void confirmExit()
  })
}

bootstrap()
