window.__ModuleLoader__.load({
  id: 'dsh-top-leaderboard',
  factory: (require) => {
    'use strict'
    const module = { exports: {} }
    const React = require('react')
    const { createElement: h, Fragment, useSyncExternalStore, useState, useEffect, useMemo, useRef } = React

    const API = '/dsh-top/v1'

    // ---- 仓库大小展示（KB → 文本）----
    function formatSize(size) {
      if (size === null || size === undefined || size < 0) return null
      if (size < 1024) return '<1 MB'
      const mb = size / 1024
      if (mb < 1024) return `${mb >= 100 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`
      return `${Math.round((mb / 1024) * 10) / 10} GB`
    }

    // ---- 共享开关状态（按钮与弹窗两个 slot 之间共享）----
    let open = false
    const openListeners = new Set()
    function setOpen(value) {
      if (open === value) return
      open = value
      for (const listener of openListeners) listener()
    }
    function subscribeOpen(listener) {
      openListeners.add(listener)
      return () => { openListeners.delete(listener) }
    }
    function getOpen() { return open }

    // ---- 每个仓库的安装状态（模块级，跨弹窗开关持久化）----
    const IDLE = Object.freeze({ status: 'idle', message: '', logs: [], logsOpen: false, startedAt: null, spec: '' })
    const installStates = new Map()
    const installListeners = new Set()
    function getInstallState(key) { return installStates.get(key) ?? IDLE }
    function setInstallState(key, patch) {
      const prev = installStates.get(key) ?? IDLE
      installStates.set(key, { ...prev, ...patch })
      for (const listener of installListeners) listener()
    }
    function subscribeInstall(listener) {
      installListeners.add(listener)
      return () => { installListeners.delete(listener) }
    }
    function toggleLogs(key) {
      setInstallState(key, { logsOpen: !getInstallState(key).logsOpen })
    }
    function appendLog(key, stream, text) {
      const prev = getInstallState(key)
      const next = prev.logs.slice(-499)
      next.push({ stream, text })
      setInstallState(key, { logs: next })
    }

    async function startInstall(repo) {
      const key = repo.fullName
      if (getInstallState(key).status === 'installing') return
      setInstallState(key, { status: 'installing', message: '', logs: [], logsOpen: true, startedAt: Date.now(), spec: '' })
      try {
        const response = await fetch(`${API}/install`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
          body: JSON.stringify({ owner: repo.owner, name: repo.name }),
        })
        if (!response.ok || !response.body) {
          let message = `HTTP ${response.status}`
          try {
            const parsed = await response.json()
            if (parsed && typeof parsed.error === 'string') message = parsed.error
          } catch { /* ignore */ }
          setInstallState(key, { status: 'error', message })
          return
        }
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let nl
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim()
            buffer = buffer.slice(nl + 1)
            if (line === '') continue
            let event
            try { event = JSON.parse(line) } catch { continue }
            if (event.type === 'log') appendLog(key, event.stream, event.text)
            else if (event.type === 'start') setInstallState(key, { spec: typeof event.spec === 'string' ? event.spec : '' })
            else if (event.type === 'done') {
              setInstallState(key, {
                status: event.ok ? 'ok' : 'error',
                message: event.ok ? (event.message || '已安装') : (event.message || `exit ${event.code}`),
                logsOpen: event.ok ? false : true,
              })
            }
          }
        }
        if (getInstallState(key).status === 'installing') {
          setInstallState(key, { status: 'error', message: '连接中断' })
        }
      } catch (error) {
        setInstallState(key, { status: 'error', message: error instanceof Error ? error.message : String(error) })
      }
    }

    // ---- 访问权限检测状态（模块级，跨弹窗开关持久化）----
    const CHECK_IDLE = Object.freeze({ status: 'idle', detail: '' })
    const checkStates = new Map()
    const checkListeners = new Set()
    function getCheckState(key) { return checkStates.get(key) ?? CHECK_IDLE }
    function setCheckState(key, patch) {
      const prev = checkStates.get(key) ?? CHECK_IDLE
      checkStates.set(key, { ...prev, ...patch })
      for (const listener of checkListeners) listener()
    }
    function subscribeCheck(listener) {
      checkListeners.add(listener)
      return () => { checkListeners.delete(listener) }
    }
    // 持久化检测结果到 localStorage（跨刷新记住「有权限/无权限」）
    const CHECK_STORAGE_KEY = 'dsh-top-leaderboard:access'
    function loadPersistedChecks() {
      try {
        if (typeof localStorage === 'undefined') return
        const raw = localStorage.getItem(CHECK_STORAGE_KEY)
        if (!raw) return
        const data = JSON.parse(raw)
        if (data && typeof data === 'object') {
          for (const [key, value] of Object.entries(data)) {
            if (value === 'ok' || value === 'denied') checkStates.set(key, { status: value, detail: '' })
          }
        }
      } catch { /* ignore */ }
    }
    function persistCheck(key, status) {
      try {
        if (typeof localStorage === 'undefined') return
        let data = {}
        const raw = localStorage.getItem(CHECK_STORAGE_KEY)
        if (raw) { try { data = JSON.parse(raw) } catch { data = {} } }
        data[key] = status
        localStorage.setItem(CHECK_STORAGE_KEY, JSON.stringify(data))
      } catch { /* ignore */ }
    }
    async function checkAccess(repo) {
      const key = repo.fullName
      if (getCheckState(key).status === 'checking') return
      setCheckState(key, { status: 'checking', detail: '' })
      try {
        const response = await fetch(`${API}/check`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ owner: repo.owner, name: repo.name }),
        })
        const body = await response.json().catch(() => ({}))
        if (!response.ok) {
          setCheckState(key, { status: 'error', detail: typeof body.error === 'string' ? body.error : `HTTP ${response.status}` })
          return
        }
        const status = body.accessible ? 'ok' : 'denied'
        setCheckState(key, { status, detail: typeof body.detail === 'string' ? body.detail : '' })
        persistCheck(key, status)
      } catch (error) {
        setCheckState(key, { status: 'error', detail: error instanceof Error ? error.message : String(error) })
      }
    }

    const styles = {
      footerButton: {
        display: 'inline-flex', alignItems: 'center', gap: 8, minHeight: 32, boxSizing: 'border-box',
        padding: '6px 10px', border: '1px solid transparent', borderRadius: 8,
        background: 'transparent', color: 'var(--dsw-color-text-primary, inherit)', cursor: 'pointer',
        font: 'inherit', fontSize: 13,
      },
      footerButtonActive: {
        background: 'var(--dsw-color-bg-subtle, rgba(127,127,127,.12))',
        borderColor: 'var(--dsw-color-border, #e4e7ec)',
      },
      icon: { fontSize: 16, lineHeight: 1 },
      backdrop: {
        position: 'fixed', inset: 0, zIndex: 2000, pointerEvents: 'auto',
        background: 'rgba(16, 24, 40, .45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
      },
      dialog: {
        display: 'flex', flexDirection: 'column', width: 'min(780px, 100%)', maxHeight: '86vh',
        background: 'var(--dsw-color-bg-elevated, #fff)', color: 'var(--dsw-color-text-primary, #101828)',
        borderRadius: 14, boxShadow: '0 24px 64px rgba(16,24,40,.35)', overflow: 'hidden',
      },
      header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '16px 18px', borderBottom: '1px solid var(--dsw-color-border, #e4e7ec)' },
      title: { margin: 0, fontSize: 16, fontWeight: 650 },
      subtitle: { margin: '4px 0 0', fontSize: 12, color: 'var(--dsw-color-text-secondary, #667085)' },
      closeButton: { minWidth: 32, minHeight: 32, border: '1px solid var(--dsw-color-border-strong, #cfd4dc)', borderRadius: 8, background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 18, lineHeight: 1 },
      search: { margin: '12px 18px 0', minHeight: 36, boxSizing: 'border-box', padding: '0 12px', border: '1px solid var(--dsw-color-border-strong, #cfd4dc)', borderRadius: 8, background: 'var(--dsw-color-bg-elevated, #fff)', color: 'inherit', font: 'inherit', fontSize: 13 },
      note: { margin: '8px 18px 0', padding: '8px 10px', borderRadius: 8, fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-color-warning, #b54708)', background: 'rgba(247,144,9,.1)' },
      tabs: { display: 'flex', gap: 4, padding: 4, margin: '12px 18px 0', borderRadius: 10, background: 'var(--dsw-color-bg-subtle, rgba(127,127,127,.08))' },
      tab: { minHeight: 30, padding: '5px 13px', border: 0, borderRadius: 7, background: 'transparent', color: 'var(--dsw-color-text-secondary, #667085)', cursor: 'pointer', font: 'inherit', fontSize: 12, whiteSpace: 'nowrap' },
      tabActive: { color: 'var(--dsw-color-text-primary, inherit)', background: 'var(--dsw-color-bg-elevated, #fff)', boxShadow: '0 1px 2px rgba(16,24,40,.08)' },
      list: { flex: 1, overflowY: 'auto', padding: '8px 12px 16px' },
      repoItem: { borderBottom: '1px solid var(--dsw-color-border, #eef0f3)' },
      row: { display: 'grid', gridTemplateColumns: 'auto minmax(0,1fr) auto', gap: 10, alignItems: 'flex-start', padding: '10px 6px' },
      rank: { width: 26, textAlign: 'right', fontSize: 12, fontWeight: 700, color: 'var(--dsw-color-text-secondary, #98a2b3)', paddingTop: 3 },
      rowMain: { minWidth: 0 },
      rowName: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      nameLink: { color: 'inherit', textDecoration: 'none', fontSize: 13.5, fontWeight: 650, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      badge: { padding: '2px 7px', borderRadius: 999, fontSize: 11, background: 'var(--dsw-color-bg-subtle, rgba(127,127,127,.12))', color: 'var(--dsw-color-text-secondary, #475467)' },
      typeBadge: { padding: '1px 6px', borderRadius: 999, fontSize: 10.5, fontWeight: 650, border: '1px solid', lineHeight: 1.4, flexShrink: 0 },
      sizeBadge: { padding: '2px 7px', borderRadius: 999, fontSize: 11, background: 'rgba(127,127,127,.1)', color: 'var(--dsw-color-text-secondary, #475467)', flexShrink: 0 },
      sizeBig: { color: 'var(--dsw-color-warning, #b54708)', background: 'rgba(247,144,9,.12)', border: '1px solid rgba(247,144,9,.35)' },
      lockButton: { padding: 0, border: 0, background: 'transparent', cursor: 'pointer', fontSize: 12, opacity: .9, lineHeight: 1, flexShrink: 0 },
      okBadge: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 18, height: 18, padding: 0, borderRadius: '50%', border: '1px solid var(--dsw-color-success, #067647)', background: 'rgba(6,118,71,.16)', cursor: 'pointer', lineHeight: 1, flexShrink: 0 },
      greenEmoji: { fontSize: 11, filter: 'sepia(1) saturate(4) hue-rotate(70deg)' },
      star: { color: '#d29922', fontSize: 12, fontWeight: 650 },
      description: { margin: '4px 0 0', fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-color-text-secondary, #667085)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' },
      actionCol: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, minWidth: 96 },
      installButton: { display: 'inline-flex', alignItems: 'center', minHeight: 30, padding: '5px 10px', border: '1px solid var(--dsw-color-accent, #7f56d9)', borderRadius: 8, background: 'var(--dsw-color-accent, #7f56d9)', color: '#fff', cursor: 'pointer', font: 'inherit', fontSize: 12, whiteSpace: 'nowrap' },
      installButtonDisabled: { opacity: .7, cursor: 'default' },
      installedButton: { display: 'inline-flex', alignItems: 'center', minHeight: 30, padding: '5px 10px', border: '1px solid var(--dsw-color-success, #067647)', borderRadius: 8, background: 'rgba(6,118,71,.1)', color: 'var(--dsw-color-success, #067647)', font: 'inherit', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', cursor: 'default' },
      retryButton: { minHeight: 26, padding: '3px 9px', border: '1px solid var(--dsw-color-danger, #b42318)', borderRadius: 7, background: 'transparent', color: 'var(--dsw-color-danger, #b42318)', cursor: 'pointer', font: 'inherit', fontSize: 11, whiteSpace: 'nowrap' },
      spinner: { display: 'inline-block', width: 11, height: 11, marginRight: 6, border: '2px solid rgba(255,255,255,.4)', borderTopColor: '#fff', borderRadius: '50%', animation: 'dsh-top-spin .8s linear infinite' },
      resultOk: { fontSize: 11.5, color: 'var(--dsw-color-success, #067647)', whiteSpace: 'nowrap', fontWeight: 600 },
      resultErr: { fontSize: 11.5, color: 'var(--dsw-color-danger, #b42318)', whiteSpace: 'nowrap', fontWeight: 600 },
      logToggle: { marginTop: 6, padding: 0, border: 0, background: 'transparent', color: 'var(--dsw-color-text-secondary, #667085)', cursor: 'pointer', font: 'inherit', fontSize: 11.5 },
      logPanel: { margin: '2px 6px 12px 42px', padding: 10, borderRadius: 8, background: 'var(--dsw-color-bg-subtle, rgba(127,127,127,.08))', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11.5, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 240, overflowY: 'auto', color: 'var(--dsw-color-text-primary, inherit)' },
      logErr: { color: 'var(--dsw-color-danger, #b42318)' },
      empty: { padding: '28px 0', textAlign: 'center', color: 'var(--dsw-color-text-secondary, #667085)', fontSize: 13 },
      error: { margin: '12px 18px', padding: 10, borderRadius: 8, color: 'var(--dsw-color-danger, #b42318)', background: 'rgba(240,68,56,.08)', fontSize: 12 },
    }

    function ensureStyles() {
      if (typeof document === 'undefined' || document.getElementById('dsh-top-leaderboard-style')) return
      const style = document.createElement('style')
      style.id = 'dsh-top-leaderboard-style'
      style.textContent = '@keyframes dsh-top-spin { to { transform: rotate(360deg) } }'
      document.head.appendChild(style)
    }

    async function readResponse(response) {
      let body = {}
      try { body = await response.json() } catch { /* ignore */ }
      if (!response.ok) {
        throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${response.status}`)
      }
      return body
    }

    function LeaderboardButton(props) {
      const wide = props && props.wide
      const isOpen = useSyncExternalStore(subscribeOpen, getOpen)
      return h('button', {
        type: 'button',
        title: '插件热度榜单',
        'aria-label': '插件热度榜单',
        'aria-pressed': isOpen,
        onClick: () => setOpen(!isOpen),
        style: { ...styles.footerButton, ...(isOpen ? styles.footerButtonActive : {}) },
      },
        h('span', { style: styles.icon }, '🏆'),
        wide ? h('span', null, '榜单') : null,
      )
    }

    function AccessBadge({ repo }) {
      if (repo.type !== 'Private') return null
      const key = repo.fullName
      const state = useSyncExternalStore(subscribeCheck, () => getCheckState(key))
      if (state.status === 'ok') {
        return h('button', {
          type: 'button',
          title: '已解锁：有访问权限，可安装（点击重新检测）',
          'aria-label': '有访问权限',
          onClick: () => { void checkAccess(repo) },
          style: styles.okBadge,
        }, h('span', { style: styles.greenEmoji }, '🔓'))
      }
      let icon
      let title
      if (state.status === 'checking') {
        icon = '⏳'; title = '检测访问权限中…'
      } else if (state.status === 'denied') {
        icon = '🔒'; title = `无访问权限${state.detail ? '：' + state.detail : ''}`
      } else if (state.status === 'error') {
        icon = '⚠️'; title = `检测失败${state.detail ? '：' + state.detail : ''}`
      } else {
        icon = '🔒'; title = '私有仓库，点击检测访问权限'
      }
      return h('button', {
        type: 'button',
        title,
        'aria-label': title,
        onClick: () => { void checkAccess(repo) },
        style: styles.lockButton,
      }, icon)
    }

    function ActionCell({ repo, state, elapsed }) {
      const alreadyInstalled = state.status === 'ok' || (state.status === 'idle' && repo.installed === true)
      if (alreadyInstalled) {
        return h('button', {
          type: 'button',
          disabled: true,
          title: state.status === 'ok' ? (state.message || '已安装') : '已安装到 web profile',
          style: styles.installedButton,
        }, '✓ 已安装')
      }
      if (state.status === 'error') {
        return h(Fragment, null,
          h('span', { style: styles.resultErr, title: state.message || '安装失败' }, '✗ 失败'),
          h('button', { type: 'button', onClick: () => { void startInstall(repo) }, style: styles.retryButton }, '重试'),
        )
      }
      const installing = state.status === 'installing'
      return h('button', {
        type: 'button',
        disabled: installing,
        onClick: () => { void startInstall(repo) },
        style: { ...styles.installButton, ...(installing ? styles.installButtonDisabled : {}) },
      },
        installing
          ? h(Fragment, null, h('span', { style: styles.spinner }), `安装中 ${elapsed}s`)
          : '安装',
      )
    }

    const TYPE_META = {
      skill: { label: '技能', color: '#0e9384' },
      bundle: { label: 'Bundle', color: '#067647' },
      cordis: { label: 'Cordis', color: '#7f56d9' },
      marisa: { label: 'Marisa', color: '#b54708' },
    }

    function TypeBadge({ kind }) {
      if (!kind) return null
      const meta = TYPE_META[kind]
      if (!meta) return null
      return h('span', {
        style: { ...styles.typeBadge, color: meta.color, borderColor: meta.color, background: `${meta.color}14` },
        title: `插件类型：${meta.label}`,
      }, meta.label)
    }

    function RepoRow({ repo, index }) {
      const key = repo.fullName
      const state = useSyncExternalStore(subscribeInstall, () => getInstallState(key))
      const [, setTick] = useState(0)
      const installing = state.status === 'installing'
      const sizeText = formatSize(repo.size)
      const sizeBig = repo.size !== null && repo.size !== undefined && repo.size >= 102400
      useEffect(() => {
        if (!installing) return
        const timer = setInterval(() => setTick((value) => value + 1), 1000)
        return () => clearInterval(timer)
      }, [installing])
      const elapsed = state.startedAt ? Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000)) : 0
      const showLogToggle = installing || state.logs.length > 0 || state.status === 'error'

      return h('div', { style: styles.repoItem },
        h('div', { style: styles.row },
          h('span', { style: styles.rank }, `#${index + 1}`),
          h('div', { style: styles.rowMain },
            h('div', { style: styles.rowName },
              h(AccessBadge, { repo }),
              h('a', { href: repo.url, target: '_blank', rel: 'noreferrer', title: repo.fullName, style: styles.nameLink }, repo.fullName),
              h('span', { style: styles.star }, `⭐ ${repo.stars}`),
              repo.language ? h('span', { style: styles.badge }, repo.language) : null,
              h(TypeBadge, { kind: repo.kind }),
              sizeText ? h('span', {
                style: { ...styles.sizeBadge, ...(sizeBig ? styles.sizeBig : {}) },
                title: sizeBig
                  ? '仓库较大（GitHub 统计含历史；浅克隆只下载当前分支文件，安装前会再次提示）'
                  : '仓库大小（GitHub 统计，含历史；浅克隆只下载当前分支文件）',
              }, `📦 ${sizeText}`) : null,
            ),
            repo.description ? h('p', { style: styles.description, title: repo.description }, repo.description) : null,
            showLogToggle
              ? h('button', {
                  type: 'button',
                  'aria-expanded': state.logsOpen,
                  onClick: () => toggleLogs(key),
                  style: styles.logToggle,
                }, state.logsOpen ? '▾ 收起安装日志' : `▸ 展开安装日志${state.status === 'error' ? '（查看失败原因）' : ''}`)
              : null,
          ),
          h('div', { style: styles.actionCol },
            h(ActionCell, { repo, state, elapsed }),
          ),
        ),
        state.logsOpen && showLogToggle
          ? h('pre', { style: styles.logPanel },
              state.logs.length === 0
                ? (state.status === 'error'
                    ? h('span', { style: styles.logErr }, `失败原因：${state.message || '未知错误'}`)
                    : '（等待日志输出…）')
                : state.logs.map((entry, i) => h('span', {
                    key: i,
                    style: entry.stream === 'stderr' ? styles.logErr : undefined,
                  }, entry.text)),
            )
          : null,
      )
    }

    function LeaderboardOverlay() {
      const isOpen = useSyncExternalStore(subscribeOpen, getOpen)
      const [data, setData] = useState(null)
      const [error, setError] = useState(null)
      const [query, setQuery] = useState('')
      const searchRef = useRef(null)
      const [tab, setTab] = useState('leaderboard')

      useEffect(() => {
        if (!isOpen) return
        let cancelled = false
        setError(null)
        setData(null)
        const endpoint = tab === 'topic' ? `${API}/topic` : `${API}/leaderboard`
        fetch(endpoint, { headers: { accept: 'application/json' } })
          .then(readResponse)
          .then((body) => { if (!cancelled) setData(body) })
          .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)) })
        return () => { cancelled = true }
      }, [isOpen, tab])

      useEffect(() => {
        if (isOpen && searchRef.current) searchRef.current.focus()
      }, [isOpen])

      const repos = useMemo(() => {
        const list = data && Array.isArray(data.repos) ? data.repos : []
        const needle = query.trim().toLocaleLowerCase()
        if (needle === '') return list
        return list.filter((repo) => [repo.fullName, repo.description, repo.language, ...(repo.topics || [])]
          .filter(Boolean).join(' ').toLocaleLowerCase().includes(needle))
      }, [data, query])

      if (!isOpen) return null

      const total = data && Array.isArray(data.repos) ? data.repos.length : 0

      return h('div', {
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': '插件热度榜单',
        onClick: () => setOpen(false),
        style: styles.backdrop,
      },
        h('div', { onClick: (event) => event.stopPropagation(), style: styles.dialog },
          h('div', { style: styles.header },
            h('div', null,
              h('h2', { style: styles.title }, '🏆 DSH 插件热度榜单'),
              h('p', { style: styles.subtitle }, total > 0 ? `共 ${total} 个仓库 · 按 Star 排序` : (tab === 'topic' ? '正在加载官方插件…' : '正在加载榜单…')),
            ),
            h('button', { type: 'button', 'aria-label': '关闭', onClick: () => setOpen(false), style: styles.closeButton }, '×'),
          ),
          h('div', { role: 'tablist', style: styles.tabs },
            h('button', { type: 'button', role: 'tab', 'aria-selected': tab === 'leaderboard', onClick: () => setTab('leaderboard'), style: { ...styles.tab, ...(tab === 'leaderboard' ? styles.tabActive : {}) } }, '🏆 热度榜'),
            h('button', { type: 'button', role: 'tab', 'aria-selected': tab === 'topic', onClick: () => setTab('topic'), style: { ...styles.tab, ...(tab === 'topic' ? styles.tabActive : {}) } }, '🔌 官方 dsh-plugin'),
          ),
          h('input', {
            ref: searchRef,
            type: 'search',
            placeholder: '搜索名称 / 描述 / 语言 / 标签…',
            value: query,
            onChange: (event) => setQuery(event.target.value),
            style: styles.search,
          }),
          h('p', { style: styles.note }, tab === 'topic'
            ? '以下为 GitHub 上带 dsh-plugin topic 的公开插件（按 Star 排序，📦 为仓库总大小），可直接安装。'
            : '安装优先走 HTTPS（公共仓库无需密钥），失败自动退回 SSH（需配置 id_rsa_github）。📦 为仓库总大小（GitHub 统计含历史，浅克隆只下载当前分支文件），安装前日志也会提示。私有仓库名前有 🔒，点击可检测你的访问权限；无权限时安装会快速失败并在日志里给出原因。'),
          error && h('p', { role: 'alert', style: styles.error }, error),
          h('div', { style: styles.list },
            !data && !error
              ? h('p', { style: styles.empty }, '加载中…')
              : repos.length === 0
                ? h('p', { style: styles.empty }, '没有匹配的仓库。')
                : repos.map((repo, index) => h(RepoRow, { key: repo.fullName, repo, index })),
          ),
        ),
      )
    }

    const inject = ['slots']
    function apply(ctx) {
      ensureStyles()
      loadPersistedChecks()
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'dsh-top-leaderboard',
        order: 50,
      }, LeaderboardButton))
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'dsh-top-leaderboard',
      }, LeaderboardOverlay))
    }

    module.exports = { inject, apply }
    return module.exports
  },
})
