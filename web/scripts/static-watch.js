const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const chokidar = require('chokidar')

const webDir = path.resolve(__dirname, '..')
const outputRoot = process.env.STATIC_OUTPUT_DIR || '/site'
const buildDir = path.join('/tmp', 'mind-map-static-build')
const currentLink = path.join(outputRoot, 'current')
const debounceMs = 700

let buildRunning = false
let buildQueued = false
let debounceTimer = null
let shuttingDown = false

const log = message => {
  console.log(`[static-build] ${new Date().toISOString()} ${message}`)
}

const removeIfExists = target => {
  fs.rmSync(target, { recursive: true, force: true })
}

const copyBuildToRelease = releaseDir => {
  fs.mkdirSync(path.join(releaseDir, 'dist'), { recursive: true })

  for (const entry of fs.readdirSync(buildDir, { withFileTypes: true })) {
    const src = path.join(buildDir, entry.name)
    if (entry.name === 'index.html') {
      fs.copyFileSync(src, path.join(releaseDir, 'index.html'))
      continue
    }
    fs.cpSync(src, path.join(releaseDir, 'dist', entry.name), {
      recursive: true
    })
  }
}

const publishBuild = () => {
  fs.mkdirSync(outputRoot, { recursive: true })

  let previousRelease = null
  try {
    if (fs.lstatSync(currentLink).isSymbolicLink()) {
      previousRelease = fs.readlinkSync(currentLink)
    }
  } catch (_) {}

  const releaseName = `.release-${Date.now()}-${process.pid}`
  const releaseDir = path.join(outputRoot, releaseName)
  const nextLink = path.join(outputRoot, '.current-next')

  removeIfExists(releaseDir)
  copyBuildToRelease(releaseDir)
  fs.writeFileSync(
    path.join(releaseDir, 'build.json'),
    `${JSON.stringify({ builtAt: new Date().toISOString() }, null, 2)}\n`
  )

  removeIfExists(nextLink)
  fs.symlinkSync(releaseName, nextLink)
  fs.renameSync(nextLink, currentLink)

  if (previousRelease && previousRelease !== releaseName) {
    removeIfExists(path.join(outputRoot, previousRelease))
  }
}

const runVueBuild = () =>
  new Promise((resolve, reject) => {
    removeIfExists(buildDir)

    const command = path.join(webDir, 'node_modules', '.bin', 'vue-cli-service')
    const child = spawn(command, ['build', '--dest', buildDir], {
      cwd: webDir,
      env: {
        ...process.env,
        NODE_ENV: 'production'
      },
      stdio: 'inherit'
    })

    child.on('error', reject)
    child.on('exit', code => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`vue-cli-service build exited with code ${code}`))
      }
    })
  })

const buildAndPublish = async reason => {
  if (buildRunning) {
    buildQueued = true
    return
  }

  buildRunning = true
  const startedAt = Date.now()
  log(`build started (${reason})`)

  try {
    await runVueBuild()
    publishBuild()
    log(`build published in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
  } catch (error) {
    console.error('[static-build] build failed:', error)
  } finally {
    buildRunning = false
    if (buildQueued && !shuttingDown) {
      buildQueued = false
      void buildAndPublish('queued changes')
    }
  }
}

const scheduleBuild = changedPath => {
  if (shuttingDown) return
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    void buildAndPublish(`change: ${path.relative(webDir, changedPath)}`)
  }, debounceMs)
}

const watchedPaths = [
  path.join(webDir, 'src'),
  path.join(webDir, 'public'),
  path.join(webDir, 'vue.config.js')
]

const watcher = chokidar.watch(watchedPaths, {
  ignoreInitial: true,
  persistent: true,
  usePolling: process.env.CHOKIDAR_USEPOLLING === 'true',
  interval: 1000,
  awaitWriteFinish: {
    stabilityThreshold: 500,
    pollInterval: 100
  }
})

watcher.on('all', (_event, changedPath) => {
  scheduleBuild(changedPath)
})

watcher.on('error', error => {
  console.error('[static-build] watcher error:', error)
})

const shutdown = async () => {
  if (shuttingDown) return
  shuttingDown = true
  if (debounceTimer) clearTimeout(debounceTimer)
  await watcher.close()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

void buildAndPublish('initial build')
