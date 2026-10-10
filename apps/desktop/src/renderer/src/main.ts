import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import 'element-plus/dist/index.css'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'
import '@xterm/xterm/css/xterm.css'
import './styles/main.scss'
import App from './App.vue'

// 外壳默认浅色，可在设置里改为深色或跟随系统；终端区域保持深色
const app = createApp(App)
app.use(createPinia())
app.use(ElementPlus, { locale: zhCn })
for (const [name, comp] of Object.entries(ElementPlusIconsVue)) {
  app.component(name, comp)
}
app.mount('#app')
