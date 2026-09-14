const params = new URLSearchParams(window.location.search)
const isEmbedMode = params.get('embed') === '1'

if (isEmbedMode) {
  const parentOrigin = params.get('parentOrigin') || '*'
  const AUTO_SAVE_DELAY_MS = 2000

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

  const getSignature = value => JSON.stringify(value)

  const state = {
    initialized: false,
    appStarted: false,
    startTimer: null,
    settleTimer: null,
    autoSaveTimer: null,
    dirtyMarkQueued: false,
    mindMap: null,
    initialData: null,
    imageUploadConfig: null,
    baselineSignature: '',
    lastObservedSignature: '',
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

  const clearAutoSave = () => {
    if (!state.autoSaveTimer) return
    window.clearTimeout(state.autoSaveTimer)
    state.autoSaveTimer = null
  }

  const setDirty = (dirty, { forceNotify = false } = {}) => {
    const next = Boolean(dirty)
    const changed = state.dirty !== next
    state.dirty = next
    if (changed || forceNotify) {
      postToParent('mindmap:dirty', {
        dirty: state.dirty,
        revision: state.revision
      })
    }
  }

  const requestSave = data => {
    clearAutoSave()
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

  const scheduleAutoSave = () => {
    clearAutoSave()
    if (!state.initialized || !state.dirty) return
    state.autoSaveTimer = window.setTimeout(() => {
      state.autoSaveTimer = null
      if (!state.initialized || !state.dirty) return
      requestSave()
    }, AUTO_SAVE_DELAY_MS)
  }

  const markDirty = () => {
    if (!state.initialized || state.dirtyMarkQueued) return
    state.dirtyMarkQueued = true
    queueMicrotask(() => {
      state.dirtyMarkQueued = false
      if (!state.initialized) return

      const currentData = getCurrentData()
      if (!currentData) return
      const signature = getSignature(currentData)
      if (signature === state.lastObservedSignature) return

      state.lastObservedSignature = signature
      state.revision += 1
      const dirty = signature !== state.baselineSignature
      setDirty(dirty, { forceNotify: true })
      if (dirty) {
        scheduleAutoSave()
      } else {
        clearAutoSave()
      }
    })
  }

  const finishInitialization = () => {
    if (state.initialized || !state.mindMap) return
    if (state.settleTimer) {
      window.clearTimeout(state.settleTimer)
      state.settleTimer = null
    }

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (state.initialized || !state.mindMap) return
        const currentData = getCurrentData()
        state.baselineSignature = getSignature(currentData)
        state.lastObservedSignature = state.baselineSignature
        state.revision = 0
        state.initialized = true
        state.dirty = state.initialDirty
        postToParent('mindmap:app-ready')
        if (state.dirty) {
          setDirty(true, { forceNotify: true })
          scheduleAutoSave()
        }
      })
    })
  }

  const waitForInitialRender = () => {
    if (state.initialized || !state.mindMap) return
    const renderer = state.mindMap.renderer
    if (renderer && renderer.isRendering) {
      state.settleTimer = window.setTimeout(waitForInitialRender, 50)
      return
    }
    finishInitialization()
  }

  const attachMindMap = mindMap => {
    if (!mindMap || state.mindMap) return
    state.mindMap = mindMap

    if (typeof mindMap.on === 'function') {
      mindMap.on('data_change', markDirty)
      mindMap.on('view_data_change', markDirty)
      mindMap.on('view_theme_change', markDirty)
      mindMap.on('node_tree_render_end', finishInitialization)
    }

    // Initial rendering can emit document/view events. Keep the loading cover up
    // and establish the baseline only after the renderer has settled.
    state.settleTimer = window.setTimeout(waitForInitialRender, 50)
  }

  window.nocodbMindMapEmbed = {
    getInitialData() {
      return cloneJson(state.initialData)
    },
    getImageUploadConfig() {
      return cloneJson(state.imageUploadConfig)
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
      case 'mindmap:hello':
        postToParent('mindmap:ready')
        break
      case 'mindmap:init':
        if (state.appStarted) return
        if (!message.data || typeof message.data !== 'object') return
        state.initialData = cloneJson(message.data)
        state.imageUploadConfig = cloneJson(message.imageUploadConfig || null)
        state.initialDirty = Boolean(message.dirty)
        state.dirty = state.initialDirty
        state.revision = 0
        startApp()
        break
      case 'mindmap:image-upload-config':
        state.imageUploadConfig = cloneJson(message.imageUploadConfig || null)
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
          const currentData = getCurrentData()
          state.baselineSignature = getSignature(currentData)
          state.lastObservedSignature = state.baselineSignature
          clearAutoSave()
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
