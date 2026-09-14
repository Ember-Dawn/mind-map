import { getImageSize } from 'simple-mind-map/src/utils/index'

const STORAGE_KEY = 'SIMPLE_MIND_MAP_IMAGE_HOST_CONFIG'

const DEFAULT_CONFIG = {
  enabled: false,
  provider: 'easyimages2',
  url: '',
  token: ''
}

const cloneConfig = config => ({
  ...DEFAULT_CONFIG,
  ...(config && typeof config === 'object' ? config : {})
})

export const normalizeImageHostConfig = config => {
  const normalized = cloneConfig(config)
  normalized.enabled = Boolean(normalized.enabled)
  normalized.provider = String(normalized.provider || 'easyimages2').trim()
  normalized.url = String(normalized.url || '').trim()
  normalized.token = String(normalized.token || '').trim()
  return normalized
}

export const getStoredImageHostConfig = () => {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (!stored) return cloneConfig()
  try {
    return normalizeImageHostConfig(JSON.parse(stored))
  } catch (error) {
    console.warn('[Image Upload] Failed to parse stored image host config:', error)
    return cloneConfig()
  }
}

export const storeImageHostConfig = config => {
  const normalized = normalizeImageHostConfig(config)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized))
  return normalized
}

const getRuntimeImageHostConfig = () => {
  if (
    !window.nocodbMindMapEmbedMode ||
    !window.nocodbMindMapEmbed ||
    typeof window.nocodbMindMapEmbed.getImageUploadConfig !== 'function'
  ) {
    return null
  }

  const runtimeConfig = window.nocodbMindMapEmbed.getImageUploadConfig()
  if (!runtimeConfig || typeof runtimeConfig !== 'object') return null
  return normalizeImageHostConfig(runtimeConfig)
}

export const getEffectiveImageHostConfig = () => {
  const runtimeConfig = getRuntimeImageHostConfig()
  if (runtimeConfig) {
    return {
      ...runtimeConfig,
      source: 'runtime'
    }
  }

  return {
    ...getStoredImageHostConfig(),
    source: 'web'
  }
}

const blobToDataUrl = blob => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('读取图片失败。'))
    reader.readAsDataURL(blob)
  })
}

const getBlobImageSize = async blob => {
  const objectUrl = URL.createObjectURL(blob)
  try {
    return await getImageSize(objectUrl)
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

const normalizeEasyImagesApiUrl = value => {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (/\/api\/index\.php(?:\?.*)?$/i.test(raw)) return raw
  return `${raw.replace(/\/+$/, '')}/api/index.php`
}

const uploadToEasyImages2 = async (blob, config) => {
  const apiUrl = normalizeEasyImagesApiUrl(config.url)
  if (!apiUrl || !config.token) {
    throw new Error('EasyImages2.0 已启用，但图床地址或 Token 未配置完整。')
  }

  const fileName = blob instanceof File && blob.name ? blob.name : 'clipboard.png'
  const formData = new FormData()
  formData.append('image', blob, fileName)
  formData.append('token', config.token)

  let response
  try {
    response = await fetch(apiUrl, {
      method: 'POST',
      body: formData
    })
  } catch (error) {
    throw new Error(`EasyImages2.0 上传请求失败：${error?.message || '网络错误'}`)
  }

  const text = await response.text()
  let result = null
  try {
    result = text ? JSON.parse(text) : null
  } catch (error) {
    throw new Error(`EasyImages2.0 返回了无法解析的响应（HTTP ${response.status}）。`)
  }

  if (
    !response.ok ||
    !result ||
    result.result !== 'success' ||
    !result.url
  ) {
    const message = result?.message || result?.result || `HTTP ${response.status}`
    throw new Error(`EasyImages2.0 上传失败：${message}`)
  }

  return String(result.url)
}

export const uploadImage = async blob => {
  if (!(blob instanceof Blob)) {
    throw new Error('没有可上传的图片文件。')
  }

  const config = getEffectiveImageHostConfig()
  const size = await getBlobImageSize(blob)

  if (!config.enabled) {
    return {
      url: await blobToDataUrl(blob),
      size
    }
  }

  if (config.provider !== 'easyimages2') {
    throw new Error(`暂不支持图床类型：${config.provider}`)
  }

  const url = await uploadToEasyImages2(blob, config)
  return {
    url,
    size
  }
}
