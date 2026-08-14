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

/** 只接受本机 loopback 页面发来的请求（防跨站 CSRF）。 */
function isTrustedRequest(request) {
  const headers = request.headers ?? {}
  const host = headers.host
  if (typeof host !== 'string' || host === '') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!loopbackHostname(hostUrl.hostname)) return false
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
  return {
    crawledAt: base.crawledAt,
    repos: base.repos.map((repo) => withKind(repo, installed)),
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
 * 先通过 SSH 把仓库浅克隆到本地稳定目录，再按类型安装：
 * - skill：拷到 ~/.dsh/skills/<name>/
 * - bundle/cordis：`link:` 装进 web profile
 * 完全绕开 pnpm 对 github.com 的 HTTPS HEAD（本机 HTTPS 不稳、SSH 可靠）。
 */
async function installRepo(owner, repo, response) {
  const reposRoot = join(resolveDshHome(), 'dsh-top-leaderboard', 'repos')
  const cloneDir = join(reposRoot, `${owner}-${repo}`)
  const cloneUrl = `git@github.com:${owner}/${repo}.git`

  rmSync(cloneDir, { recursive: true, force: true })
  mkdirSync(reposRoot, { recursive: true })
  const clone = await runCommand('git', ['clone', '--depth', '1', cloneUrl, cloneDir], response)
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
function checkAccess(owner, repo) {
  return new Promise((resolve) => {
    const url = `git@github.com:${owner}/${repo}.git`
    const child = spawn('git', ['ls-remote', url, 'HEAD'], {
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
        sendJson(response, 200, { ok: true, ...leaderboardWithInstalled() })
      },
    }), 'dsh-top-leaderboard: leaderboard route')

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: `${API_PATH}/install`,
      handler: async (request, response) => {
        if (!isTrustedRequest(request)) {
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
        if (!isTrustedRequest(request)) {
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
