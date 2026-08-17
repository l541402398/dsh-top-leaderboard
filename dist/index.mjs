import { spawn } from 'node:child_process'
import { readFileSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, cpSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const API_PATH = '/dsh-top/v1'
const MAX_BODY_BYTES = 64 * 1024

export const name = 'dsh-top-leaderboard'

function loopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** 部署声明的可信来源（webRuntime.trustedHosts + 进程环境），用于非 loopback 访问。 */
function trustedHostEntries(ctx) {
  const entries = []
  try {
    const runtime = ctx?.get?.('webRuntime')
    if (runtime && Array.isArray(runtime.trustedHosts)) entries.push(...runtime.trustedHosts)
  } catch { /* ignore */ }
  const envValue = process.env.DSH_TRUSTED_HOST
  if (typeof envValue === 'string' && envValue !== '') entries.push(envValue)
  return entries
}

/** 与内置 /api 围栏一致：无端口条目匹配任意端口，带端口条目精确匹配 host:port。 */
function isTrustedAuthority(hostUrl, entries) {
  for (const entry of entries) {
    if (typeof entry !== 'string' || entry === '') continue
    let entryUrl
    try { entryUrl = new URL(`http://${entry}`) } catch { continue }
    if (entryUrl.port === '') {
      if (entryUrl.hostname === hostUrl.hostname) return true
    } else if (entryUrl.host === hostUrl.host) {
      return true
    }
  }
  return false
}

/** 只接受本机 loopback 或部署可信来源页面发来的请求（防跨站 CSRF）。 */
function isTrustedRequest(request, trustedHosts) {
  const headers = request.headers ?? {}
  const host = headers.host
  if (typeof host !== 'string' || host === '') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!loopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  if (headers['sec-fetch-site'] === 'cross-site') return false
  const origin = headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

function sendJson(response, status, value) {
  const body = `${JSON.stringify(value)}\n`
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'x-content-type-options': 'nosniff',
  })
  response.end(body)
}

async function readJsonBody(request) {
  const contentType = (request.headers?.['content-type'] ?? '').toLowerCase()
  if (!contentType.startsWith('application/json')) throw new Error('content-type must be application/json')
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body is too large')
    chunks.push(chunk)
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('request body must be a JSON object')
  }
  return value
}

let leaderboardCache = null
function leaderboard() {
  if (leaderboardCache !== null) return leaderboardCache
  const raw = JSON.parse(readFileSync(join(__dirname, '..', 'data', 'leaderboard.json'), 'utf8'))
  const repos = Array.isArray(raw?.repos) ? raw.repos : []
  const ranked = repos
    .filter((r) => r && !r.isFork && typeof r.name === 'string' && typeof r.owner === 'string')
    .sort((a, b) => (b.starsCount ?? 0) - (a.starsCount ?? 0))
    .map((r) => ({
      name: r.name,
      owner: r.owner,
      fullName: `${r.owner}/${r.name}`,
      description: typeof r.description === 'string' ? r.description : '',
      stars: r.starsCount ?? 0,
      language: r.primaryLanguage?.name ?? null,
      type: typeof r.type === 'string' ? r.type : null,
      url: `https://github.com/${r.owner}/${r.name}`,
      topics: Array.isArray(r.allTopics) ? r.allTopics : [],
      size: typeof r.size === 'number' && r.size >= 0 ? r.size : null,
    }))
  leaderboardCache = { crawledAt: raw?.crawledAt ?? null, repos: ranked }
  return leaderboardCache
}

function resolveDshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** 从 git spec 提取 owner/repo 标识（统一小写、去 .git / #ref），兼容 https/ssh/github: 三种写法。 */
function gitSpecIdentity(spec) {
  if (typeof spec !== 'string') return null
  const match = /(?:^github:|github\.com[:/])([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/.exec(spec)
  if (match) return match[1].replace(/\.git$/, '').toLowerCase()
  return null
}

/** 读取 web profile 当前已安装的 git 源集合，用于标记「已安装」。 */
function readInstalledGitSpecs() {
  const specs = new Set()
  try {
    const path = join(resolveDshHome(), 'profiles', 'web', 'package.json')
    const pkg = JSON.parse(readFileSync(path, 'utf8'))
    for (const spec of Object.values(pkg?.dependencies ?? {})) {
      const identity = gitSpecIdentity(spec)
      if (identity !== null) specs.add(identity)
    }
  } catch {
    /* 读不到 profile 时返回空集合 */
  }
  return specs
}

function installedSourcesFile() {
  return join(resolveDshHome(), 'dsh-top-leaderboard', 'installed-sources.json')
}

/** 记录本插件安装过的仓库及其类型，供「已安装」检测与类型展示。 */
function recordInstalledSource(fullName, type) {
  try {
    const file = installedSourcesFile()
    mkdirSync(dirname(file), { recursive: true })
    let data = {}
    try { data = JSON.parse(readFileSync(file, 'utf8')) } catch { data = {} }
    if (Array.isArray(data) || data === null || typeof data !== 'object') data = {}
    data[fullName.toLowerCase()] = type || 'bundle'
    writeFileSync(file, JSON.stringify(data))
  } catch { /* ignore */ }
}

/** 已安装源 → Map<fullName, type>（合并 profile 的 git spec 与本插件记录）。 */
function readInstalledSources() {
  const map = new Map()
  for (const identity of readInstalledGitSpecs()) map.set(identity, 'bundle')
  try {
    const data = JSON.parse(readFileSync(installedSourcesFile(), 'utf8'))
    if (Array.isArray(data)) {
      for (const item of data) if (typeof item === 'string') map.set(item.toLowerCase(), 'bundle')
    } else if (data && typeof data === 'object') {
      for (const [key, value] of Object.entries(data)) map.set(key.toLowerCase(), typeof value === 'string' ? value : 'bundle')
    }
  } catch { /* ignore */ }
  return map
}

/** 从 topics 推断插件类型（启发式，仅作展示）。 */
function inferTypeFromTopics(topics) {
  const set = new Set((Array.isArray(topics) ? topics : []).map((t) => String(t).toLowerCase()))
  if (set.has('dsh-bundle') || set.has('bundle')) return 'bundle'
  if (set.has('agent-skills') || set.has('agent-skill') || set.has('skill') || set.has('skills')) return 'skill'
  if (set.has('marisa-plugin') || set.has('marisa')) return 'marisa'
  if (set.has('cordis')) return 'cordis'
  return null
}

// ---- 仓库大小（GitHub API 统计，单位 KB；渐进式补全并持久化到 DSH_HOME）----
function sizesFile() {
  return join(resolveDshHome(), 'dsh-top-leaderboard', 'sizes.json')
}
let sizeCache = null
let sizeRateLimitedAt = 0
function readSizeCache() {
  if (sizeCache !== null) return sizeCache
  sizeCache = new Map()
  try {
    const data = JSON.parse(readFileSync(sizesFile(), 'utf8'))
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      for (const [key, value] of Object.entries(data)) {
        if (typeof value === 'number' && value >= 0) sizeCache.set(key.toLowerCase(), value)
      }
    }
  } catch { /* ignore */ }
  return sizeCache
}
function writeSizeCache() {
  try {
    const file = sizesFile()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(Object.fromEntries(readSizeCache())))
  } catch { /* ignore */ }
}
/** 实时查单个仓库大小（KB）；403/429 视为限流并暂停补全。 */
async function fetchRepoSize(owner, repo) {
  try {
    const url = `https://api.github.com/repos/${owner}/${repo}`
    const response = await fetch(url, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-top-leaderboard' },
      signal: AbortSignal.timeout(8000),
    })
    if (response.status === 403 || response.status === 429) {
      sizeRateLimitedAt = Date.now()
      return null
    }
    if (!response.ok) return null
    const body = await response.json()
    return typeof body?.size === 'number' && body.size >= 0 ? body.size : null
  } catch {
    return null
  }
}
/** 查仓库大小：优先缓存，未命中实时查一次并写缓存。 */
async function repoSizeKB(owner, repo) {
  const key = `${owner}/${repo}`.toLowerCase()
  const cached = readSizeCache().get(key)
  if (cached !== undefined) return cached
  const size = await fetchRepoSize(owner, repo)
  if (size !== null) {
    readSizeCache().set(key, size)
    writeSizeCache()
  }
  return size
}
/** 渐进式补全榜单缺失的大小：每次最多补 12 个；刚被限流则整体暂停。 */
async function enrichMissingSizes(repos) {
  if (Date.now() - sizeRateLimitedAt < 30 * 60 * 1000) return
  const cache = readSizeCache()
  let fetched = 0
  for (const repo of repos) {
    if (fetched >= 12) break
    if (!repo || typeof repo.owner !== 'string' || typeof repo.name !== 'string') continue
    const key = `${repo.owner}/${repo.name}`.toLowerCase()
    if (cache.has(key)) continue
    const size = await fetchRepoSize(repo.owner, repo.name)
    if (size !== null) {
      cache.set(key, size)
      fetched += 1
      writeSizeCache()
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
    if (Date.now() - sizeRateLimitedAt < 5 * 60 * 1000) return
  }
}
/** KB → 人类可读大小文本。 */
function humanSize(kb) {
  if (kb === null || kb === undefined || kb < 0) return '未知'
  if (kb < 1024) return '<1 MB'
  const mb = kb / 1024
  if (mb < 1024) return `${mb >= 100 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`
  return `${Math.round((mb / 1024) * 10) / 10} GB`
}

/** 给仓库补上 installed 标记与 kind（插件类型）。 */
function withKind(repo, installed) {
  const lower = repo.fullName.toLowerCase()
  const installedType = installed.get(lower)
  const kind = installedType || inferTypeFromTopics(repo.topics)
  return { ...repo, installed: installed.has(lower), kind: kind ?? null }
}

function leaderboardWithInstalled() {
  const base = leaderboard()
  const installed = readInstalledSources()
  const cache = readSizeCache()
  return {
    crawledAt: base.crawledAt,
    repos: base.repos.map((repo) => {
      const item = withKind(repo, installed)
      const cached = cache.get(repo.fullName.toLowerCase())
      if (cached !== undefined) item.size = cached
      return item
    }),
  }
}

function writeEvent(response, value) {
  if (response.writableEnded || response.destroyed) return
  response.write(`${JSON.stringify(value)}\n`)
}

/** 运行一条命令，把 stdout/stderr 流式写成 log 事件，返回结果摘要。 */
function runCommand(command, args, response, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: {
        ...process.env,
        ...extraEnv,
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: 'echo',
        GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (value) => { if (!settled) { settled = true; resolve(value) } }
    child.stdout.on('data', (chunk) => { stdout += chunk; writeEvent(response, { type: 'log', stream: 'stdout', text: chunk.toString() }) })
    child.stderr.on('data', (chunk) => { stderr += chunk; writeEvent(response, { type: 'log', stream: 'stderr', text: chunk.toString() }) })
    child.once('error', (error) => finish({ ok: false, code: null, errTail: String(error), outTail: '' }))
    child.once('close', (code) => finish({
      ok: code === 0,
      code,
      errTail: stderr.trim().split('\n').slice(-4).join('\n'),
      outTail: stdout.trim().split('\n').slice(-4).join('\n'),
    }))
  })
}

/** 读取 SKILL.md frontmatter 里的 name。 */
function readSkillName(dir) {
  try {
    const text = readFileSync(join(dir, 'SKILL.md'), 'utf8')
    const match = /^name:\s*["']?([A-Za-z0-9._-]+)["']?\s*$/m.exec(text)
    if (match) return match[1]
  } catch { /* ignore */ }
  return null
}

/** 找出仓库里所有技能目录：顶层 SKILL.md 视为一整个技能；skills/<x>/SKILL.md 视为多个技能。 */
function findSkillDirs(cloneDir) {
  const dirs = []
  if (existsSync(join(cloneDir, 'SKILL.md'))) {
    dirs.push({ source: cloneDir, name: readSkillName(cloneDir) || basename(cloneDir) })
  }
  const skillsRoot = join(cloneDir, 'skills')
  if (existsSync(skillsRoot)) {
    try {
      for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const sub = join(skillsRoot, entry.name)
        if (existsSync(join(sub, 'SKILL.md'))) dirs.push({ source: sub, name: readSkillName(sub) || entry.name })
      }
    } catch { /* ignore */ }
  }
  return dirs
}

/** 判定插件类型：skill / bundle / cordis / unknown。 */
function classifyPlugin(cloneDir) {
  const skills = findSkillDirs(cloneDir)
  if (skills.length > 0) return { type: 'skill', skills }
  if (existsSync(join(cloneDir, 'package.json'))) {
    try {
      const pkg = JSON.parse(readFileSync(join(cloneDir, 'package.json'), 'utf8'))
      if (pkg?.dsh?.bundle?.patch) return { type: 'bundle', name: pkg.name ?? basename(cloneDir) }
      return { type: 'cordis', name: pkg.name ?? basename(cloneDir) }
    } catch { /* ignore */ }
  }
  return { type: 'unknown', name: basename(cloneDir) }
}

/** 把技能目录拷到 ~/.dsh/skills/<name>/（去掉 .git）。 */
function installSkill(source, name, response) {
  const target = join(resolveDshHome(), 'skills', name)
  rmSync(target, { recursive: true, force: true })
  mkdirSync(dirname(target), { recursive: true })
  cpSync(source, target, { recursive: true })
  rmSync(join(target, '.git'), { recursive: true, force: true })
  writeEvent(response, { type: 'log', stream: 'stdout', text: `✓ 已安装技能：~/.dsh/skills/${name}/\n` })
}

/**
 * 先通过 HTTPS 浅克隆（公共仓库匿名可读，无需 SSH 密钥），失败再退回 SSH：
 * - skill：拷到 ~/.dsh/skills/<name>/
 * - bundle/cordis：`link:` 装进 web profile
 * 完全绕开 pnpm 对 github.com 的 HTTPS HEAD（本机 HTTPS 不稳、SSH 可靠）。
 * HTTPS 强制 HTTP/1.1（规避 HTTP/2 流被掐断的 curl 92 CANCEL），并自动重试 3 次。
 */
async function installRepo(owner, repo, response) {
  const reposRoot = join(resolveDshHome(), 'dsh-top-leaderboard', 'repos')
  const cloneDir = join(reposRoot, `${owner}-${repo}`)
  const httpsUrl = `https://github.com/${owner}/${repo}.git`
  const sshUrl = `git@github.com:${owner}/${repo}.git`

  rmSync(cloneDir, { recursive: true, force: true })
  mkdirSync(reposRoot, { recursive: true })

  // 克隆前先查仓库大小（GitHub 统计，含历史；浅克隆实际下载约等于当前分支文件体积）
  const sizeKB = await repoSizeKB(owner, repo)
  if (sizeKB !== null) {
    writeEvent(response, { type: 'log', stream: 'stdout', text: `📦 仓库大小：${humanSize(sizeKB)}（GitHub 统计含历史，浅克隆只下载当前分支文件）\n` })
    if (sizeKB >= 102400) {
      const minutes = Math.max(1, Math.ceil(sizeKB / 1024 / 15))
      writeEvent(response, { type: 'log', stream: 'stderr', text: `⚠️ 仓库较大，本机到 GitHub 带宽约 300KB/s，预计需要约 ${minutes} 分钟，请耐心等待（中断会自动重试）\n` })
    }
  } else {
    writeEvent(response, { type: 'log', stream: 'stdout', text: '📦 仓库大小：未知（GitHub API 未返回，不影响安装）\n' })
  }

  let clone = { ok: false, code: 1, errTail: '', outTail: '' }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    rmSync(cloneDir, { recursive: true, force: true })
    clone = await runCommand('git', ['-c', 'http.version=HTTP/1.1', 'clone', '--depth', '1', '--no-tags', httpsUrl, cloneDir], response)
    if (clone.ok) break
    writeEvent(response, { type: 'log', stream: 'stderr', text: `HTTPS 克隆失败（第 ${attempt}/3 次），正在重试…\n` })
  }
  if (!clone.ok) {
    rmSync(cloneDir, { recursive: true, force: true })
    clone = await runCommand('git', ['clone', '--depth', '1', '--no-tags', sshUrl, cloneDir], response)
  }
  if (!clone.ok) {
    return { ok: false, code: clone.code ?? 1, message: clone.errTail || clone.outTail || 'git clone 失败' }
  }

  const kind = classifyPlugin(cloneDir)

  if (kind.type === 'skill') {
    for (const skill of kind.skills) installSkill(skill.source, skill.name, response)
    recordInstalledSource(`${owner}/${repo}`, 'skill')
    return { ok: true, code: 0, message: `已安装为技能：${kind.skills.map((s) => s.name).join('、')}` }
  }

  if (kind.type === 'bundle' || kind.type === 'cordis') {
    const add = await runCommand('dsh', ['plugin', '--profile', 'web', 'add', `link:${cloneDir}`, '--ignore-scripts'], response, { DSH_HOME: resolveDshHome() })
    if (!add.ok) {
      return { ok: false, code: add.code ?? 1, message: add.errTail || add.outTail || '安装失败' }
    }
    recordInstalledSource(`${owner}/${repo}`, kind.type)
    return {
      ok: true,
      code: 0,
      message: kind.type === 'bundle' ? '已安装为 profile bundle' : '已安装为依赖（cordis 插件还需在 cordis.patch.yml 挂载）',
    }
  }

  return { ok: false, code: 1, message: `无法判断插件类型：${owner}/${repo}（仓库里既没有 SKILL.md 也没有 package.json）` }
}

/**
 * 用 `git ls-remote`（HTTPS、禁交互、硬超时）探测单个仓库是否可访问。
 * 走与安装相同的凭据路径，是「有没有权限」最准确的预判。
 */
function probeAccess(url) {
  return new Promise((resolve) => {
    const child = spawn('git', ['-c', 'http.version=HTTP/1.1', 'ls-remote', url, 'HEAD'], {
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: 'echo',
        GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let killTimer
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(killTimer)
      resolve(value)
    }
    killTimer = setTimeout(() => {
      if (settled) return
      try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
      finish({ accessible: false, detail: '检测超时（网络到 github 较慢或不通，可重试）' })
    }, 20000)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', (error) => finish({ accessible: false, detail: String(error) }))
    child.once('close', (code) => {
      if (code === 0) {
        finish({ accessible: true, detail: '' })
      } else {
        const detail = (stderr.trim() || stdout.trim() || `exit ${code}`)
          .split('\n').slice(-3).join(' ').slice(0, 400)
        finish({ accessible: false, detail })
      }
    })
  })
}

/** 先 HTTPS 探测，失败再退回 SSH（与安装路径一致）。 */
async function checkAccess(owner, repo) {
  const urls = [`https://github.com/${owner}/${repo}.git`, `git@github.com:${owner}/${repo}.git`]
  let result = { accessible: false, detail: 'no probe url' }
  for (const url of urls) {
    result = await probeAccess(url)
    if (result.accessible) return result
  }
  return result
}

// ---- 官方 topics（github.com/topics/dsh-plugin）列表，带内存缓存 ----
const topicCache = { at: 0, repos: null }
const TOPIC_TTL_MS = 10 * 60 * 1000
async function fetchTopicRepos() {
  const now = Date.now()
  if (topicCache.repos !== null && now - topicCache.at < TOPIC_TTL_MS) return topicCache.repos
  const collected = []
  try {
    for (let page = 1; page <= 2; page += 1) {
      const url = new URL('https://api.github.com/search/repositories')
      url.searchParams.set('q', 'topic:dsh-plugin')
      url.searchParams.set('sort', 'stars')
      url.searchParams.set('order', 'desc')
      url.searchParams.set('per_page', '100')
      url.searchParams.set('page', String(page))
      const response = await fetch(url, {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'dsh-top-leaderboard',
          'x-github-api-version': '2022-11-28',
        },
        signal: AbortSignal.timeout(15000),
      })
      if (!response.ok) throw new Error(`GitHub topic search failed (HTTP ${response.status})`)
      const body = await response.json()
      if (!Array.isArray(body.items) || body.items.length === 0) break
      for (const item of body.items) {
        if (item?.fork === true || item?.archived === true || item?.private === true) continue
        if (typeof item?.full_name !== 'string' || item.full_name === '') continue
        collected.push({
          name: item.name,
          owner: item.owner?.login ?? '',
          fullName: item.full_name,
          description: typeof item.description === 'string' ? item.description : '',
          stars: item.stargazers_count ?? 0,
          language: item.language ?? null,
          type: 'Public',
          url: item.html_url,
          topics: Array.isArray(item.topics) ? item.topics : [],
          size: typeof item.size === 'number' && item.size >= 0 ? item.size : null,
        })
      }
      if (collected.length >= 200) break
    }
    topicCache.at = now
    topicCache.repos = collected
  } catch (error) {
    if (topicCache.repos !== null) return topicCache.repos
    throw error
  }
  return topicCache.repos
}

export function apply(ctx) {
  if (typeof ctx?.inject !== 'function') return
  ctx.inject(['webServer'], (webCtx) => {
    if (typeof webCtx?.effect !== 'function' || typeof webCtx?.webServer?.register !== 'function') return

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: `${API_PATH}/leaderboard`,
      handler: (request, response) => {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.setHeader('allow', 'GET')
          sendJson(response, 405, { error: 'method not allowed' })
          return
        }
        const payload = leaderboardWithInstalled()
        sendJson(response, 200, { ok: true, ...payload })
        // 响应后再渐进补全缺失的大小（不阻塞页面），下次打开榜单即可看到
        void enrichMissingSizes(payload.repos)
      },
    }), 'dsh-top-leaderboard: leaderboard route')

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: `${API_PATH}/install`,
      handler: async (request, response) => {
        if (!isTrustedRequest(request, trustedHostEntries(webCtx))) {
          sendJson(response, 403, { error: 'forbidden: only local loopback web pages may install plugins' })
          return
        }
        if (request.method !== 'POST') {
          response.setHeader('allow', 'POST')
          sendJson(response, 405, { error: 'method not allowed' })
          return
        }
        let body
        try {
          body = await readJsonBody(request)
        } catch (error) {
          sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
          return
        }
        const owner = typeof body.owner === 'string' ? body.owner.trim() : ''
        const repo = typeof body.name === 'string' ? body.name.trim() : ''
        if (owner === '' || repo === '') {
          sendJson(response, 400, { error: 'owner and name are required' })
          return
        }
        if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
          sendJson(response, 400, { error: 'invalid repository identity' })
          return
        }
        // 先 SSH 浅克隆到本地，再用 link: 安装，绕开 pnpm 对 github.com 的 HTTPS HEAD
        response.writeHead(200, {
          'cache-control': 'no-store',
          'content-type': 'application/x-ndjson; charset=utf-8',
          'x-content-type-options': 'nosniff',
        })
        writeEvent(response, { type: 'start', spec: `${owner}/${repo}` })
        const result = await installRepo(owner, repo, response)
        writeEvent(response, { type: 'done', ok: result.ok, code: result.code, message: result.message })
        response.end()
      },
    }), 'dsh-top-leaderboard: install route')

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: `${API_PATH}/check`,
      handler: async (request, response) => {
        if (!isTrustedRequest(request, trustedHostEntries(webCtx))) {
          sendJson(response, 403, { error: 'forbidden: only local loopback web pages may check access' })
          return
        }
        if (request.method !== 'POST') {
          response.setHeader('allow', 'POST')
          sendJson(response, 405, { error: 'method not allowed' })
          return
        }
        let body
        try {
          body = await readJsonBody(request)
        } catch (error) {
          sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
          return
        }
        const owner = typeof body.owner === 'string' ? body.owner.trim() : ''
        const repo = typeof body.name === 'string' ? body.name.trim() : ''
        if (owner === '' || repo === '') {
          sendJson(response, 400, { error: 'owner and name are required' })
          return
        }
        if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
          sendJson(response, 400, { error: 'invalid repository identity' })
          return
        }
        sendJson(response, 200, await checkAccess(owner, repo))
      },
    }), 'dsh-top-leaderboard: check route')

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: `${API_PATH}/topic`,
      handler: async (request, response) => {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.setHeader('allow', 'GET')
          sendJson(response, 405, { error: 'method not allowed' })
          return
        }
        try {
          const repos = await fetchTopicRepos()
          const installed = readInstalledSources()
          sendJson(response, 200, {
            ok: true,
            source: 'github topics: dsh-plugin',
            repos: repos.map((repo) => withKind(repo, installed)),
          })
        } catch (error) {
          sendJson(response, 502, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }), 'dsh-top-leaderboard: topic route')
  })
}
