import './nocodb-bridge'
import Vue from 'vue'
import App from './App.vue'
import router from './router'
import store from './store'
import ElementUI from 'element-ui'
import 'element-ui/lib/theme-chalk/index.css'
import '@/assets/icon-font/iconfont.css'
import 'viewerjs/dist/viewer.css'
import VueViewer from 'v-viewer'
import i18n from './i18n'
import { getLang } from '@/api'
// import VConsole from 'vconsole'
// const vConsole = new VConsole()

Vue.config.productionTip = false
const bus = new Vue()
Vue.prototype.$bus = bus
Vue.use(ElementUI)
Vue.use(VueViewer)

const initApp = () => {
  i18n.locale = getLang()
  new Vue({
    render: h => h(App),
    router,
    store,
    i18n
  }).$mount('#app')
}

// NocoDB embed mode waits for the parent to provide record data before Vue starts.
if (window.nocodbMindMapEmbedMode) {
  window.initApp = initApp
  window.$bus = bus
} else if (window.takeOverApp) {
  // Keep the upstream takeover mode for non-NocoDB integrations.
  window.initApp = initApp
  window.$bus = bus
} else {
  initApp()
}
