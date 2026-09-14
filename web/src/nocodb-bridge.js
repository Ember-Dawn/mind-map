const params = new URLSearchParams(window.location.search)
const isEmbedMode = params.get('embed') === '1'

if (isEmbedMode) {
  const parentOrigin = params.get('parentOrigin') || '*'

  const cloneJson = value => {
    if (value === null || value === undefined) return value
    if (typeof structuredClone === 'function') {
      try {
        return structuredClone(value)
      } catch (error) {
        console.warn('[NocoDB MindMap Bridge] structuredClone failed:', error)
      }
    }
    return JSON.parse(JSON.stringify(value))
  }

  const state = {
    initialized: false,
    appStarted: false,
    startTimer: null,
    dirtyMarkQueued: false,
    mindMap: null,
    initialData: null,
    dirty: false,
    initialDirty: false,
    revision: 0,
    lastSaveRequestId: 0,
    pendingSaves: new Map()
  }

  window.nocodbMindMapEmbedMode = true

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
      return cloneJson(state.mindMap.getData(true))
    }
    return cloneJson(state.initialData)
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

  const requestSave = data => {
    const currentData = data ? cloneJson(data) : getCurrentData()
    if (!currentData) return

    state.lastSaveRequestId += 1
    const requestId = state.lastSaveRequestId
    state.pendingSaves.set(requestId, state.revision)
    postToParent('mindmap:save', {
      requestId,
      revision: state.revision,
      data: currentData
    })
  }

  const attachMindMap = mindMap => {
    if (!mindMap || state.initialized) return
    state.mindMap = mindMap

    if (typeof mindMap.on === 'function') {
      mindMap.on('data_change', markDirty)
      mindMap.on('view_data_change', markDirty)
      mindMap.on('view_theme_change', markDirty)
    }

    state.initialized = true
    state.dirty = state.initialDirty
    state.revision = 0
    postToParent('mindmap:app-ready')
    if (state.dirty) {
      postToParent('mindmap:dirty', { dirty: true })
    }
  }

  window.nocodbMindMapEmbed = {
    getInitialData() {
      return cloneJson(state.initialData)
    },
    attachMindMap,
    markDirty,
    requestSave
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
    window.initApp()
  }

  const handleMessage = event => {
    if (event.source !== window.parent) return
    if (parentOrigin !== '*' && event.origin !== parentOrigin) return

    const message = event.data
    if (!message || message.source !== 'nocodb-mindmap') return

    switch (message.type) {
      case 'mindmap:init':
        if (state.appStarted) return
        if (!message.data || typeof message.data !== 'object') return
        state.initialData = cloneJson(message.data)
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

  // The parent can send mindmap:init after this signal. Vue is intentionally not
  // started until that message arrives, so upstream example/local document data
  // can never render before the NocoDB record document.
  window.setTimeout(() => {
    postToParent('mindmap:ready')
  }, 0)
}
