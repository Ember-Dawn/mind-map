const params = new URLSearchParams(window.location.search)
const isEmbedMode = params.get('embed') === '1'

if (isEmbedMode) {
  const parentOrigin = params.get('parentOrigin') || '*'
  const CONFIG_KEY = 'NOCODB_MINDMAP_CONFIG'
  const LANG_KEY = 'NOCODB_MINDMAP_LANG'
  const LOCAL_CONFIG_KEY = 'NOCODB_MINDMAP_LOCAL_CONFIG'

  const readJson = key => {
    try {
      const value = localStorage.getItem(key)
      return value ? JSON.parse(value) : null
    } catch (error) {
      console.warn('[NocoDB MindMap Bridge] Failed to read local config:', error)
      return null
    }
  }

  const state = {
    initialized: false,
    appStarted: false,
    startTimer: null,
    dirtyMarkQueued: false,
    mindMap: null,
    mindMapData: null,
    mindMapConfig: readJson(CONFIG_KEY),
    language: localStorage.getItem(LANG_KEY) || 'zh',
    localConfig: readJson(LOCAL_CONFIG_KEY),
    dirty: false,
    initialDirty: false,
    revision: 0,
    lastSaveRequestId: 0,
    pendingSaves: new Map()
  }

  // Avoid the standalone Web trial prompt when the app is embedded in NocoDB.
  localStorage.setItem('webUseTip', '1')
  document.documentElement.classList.add('nocodb-mindmap-embed')

  const postToParent = (type, payload = {}) => {
    if (window.parent === window) return
    window.parent.postMessage(
      {
        source: 'mind-map-web',
        type,
        ...payload
      },
      parentOrigin
    )
  }

  const getCurrentData = () => {
    if (state.mindMap && typeof state.mindMap.getData === 'function') {
      state.mindMapData = state.mindMap.getData(true)
    }
    return state.mindMapData
  }

  const setDirty = dirty => {
    const next = Boolean(dirty)
    if (state.dirty === next) return
    state.dirty = next
    postToParent('mindmap:dirty', { dirty: state.dirty })
  }

  const markDirty = () => {
    if (!state.initialized || state.dirtyMarkQueued) return
    state.dirtyMarkQueued = true
    queueMicrotask(() => {
      state.dirtyMarkQueued = false
      if (!state.initialized) return
      state.revision += 1
      setDirty(true)
    })
  }

  const requestSave = () => {
    const data = getCurrentData()
    if (!data) return

    state.lastSaveRequestId += 1
    const requestId = state.lastSaveRequestId
    state.pendingSaves.set(requestId, state.revision)
    postToParent('mindmap:save', {
      requestId,
      revision: state.revision,
      data
    })
  }

  window.takeOverApp = true
  window.takeOverAppMethods = {
    getMindMapData() {
      return state.mindMapData
    },
    saveMindMapData(data) {
      state.mindMapData = data
      markDirty()
    },
    getMindMapConfig() {
      return state.mindMapConfig
    },
    saveMindMapConfig(config) {
      state.mindMapConfig = config
      localStorage.setItem(CONFIG_KEY, JSON.stringify(config || {}))
    },
    getLanguage() {
      return state.language || 'zh'
    },
    saveLanguage(language) {
      state.language = language || 'zh'
      localStorage.setItem(LANG_KEY, state.language)
    },
    getLocalConfig() {
      return state.localConfig
    },
    saveLocalConfig(config) {
      state.localConfig = config
      localStorage.setItem(LOCAL_CONFIG_KEY, JSON.stringify(config || {}))
    },
    requestSave
  }

  const finishAppInit = mindMap => {
    state.mindMap = mindMap || state.mindMap

    if (
      state.mindMap &&
      state.mindMapData &&
      typeof state.mindMap.setFullData === 'function'
    ) {
      state.mindMap.setFullData(state.mindMapData)
    }

    window.requestAnimationFrame(() => {
      if (state.mindMap && typeof state.mindMap.on === 'function') {
        state.mindMap.on('data_change', markDirty)
        state.mindMap.on('view_data_change', markDirty)
      }

      state.initialized = true
      state.dirty = state.initialDirty
      state.revision = 0
      postToParent('mindmap:app-ready')
      if (state.dirty) {
        postToParent('mindmap:dirty', { dirty: true })
      }
    })
  }

  const startApp = () => {
    if (state.appStarted) return
    if (typeof window.initApp !== 'function') {
      if (!state.startTimer) {
        state.startTimer = window.setTimeout(() => {
          state.startTimer = null
          startApp()
        }, 0)
      }
      return
    }

    state.appStarted = true

    if (window.$bus) {
      window.$bus.$once('app_inited', mindMap => {
        finishAppInit(mindMap)
      })
    }

    window.initApp()

    if (!window.$bus) {
      window.setTimeout(() => {
        finishAppInit(null)
      }, 0)
    }
  }

  const handleMessage = event => {
    if (event.source !== window.parent) return
    if (parentOrigin !== '*' && event.origin !== parentOrigin) return

    const message = event.data
    if (!message || message.source !== 'nocodb-mindmap') return

    switch (message.type) {
      case 'mindmap:init':
        if (!message.data || typeof message.data !== 'object') return
        state.mindMapData = message.data
        if (message.config) state.mindMapConfig = message.config
        if (message.language) state.language = message.language
        if (message.localConfig) state.localConfig = message.localConfig
        state.initialDirty = Boolean(message.dirty)
        state.dirty = state.initialDirty
        state.revision = 0
        startApp()
        break
      case 'mindmap:request-save':
        requestSave()
        break
      case 'mindmap:request-data':
        postToParent('mindmap:data', {
          data: getCurrentData(),
          dirty: state.dirty,
          revision: state.revision
        })
        break
      case 'mindmap:save-result': {
        const requestId = Number(message.requestId || 0)
        const savedRevision = state.pendingSaves.get(requestId)
        state.pendingSaves.delete(requestId)
        if (message.ok && savedRevision === state.revision) {
          setDirty(false)
        }
        postToParent('mindmap:save-status', {
          requestId: requestId || null,
          ok: Boolean(message.ok),
          error: message.error || ''
        })
        break
      }
      default:
        break
    }
  }

  window.addEventListener('message', handleMessage)
  window.addEventListener(
    'keydown',
    event => {
      const key = String(event.key || '').toLowerCase()
      if ((event.ctrlKey || event.metaKey) && key === 's') {
        event.preventDefault()
        requestSave()
      }
    },
    true
  )

  // main.js installs window.initApp after imports complete. The ready signal lets
  // the parent send mindmap:init only after this bridge is available.
  window.setTimeout(() => {
    postToParent('mindmap:ready')
  }, 0)
}
