import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import {
  availableVideoExpressCapacity,
  buildVideoExpressConsistentCharacterPayload,
  buildVideoExpressGeneratedStillPreviewUrl,
  buildVideoExpressGeneratedStillVideoPayload,
  buildVideoExpressGenerationPayload,
  buildWindowsUserEnvReadScript,
  countActiveVideoExpressQueue,
  extractVideoExpressDownloadRecord,
  extractVideoExpressVideoId,
  isParallelVideoExpressLimit,
  isUncertainVideoExpressStateStatus,
  isValidVideoExpressImageHeader,
  isValidVideoExpressMp4Header,
  mapVideoExpressStatus,
  normalizeVideoExpressManifest,
  parseVideoExpressLoginCsrf,
  resolveGeneratedStillCheckpointStatus,
  shouldRetryVideoExpressFailure,
  videoExpressDefaultPollIntervalMs,
  videoExpressLibraryId,
  videoExpressMaxConcurrency
} from './videoexpress-config.mjs'

const host = 'https://app.videoexpress.ai'
const preflightOnly = process.argv.includes('--preflight')
const jobRootArg = process.argv.slice(2).find((value) => !value.startsWith('--'))

if (!preflightOnly && !jobRootArg) {
  throw new Error('Usage: node run-videoexpress.mjs <job-root> | --preflight')
}

function readCredential(name) {
  if (process.env[name]) return process.env[name]
  if (process.platform !== 'win32') return ''
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-Command',
    buildWindowsUserEnvReadScript(name)
  ], { encoding: 'utf8', windowsHide: true })
  if (result.status === 0 && String(result.stdout || '').trim()) return String(result.stdout || '').trim()
  // Approved local fallback for this production workspace. Keep values in memory;
  // never print or persist them.
  const fallbackPath = 'D:\\Work\\video-automation.env'
  try {
    const line = readFileSync(fallbackPath, 'utf8').split(/\r?\n/).find((entry) =>
      new RegExp(`^\\s*${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*=`).test(entry)
    )
    return line ? line.slice(line.indexOf('=') + 1).trim().replace(/^['"]|['"]$/g, '') : ''
  } catch {
    return ''
  }
}

const email = readCredential('VIDEOEXPRESS_EMAIL')
const password = readCredential('VIDEOEXPRESS_PASSWORD')
if (!email || !password) throw new Error('Video Express credentials are unavailable')

const sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds))

class VideoExpressHttpError extends Error {
  constructor(message, status, bodyText = '') {
    super(message)
    this.name = 'VideoExpressHttpError'
    this.status = status
    this.bodyText = bodyText
  }
}

class VideoExpressClient {
  constructor() {
    this.cookies = new Map()
    this.csrfToken = ''
    this.csrfHeaderName = 'X-CSRF-TOKEN'
    this.loggedIn = false
  }

  absorbCookies(response) {
    const values = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean)
    for (const value of values) {
      const pair = String(value).split(';', 1)[0]
      const equals = pair.indexOf('=')
      if (equals > 0) this.cookies.set(pair.slice(0, equals), pair.slice(equals + 1))
    }
    const xsrf = this.cookies.get('XSRF-TOKEN') || this.cookies.get('CSRF-TOKEN') || this.cookies.get('csrf_token')
    if (xsrf) {
      this.csrfHeaderName = 'X-XSRF-TOKEN'
      try { this.csrfToken = decodeURIComponent(xsrf) } catch { this.csrfToken = xsrf }
    }
  }

  cookieHeader() {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
  }

  captureCsrfFromHtml(html) {
    const match = String(html || '').match(/<meta[^>]+name=["'](?:csrf-token|csrf_token|xsrf-token)["'][^>]+content=["']([^"']+)["']/i)
      || String(html || '').match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["'](?:csrf-token|csrf_token|xsrf-token)["']/i)
    if (match) {
      this.csrfHeaderName = 'X-CSRF-TOKEN'
      this.csrfToken = match[1]
    }
  }

  async raw(path, options = {}, allowRelogin = true) {
    const url = new URL(path, host)
    const sameOrigin = url.origin === host
    const headers = new Headers(options.headers || {})
    if (sameOrigin) {
      const cookies = this.cookieHeader()
      if (cookies) headers.set('Cookie', cookies)
      if (this.csrfToken && !headers.has(this.csrfHeaderName)) headers.set(this.csrfHeaderName, this.csrfToken)
      if (!headers.has('X-Requested-With')) headers.set('X-Requested-With', 'XMLHttpRequest')
    }
    const response = await fetch(url, {
      ...options,
      headers,
      redirect: options.redirect || 'manual',
      signal: options.signal || AbortSignal.timeout(120_000)
    })
    if (sameOrigin) this.absorbCookies(response)
    if (sameOrigin && allowRelogin && this.loggedIn && [401, 403, 419].includes(response.status)) {
      await this.login()
      return this.raw(path, options, false)
    }
    return response
  }

  async assertOk(response, label) {
    if (response.ok) return response
    const bodyText = await response.text().catch(() => '')
    throw new VideoExpressHttpError(`${label} failed (HTTP ${response.status})`, response.status, bodyText.slice(0, 500))
  }

  async login() {
    this.cookies.clear()
    this.csrfToken = ''
    this.loggedIn = false
    const page = await this.raw('/login', { headers: { 'X-Requested-With': '' } }, false)
    await this.assertOk(page, 'Video Express login page')
    const html = await page.text()
    const csrf = parseVideoExpressLoginCsrf(html)
    if (!csrf) throw new Error('Video Express login CSRF token was not found')
    const body = new URLSearchParams({
      _csrf_token: csrf,
      _username: email,
      _password: password
    })
    const response = await this.raw('/login_check', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': ''
      },
      body
    }, false)
    const location = response.headers.get('location') || ''
    if (response.status < 300 || response.status >= 400 || /\/login/i.test(location)) {
      throw new Error(`Video Express login failed (HTTP ${response.status})`)
    }
    const home = await this.raw('/', { headers: { 'X-Requested-With': '' } }, false)
    await this.assertOk(home, 'Video Express authenticated home')
    const homeHtml = await home.text()
    if (/name=["']_username["']|>\s*Log In\s*</i.test(homeHtml)) throw new Error('Video Express login did not establish a session')
    this.captureCsrfFromHtml(homeHtml)
    this.loggedIn = true
  }

  async json(path, label) {
    const response = await this.raw(path)
    await this.assertOk(response, label)
    return response.json()
  }

  async postForm(path, values, label) {
    const body = values instanceof URLSearchParams ? values : new URLSearchParams(values)
    const response = await this.raw(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body
    })
    await this.assertOk(response, label)
    return response.text()
  }

  async postMultipart(path, formData, label) {
    const response = await this.raw(path, { method: 'POST', body: formData })
    await this.assertOk(response, label)
    return response.text()
  }

  async getFolders() {
    const payload = await this.json(`/library/get_categories/${videoExpressLibraryId}`, 'Load Video Express folders')
    return Array.isArray(payload?.data) ? payload.data : []
  }

  async getMedia(folderId, query = '', filter = 'image', limit = 100) {
    const params = new URLSearchParams({
      categoryId: String(folderId),
      page: '1',
      start: '0',
      limit: String(limit),
      query: String(query),
      orderBy: 'name',
      orderDir: 'asc',
      filter
    })
    return this.json(`/api/library/get_media/${videoExpressLibraryId}?${params}`, `Load Video Express media for folder ${folderId}`)
  }

  async getUserQueue() {
    return this.json(`/user_queue?_=${Date.now()}`, 'Load Video Express queue')
  }

  async getStatus(uuid) {
    return this.json(`/ai/api/status/${encodeURIComponent(uuid)}?_=${Date.now()}`, `Load Video Express status ${uuid}`)
  }
}

function normalizedMediaName(value) {
  return String(value || '').replace(/\.[a-z0-9]+$/i, '').trim().toLowerCase()
}

function findNamedFolder(folders, folderName) {
  const wanted = String(folderName).trim().toLowerCase()
  return folders.find((folder) => [folder?.title, folder?.name].some((value) => String(value || '').trim().toLowerCase() === wanted)) || null
}

function getAiVideosFolder(folders) {
  return folders.find((folder) => String(folder?.name || folder?.title || '').replace(/[_\s]/g, '').toLowerCase() === 'myaivideos') || null
}

async function ensureFolder(client, folderName) {
  let folders = await client.getFolders()
  let folder = findNamedFolder(folders, folderName)
  if (folder) return { folder, folders }

  let createError = null
  try {
    await client.postForm(`/library/add_category/${videoExpressLibraryId}`, { categoryName: folderName }, 'Create Video Express folder')
  } catch (error) {
    createError = error
  }

  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (attempt > 0) await sleep(500)
    folders = await client.getFolders()
    folder = findNamedFolder(folders, folderName)
    if (folder) return { folder, folders }
  }
  if (createError) throw createError
  throw new Error(`Video Express folder creation outcome is uncertain: ${folderName}`)
}

async function findUploadedImage(client, folderId, imagePath) {
  const title = normalizedMediaName(basename(imagePath))
  const payload = await client.getMedia(folderId, title, 'image')
  const results = Array.isArray(payload?.results) ? payload.results : []
  return results.find((media) => [media?.name, media?.fileName, media?.title].some((value) => normalizedMediaName(value) === title)) || null
}

async function uploadImage(client, folderId, imagePath) {
  const title = basename(imagePath, extname(imagePath))
  const form = new FormData()
  form.append('title', title)
  form.append('categoryId', String(folderId))
  form.append('file', new Blob([readFileSync(imagePath)]), basename(imagePath))

  let uploadError = null
  try {
    await client.postMultipart(`/library/upload/${videoExpressLibraryId}`, form, `Upload ${basename(imagePath)}`)
  } catch (error) {
    uploadError = error
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (attempt > 0) await sleep(1_000)
    const media = await findUploadedImage(client, folderId, imagePath)
    if (media) return media
  }
  if (uploadError) throw uploadError
  throw new Error(`Video Express upload outcome is uncertain: ${basename(imagePath)}`)
}

function atomicJson(path, value) {
  const temporary = `${path}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temporary, path)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function saveState(path, state) {
  state.updatedAt = new Date().toISOString()
  atomicJson(path, state)
}

function validLocalVideo(path) {
  if (!existsSync(path) || statSync(path).size < 1_024) return false
  return isValidVideoExpressMp4Header(readFileSync(path).subarray(0, 32))
}

function validLocalImage(path) {
  if (!path || !existsSync(path) || statSync(path).size < 1_024) return false
  return isValidVideoExpressImageHeader(readFileSync(path).subarray(0, 32))
}

function initialState(manifest) {
  return {
    version: 1,
    contract: manifest.workflow === 'generated-still'
      ? 'videoexpress-generated-still-to-video-v1'
      : 'videoexpress-image2video-v1',
    manifestFingerprint: manifest.fingerprint,
    folderName: manifest.folderName,
    folderId: null,
    aiVideosFolderId: null,
    phase: 'login',
    items: manifest.items.map((item) => ({
      key: item.key,
      imagePath: item.imagePath,
      outputPath: item.outputPath,
      prompt: item.prompt,
      stillPrompt: item.stillPrompt,
      generatedImagePath: item.generatedImagePath,
      status: 'planned',
      mediaId: null,
      mediaUuid: null,
      generatedImageUuid: null,
      stillAttempts: 0,
      generationUuid: null,
      videoId: null,
      mediaPath: null,
      attempts: 0,
      error: null
    })),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
}

function loadOrCreateState(statePath, manifest) {
  if (!existsSync(statePath)) {
    const state = initialState(manifest)
    saveState(statePath, state)
    return state
  }
  const state = readJson(statePath)
  const expectedContract = manifest.workflow === 'generated-still'
    ? 'videoexpress-generated-still-to-video-v1'
    : 'videoexpress-image2video-v1'
  if (state.version !== 1 || state.contract !== expectedContract) {
    throw new Error('Saved Video Express state uses an unsupported contract')
  }
  if (state.manifestFingerprint !== manifest.fingerprint) {
    throw new Error('Saved Video Express state does not match the current manifest; use a fresh job root or restore the original manifest')
  }
  const uncertain = state.items.find((item) => isUncertainVideoExpressStateStatus(item.status))
  if (uncertain) {
    throw new Error(`Video Express item ${uncertain.key} has an uncertain remote outcome; inspect My AI Videos before resetting it`)
  }
  return state
}

async function downloadGeneratedStill(client, item) {
  if (validLocalImage(item.generatedImagePath)) return
  if (!item.generatedImageUuid) throw new Error(`Video Express item ${item.key} has no generated image UUID`)
  mkdirSync(dirname(item.generatedImagePath), { recursive: true })
  const partialPath = `${item.generatedImagePath}.partial`
  const previewUrl = buildVideoExpressGeneratedStillPreviewUrl(item.generatedImageUuid)
  let lastError = null
  for (let attempt = 0; attempt < 45; attempt += 1) {
    try {
      const response = await client.raw(previewUrl, { method: 'GET', redirect: 'follow' })
      if (!response.ok) {
        lastError = new Error(`Generated still preview is not ready (HTTP ${response.status})`)
      } else {
        const bytes = Buffer.from(await response.arrayBuffer())
        if (bytes.length < 1_024 || !isValidVideoExpressImageHeader(bytes.subarray(0, 32))) {
          throw new Error('Generated still preview was not a valid JPEG or PNG')
        }
        writeFileSync(partialPath, bytes)
        if (existsSync(item.generatedImagePath)) {
          throw new Error(`Refusing to overwrite unexpected generated image: ${item.generatedImagePath}`)
        }
        renameSync(partialPath, item.generatedImagePath)
        return
      }
    } catch (error) {
      lastError = error
    }
    await sleep(2_000)
  }
  throw lastError || new Error(`Generated still preview did not become ready for ${item.key}`)
}

async function ensureGeneratedStills(client, manifest, state, statePath) {
  if (manifest.workflow !== 'generated-still') return
  state.phase = 'generate-stills'
  saveState(statePath, state)
  for (const item of state.items) {
    if (item.status === 'downloaded') continue
    if (item.generatedImageUuid && validLocalImage(item.generatedImagePath)) {
      item.status = resolveGeneratedStillCheckpointStatus(item.status)
      saveState(statePath, state)
      continue
    }
    while (!item.generatedImageUuid) {
      if (!shouldRetryVideoExpressFailure(item.stillAttempts)) {
        throw new Error(`Video Express still ${item.key} failed after ${item.stillAttempts} attempts`)
      }
      item.status = 'generating_still'
      item.stillAttempts += 1
      saveState(statePath, state)
      try {
        const raw = await client.postForm(
          '/ai/api/generate_image_consistent_character',
          buildVideoExpressConsistentCharacterPayload({
            mediaId: item.mediaId,
            prompt: item.stillPrompt,
            aspect: manifest.aspect
          }),
          `Generate Video Express still ${item.key}`
        )
        let result = null
        try { result = JSON.parse(raw) } catch { result = null }
        if (result?.success === false) {
          item.status = 'still_failed'
          item.error = String(result.error || result.message || 'Video Express rejected still generation').slice(0, 300)
          saveState(statePath, state)
          continue
        }
        if (!result?.uuid) {
          item.status = 'still_submission_uncertain'
          saveState(statePath, state)
          throw new Error(`Video Express still submission outcome is uncertain for ${item.key}; inspect My AI Images before resetting it`)
        }
        item.generatedImageUuid = String(result.uuid)
        item.status = 'still_submitted'
        item.error = null
        saveState(statePath, state)
      } catch (error) {
        if (item.status === 'generating_still') {
          item.status = 'still_submission_uncertain'
          item.error = String(error?.message || error).slice(0, 300)
          saveState(statePath, state)
        }
        throw error
      }
    }
    await downloadGeneratedStill(client, item)
    item.status = 'still_ready'
    saveState(statePath, state)
    console.log(`Video Express: generated still ${item.key} -> ${item.generatedImagePath}`)
  }
}

function extractMediaPath(payload) {
  const containers = [payload, payload?.data, payload?.result, payload?.video, payload?.media].filter(Boolean)
  for (const container of containers) {
    for (const key of ['mediaPath', 'videoUrl', 'path', 'url']) {
      if (container[key]) return String(container[key])
    }
  }
  return null
}

async function resolveCompletedVideo(client, state, item) {
  if (item.videoId && item.mediaPath) return true
  if (!state.aiVideosFolderId || !item.generationUuid) return false
  const payload = await client.getMedia(state.aiVideosFolderId, item.generationUuid, '', 20)
  const results = Array.isArray(payload?.results) ? payload.results : []
  const media = results.find((entry) => String(entry?.uuid || '').toLowerCase() === String(item.generationUuid).toLowerCase())
  const download = extractVideoExpressDownloadRecord(media)
  if (!download) return false
  item.videoId = download.videoId
  item.mediaPath = download.mediaPath
  return true
}

async function fetchDownloadCandidate(client, candidate) {
  let response = await client.raw(candidate, { method: 'GET', redirect: 'manual' })
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location')
    if (!location) throw new Error(`Download redirect from ${candidate} had no location`)
    const target = new URL(location, host)
    response = target.origin === host
      ? await client.raw(target.href, { method: 'GET', redirect: 'follow' })
      : await fetch(target, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(120_000) })
  }
  await client.assertOk(response, `Download Video Express output from ${candidate}`)
  return Buffer.from(await response.arrayBuffer())
}

async function downloadItem(client, item) {
  if (validLocalVideo(item.outputPath)) return
  if (!item.videoId) throw new Error(`Video Express item ${item.key} has no generated video id`)
  mkdirSync(dirname(item.outputPath), { recursive: true })
  const partialPath = `${item.outputPath}.partial`
  const candidates = [`/download/output/${item.videoId}`, `/library/download/${item.videoId}`]
  if (item.mediaPath) candidates.push(item.mediaPath)
  let lastError = null
  for (const candidate of candidates) {
    try {
      const bytes = await fetchDownloadCandidate(client, candidate)
      if (bytes.length < 1_024 || !isValidVideoExpressMp4Header(bytes.subarray(0, 32))) {
        throw new Error(`Video Express download from ${candidate} was not a valid MP4`)
      }
      writeFileSync(partialPath, bytes)
      if (existsSync(item.outputPath)) throw new Error(`Refusing to overwrite unexpected output: ${item.outputPath}`)
      renameSync(partialPath, item.outputPath)
      return
    } catch (error) {
      lastError = error
    }
  }
  throw lastError || new Error(`Video Express download failed for ${item.key}`)
}

async function runPreflight(client) {
  await client.login()
  const folders = await client.getFolders()
  const queue = await client.getUserQueue()
  console.log(JSON.stringify({
    login: 'succeeded',
    libraryId: videoExpressLibraryId,
    folderCount: folders.length,
    hasAiImagesFolder: Boolean(findNamedFolder(folders, 'My AI Images')),
    hasAiVideosFolder: Boolean(getAiVideosFolder(folders)),
    activeQueue: countActiveVideoExpressQueue(queue),
    maxConcurrency: videoExpressMaxConcurrency
  }))
}

async function runJob(client, jobRoot) {
  const root = resolve(jobRoot)
  const manifestPath = join(root, 'videoexpress-manifest.json')
  if (!existsSync(manifestPath)) throw new Error(`Video Express manifest is missing: ${manifestPath}`)
  const manifest = normalizeVideoExpressManifest(readJson(manifestPath), root)
  for (const item of manifest.items) {
    if (!existsSync(item.imagePath) || !statSync(item.imagePath).isFile()) throw new Error(`Video Express input image is missing: ${item.imagePath}`)
  }

  const workDir = join(root, 'intermediate', 'videoexpress')
  const statePath = join(workDir, 'state.json')
  mkdirSync(workDir, { recursive: true })
  const state = loadOrCreateState(statePath, manifest)

  await client.login()
  state.phase = 'folder'
  saveState(statePath, state)
  const ensured = await ensureFolder(client, manifest.folderName)
  state.folderId = String(ensured.folder.id)
  const aiVideos = getAiVideosFolder(ensured.folders)
  if (!aiVideos) throw new Error('Video Express My AI Videos folder was not found')
  state.aiVideosFolderId = String(aiVideos.id)
  saveState(statePath, state)

  state.phase = 'upload'
  saveState(statePath, state)
  for (const item of state.items) {
    if (validLocalVideo(item.outputPath)) {
      item.status = 'downloaded'
      saveState(statePath, state)
      continue
    }
    if (item.mediaId) continue
    if (item.status === 'uploading') {
      const recovered = await findUploadedImage(client, state.folderId, item.imagePath)
      if (!recovered) {
        item.status = 'upload_uncertain'
        saveState(statePath, state)
        throw new Error(`Video Express upload outcome is uncertain for ${item.key}`)
      }
      item.mediaId = String(recovered.id)
      item.mediaUuid = recovered.uuid || ''
      item.status = 'uploaded'
      saveState(statePath, state)
      continue
    }
    const existing = await findUploadedImage(client, state.folderId, item.imagePath)
    item.status = 'uploading'
    saveState(statePath, state)
    const media = existing || await uploadImage(client, state.folderId, item.imagePath)
    item.mediaId = String(media.id)
    item.mediaUuid = media.uuid || ''
    item.status = 'uploaded'
    item.error = null
    saveState(statePath, state)
    console.log(`Video Express: uploaded ${item.key}`)
  }

  await ensureGeneratedStills(client, manifest, state, statePath)

  state.phase = 'generate'
  saveState(statePath, state)
  const pollIntervalMs = Math.min(60_000, Math.max(5_000, Number(process.env.VIDEOEXPRESS_POLL_INTERVAL_MS) || videoExpressDefaultPollIntervalMs))
  const parallelRetryMs = Math.max(5_000, Number(process.env.VIDEOEXPRESS_PARALLEL_RETRY_MS) || 60_000)
  const maxWaitMs = Math.max(30, Number(process.env.VIDEOEXPRESS_MAX_WAIT_MINUTES) || 360) * 60_000
  const deadline = Date.now() + maxWaitMs

  while (state.items.some((item) => item.status !== 'downloaded')) {
    if (Date.now() > deadline) throw new Error('Video Express job reached its wait limit; state is saved and can be resumed')

    for (const item of state.items.filter((entry) => entry.status === 'failed')) {
      if (!shouldRetryVideoExpressFailure(item.attempts)) {
        throw new Error(`Video Express item ${item.key} failed after ${item.attempts} attempts`)
      }
      item.status = manifest.workflow === 'generated-still' ? 'still_ready' : 'uploaded'
      item.generationUuid = null
      saveState(statePath, state)
    }

    for (const item of state.items.filter((entry) => ['submitted', 'running', 'completed'].includes(entry.status))) {
      if (item.status !== 'completed') {
        const payload = await client.getStatus(item.generationUuid)
        const mapped = mapVideoExpressStatus(payload?.status)
        item.status = mapped
        item.videoId = mapped === 'completed' ? (extractVideoExpressVideoId(payload) || item.videoId) : item.videoId
        item.mediaPath = extractMediaPath(payload) || item.mediaPath
        item.error = mapped === 'failed' ? String(payload?.error || payload?.message || 'Video Express generation failed').slice(0, 300) : null
        saveState(statePath, state)
        if (mapped === 'failed') {
          if (!shouldRetryVideoExpressFailure(item.attempts)) throw new Error(`Video Express item ${item.key} failed after ${item.attempts} attempts`)
          item.status = manifest.workflow === 'generated-still' ? 'still_ready' : 'uploaded'
          item.generationUuid = null
          saveState(statePath, state)
          continue
        }
      }
      if (item.status === 'completed') {
        const resolved = await resolveCompletedVideo(client, state, item)
        if (resolved && item.videoId && item.mediaPath) {
          saveState(statePath, state)
          await downloadItem(client, item)
          item.status = 'downloaded'
          saveState(statePath, state)
          console.log(`Video Express: downloaded ${item.key} -> ${item.outputPath}`)
        }
      }
    }

    const waitingStatus = manifest.workflow === 'generated-still' ? 'still_ready' : 'uploaded'
    const waiting = state.items.filter((item) => item.status === waitingStatus)
    if (waiting.length > 0) {
      const queue = await client.getUserQueue()
      const remoteActive = countActiveVideoExpressQueue(queue)
      const localActive = state.items.filter((item) => ['submitted', 'running'].includes(item.status)).length
      let capacity = availableVideoExpressCapacity({ remoteActive, localActive })
      let parallelLimited = false
      for (const item of waiting) {
        if (capacity <= 0) break
        item.status = 'submitting'
        item.attempts += 1
        saveState(statePath, state)
        try {
          const payload = manifest.workflow === 'generated-still'
            ? buildVideoExpressGeneratedStillVideoPayload({
                uuid: item.generatedImageUuid,
                imagePrompt: item.stillPrompt,
                prompt: item.prompt,
                aspect: manifest.aspect,
                videoLength: manifest.videoLength
              })
            : buildVideoExpressGenerationPayload({
                media: { id: item.mediaId, uuid: item.mediaUuid, name: basename(item.imagePath), type: 'image', isShared: false },
                prompt: item.prompt,
                aspect: manifest.aspect,
                videoLength: manifest.videoLength
              })
          const raw = await client.postForm('/ai/api/image2video', payload, `Generate Video Express item ${item.key}`)
          let result = null
          try { result = JSON.parse(raw) } catch { result = null }
          if (isParallelVideoExpressLimit(result?.error || result?.message || raw)) {
            item.status = waitingStatus
            item.attempts -= 1
            saveState(statePath, state)
            parallelLimited = true
            break
          }
          if (result?.success === false) {
            item.status = 'failed'
            item.error = String(result.error || result.message || 'Video Express rejected generation').slice(0, 300)
            saveState(statePath, state)
            if (!shouldRetryVideoExpressFailure(item.attempts)) {
              throw new Error(`Video Express item ${item.key} failed after ${item.attempts} attempts`)
            }
            item.status = waitingStatus
            saveState(statePath, state)
            continue
          }
          if (!result?.uuid) {
            item.status = 'submission_uncertain'
            saveState(statePath, state)
            throw new Error(`Video Express submission outcome is uncertain for ${item.key}; inspect My AI Videos before resetting it`)
          }
          item.generationUuid = String(result.uuid)
          item.status = 'submitted'
          item.error = null
          saveState(statePath, state)
          capacity -= 1
          console.log(`Video Express: submitted ${item.key}`)
        } catch (error) {
          if (isParallelVideoExpressLimit(error?.bodyText || error?.message)) {
            item.status = waitingStatus
            item.attempts -= 1
            saveState(statePath, state)
            parallelLimited = true
            break
          }
          if (item.status === 'submitting') {
            item.status = 'submission_uncertain'
            item.error = String(error?.message || error).slice(0, 300)
            saveState(statePath, state)
          }
          throw error
        }
      }
      if (parallelLimited) await sleep(parallelRetryMs)
    }

    const downloaded = state.items.filter((item) => item.status === 'downloaded').length
    const active = state.items.filter((item) => ['submitted', 'running'].includes(item.status)).length
    console.log(`Video Express: ${downloaded}/${state.items.length} downloaded, ${active} active`)
    if (downloaded < state.items.length) await sleep(pollIntervalMs)
  }

  state.phase = 'done'
  saveState(statePath, state)
  console.log(`Video Express: completed ${state.items.length} clips`)
}

const client = new VideoExpressClient()
if (preflightOnly) await runPreflight(client)
else await runJob(client, jobRootArg)
