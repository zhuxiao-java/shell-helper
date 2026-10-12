import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import 'element-plus/dist/index.css'
import {
  ArrowDown, ArrowLeft, ArrowRight, Bottom, Box, CaretRight, Cellphone, Close, Coin, Connection,
  CopyDocument, Cpu, Delete, Document, DocumentAdd, DocumentCopy, Download, Edit, EditPen, Expand,
  Fold, Folder, FolderAdd, FolderOpened, House, Link, Loading, Lock, Monitor, MoreFilled, Picture,
  Plus, Pointer, Refresh, Right, Search, Setting, Tickets, Top, TopRight, Upload, Warning, WarningFilled
} from '@element-plus/icons-vue'
import '@xterm/xterm/css/xterm.css'
import './styles/main.scss'
import App from './App.vue'

const icons = {
  ArrowDown, ArrowLeft, ArrowRight, Bottom, Box, CaretRight, Cellphone, Close, Coin, Connection,
  CopyDocument, Cpu, Delete, Document, DocumentAdd, DocumentCopy, Download, Edit, EditPen, Expand,
  Fold, Folder, FolderAdd, FolderOpened, House, Link, Loading, Lock, Monitor, MoreFilled, Picture,
  Plus, Pointer, Refresh, Right, Search, Setting, Tickets, Top, TopRight, Upload, Warning, WarningFilled
}

// 外壳默认浅色，可在设置里改为深色或跟随系统；终端区域保持深色
const app = createApp(App)
app.use(createPinia())
app.use(ElementPlus, { locale: zhCn })
for (const [name, comp] of Object.entries(icons)) app.component(name, comp)
app.mount('#app')
