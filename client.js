/**
 * @local/dsh-prompt-hint — browser (client) half.
 *
 * Two chips on the new-session screen, mounted through the existing
 * `conversation.hero.options` list slot so they line up with the agent-preset
 * and workspace pickers without touching any shipped component:
 *
 *   [role ▾]  [github ▾]  (error text)
 *
 * State lives on the Host and travels over this plugin's own same-origin HTTP
 * routes (`POST prompt-hint/api/state`, `POST prompt-hint/api/set`). A slash
 * command would work too, but the command runner renders a persistent
 * `command/run` flow node in every conversation that executes it, so seeding or
 * syncing through `/prompt-hint set …` would litter every new session with
 * visible command nodes. HTTP leaves the transcript untouched.
 *
 * The picker still answers instantly: the last confirmed choice is cached in
 * localStorage per session and painted before the first request settles; the
 * response then corrects it (the Host is authoritative).
 *
 * No bundler, no JSX, no imports: DSH loads this file with
 * `window.__ModuleLoader__.load({ id, factory })` and hands `factory` a
 * `require` that can resolve `react` plus the shared client primitives.
 */
function buildPromptHintClient(require) {
  const React = require('react')
  const h = React.createElement
  const { useCallback, useEffect, useRef, useState } = React

  const MODULE_ID = '@local/dsh-prompt-hint'
  const NS = 'prompt-hint'
  const STYLE_TAG_ID = MODULE_ID + '/client.css'
  const STORAGE_PREFIX = 'dsh.promptHint.v1:'
  // The Host registers a prefix route at `/prompt-hint/api`; the page may live
  // under a sub-path, so the URL is resolved against the document base.
  const API_ROOT = 'prompt-hint/api/'
  const REQUEST_TIMEOUT_MS = 8000

  // ---------------------------------------------------------------------------
  // Primitives. `@deepseek-ai/dsh-client-ui-primitives` is the shared widget
  // library the shipped seats use (Menu, chip icons). It is optional here: if
  // the module is absent or an export is renamed, the plugin must still render a
  // usable control, so every lookup has an in-file fallback.
  // ---------------------------------------------------------------------------
  let primitives = null
  try {
    primitives = require('@deepseek-ai/dsh-client-ui-primitives')
  } catch (error) {
    // A missing primitive library is a degraded UI, not a fatal plugin error.
    console.warn('[prompt-hint] client primitives unavailable, using fallbacks', error)
  }

  /** React accepts functions and forwardRef/memo objects; anything else is a bug. */
  const isRenderable = (value) => typeof value === 'function' ||
    (value !== null && typeof value === 'object' && typeof value.$$typeof !== 'undefined')

  const Menu = primitives !== null && isRenderable(primitives.Menu) ? primitives.Menu : null
  const AgentIcon = primitives !== null && isRenderable(primitives.IconAgentPresetOutlineRegular)
    ? primitives.IconAgentPresetOutlineRegular
    : FallbackAgentIcon
  const ChevronIcon = primitives !== null && isRenderable(primitives.IconChevronDownOutlineRegular)
    ? primitives.IconChevronDownOutlineRegular
    : FallbackChevronIcon

  // ---------------------------------------------------------------------------
  // Data. Role entries arrive from the Host with localized labels and
  // descriptions; this file only renders them, it never validates or invents
  // role ids. The literals below are a last-resort catalog for the case where
  // the very first request fails and the cache is empty.
  // ---------------------------------------------------------------------------
  const DEFAULT_STATE = { role: 'general', github: 'new' }
  const GITHUB_MODES = ['new', 'off']
  const FALLBACK_ROLE_IDS = [
    'general', 'coder', 'reviewer', 'writer', 'researcher',
    'teacher', 'planner', 'designer', 'data', 'video',
  ]

  const zh = {
    'role.hint': '选择角色，决定本轮对话的系统提示词',
    'role.general.name': '通用助手',
    'role.general.desc': '日常问答与综合任务',
    'role.coder.name': '代码工程师',
    'role.coder.desc': '写代码、改代码、跑测试',
    'role.reviewer.name': '代码审查',
    'role.reviewer.desc': '找问题、查风险、提改进',
    'role.writer.name': '中文写作',
    'role.writer.desc': '润色、改写、成稿',
    'role.researcher.name': '调研分析',
    'role.researcher.desc': '查资料、做对比、给结论',
    'role.teacher.name': '讲解老师',
    'role.teacher.desc': '拆解概念、循序讲解',
    'role.planner.name': '项目经理',
    'role.planner.desc': '拆任务、排优先级、定里程碑',
    'role.designer.name': '视觉设计',
    'role.designer.desc': '界面、配色、排版',
    'role.data.name': '数据分析',
    'role.data.desc': '清洗数据、找规律、出图表',
    'role.video.name': '视频创作者',
    'role.video.desc': '分镜、脚本、节奏设计',
    'github.hint': '选择结果是否上传到新建的 GitHub 仓库',
    'github.new.name': '新建仓库',
    'github.new.desc': '完成后自动创建 GitHub 仓库',
    'github.new.short': '新建仓库',
    'github.off.name': '不上传',
    'github.off.desc': '只保留在本地工作区',
    'github.off.short': '不上传',
    'error.setFailed': '保存失败，已回滚',
    'error.noPageBase': '无法定位插件接口地址',
    'error.badResponse': '接口返回了无法解析的内容',
  }

  const en = {
    'role.hint': 'Pick a role: it decides the system prompt for this conversation',
    'role.general.name': 'General',
    'role.general.desc': 'Everyday Q&A and mixed tasks',
    'role.coder.name': 'Software Engineer',
    'role.coder.desc': 'Write code, change code, run tests',
    'role.reviewer.name': 'Code Reviewer',
    'role.reviewer.desc': 'Find bugs, assess risk, suggest fixes',
    'role.writer.name': 'Writing Editor',
    'role.writer.desc': 'Polish, rewrite, and finish drafts',
    'role.researcher.name': 'Research Analyst',
    'role.researcher.desc': 'Research, compare, and conclude',
    'role.teacher.name': 'Tutor',
    'role.teacher.desc': 'Break down concepts step by step',
    'role.planner.name': 'Project Planner',
    'role.planner.desc': 'Split tasks, rank priorities, set milestones',
    'role.designer.name': 'Visual Designer',
    'role.designer.desc': 'Interfaces, palettes, layout',
    'role.data.name': 'Data Analyst',
    'role.data.desc': 'Clean data, find patterns, chart',
    'role.video.name': 'Video Creator',
    'role.video.desc': 'Storyboards, scripts, pacing',
    'github.hint': 'Choose whether results go to a freshly created GitHub repository',
    'github.new.name': 'New repository',
    'github.new.desc': 'Create a GitHub repository when the work is done',
    'github.new.short': 'New repo',
    'github.off.name': 'Do not upload',
    'github.off.desc': 'Keep the results in the local workspace',
    'github.off.short': 'No upload',
    'error.setFailed': 'Could not save the choice; reverted',
    'error.noPageBase': 'Cannot locate the plugin API',
    'error.badResponse': 'The API returned an unreadable response',
  }

  const DICT = { zh, en }

  /** Used only when the locale service is missing or its `bind` throws. */
  const fallbackTranslate = (key) => (typeof zh[key] === 'string' ? zh[key] : key)

  /** Mirrors the Host's catalog shape: `{ id, label, description }`. */
  const FALLBACK_CATALOG = FALLBACK_ROLE_IDS.map((id) => ({
    id,
    label: { zh: zh['role.' + id + '.name'], en: en['role.' + id + '.name'] },
    description: { zh: zh['role.' + id + '.desc'], en: en['role.' + id + '.desc'] },
  }))

  // ---------------------------------------------------------------------------
  // Transport. Two POST-only JSON routes on the same origin; `credentials:
  // 'same-origin'` keeps cookies, and the request is aborted if the Host hangs
  // so a dead route cannot leave the chip spinning forever.
  // ---------------------------------------------------------------------------
  function routeUrl(method) {
    const base = typeof document !== 'undefined' && typeof document.baseURI === 'string' && document.baseURI !== ''
      ? document.baseURI : ''
    if (base === '') return undefined
    const dir = new URL(base, 'http://dsh.internal/')
    dir.search = ''
    dir.hash = ''
    if (!dir.pathname.endsWith('/')) dir.pathname += '/'
    return new URL(API_ROOT + method, dir)
  }

  async function call(method, payload) {
    const url = routeUrl(method)
    if (url === undefined) return { ok: false, code: 'no-page-base', error: 'no-page-base' }
    if (typeof fetch !== 'function') return { ok: false, code: 'no-fetch', error: 'no-fetch' }
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timer = controller === null ? null : setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await fetch(url.href, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        credentials: 'same-origin',
        signal: controller === null ? undefined : controller.signal,
      })
      let body
      try {
        body = await response.json()
      } catch (error) {
        return { ok: false, code: 'bad-response', error: 'bad-response' }
      }
      if (!response.ok || body === null || typeof body !== 'object' || body.ok !== true) {
        const hostError = body !== null && typeof body === 'object' ? body.error : undefined
        const message = hostError !== null && typeof hostError === 'object' && typeof hostError.message === 'string'
          ? hostError.message : undefined
        return {
          ok: false,
          code: 'host',
          error: typeof message === 'string' && message !== '' ? message : 'HTTP ' + response.status,
        }
      }
      return { ok: true, state: normalizeServerState(body.state) }
    } catch (reason) {
      return { ok: false, code: 'network', error: reason instanceof Error ? reason.message : String(reason) }
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }

  function normalizeRoles(value) {
    if (!Array.isArray(value)) return null
    const roles = []
    for (const entry of value) {
      if (entry === null || typeof entry !== 'object') continue
      if (typeof entry.id !== 'string' || entry.id === '') continue
      roles.push({ id: entry.id, label: entry.label, description: entry.description })
    }
    return roles.length === 0 ? null : roles
  }

  function normalizeServerState(raw) {
    const source = raw !== null && typeof raw === 'object' ? raw : {}
    return {
      role: typeof source.role === 'string' && source.role !== '' ? source.role : DEFAULT_STATE.role,
      github: source.github === 'off' ? 'off' : 'new',
      roles: normalizeRoles(source.roles),
    }
  }

  // ---------------------------------------------------------------------------
  // Persistence. localStorage is the only durable per-session store available to
  // a client plugin; a Map covers private mode and hosts that disable storage.
  // ---------------------------------------------------------------------------
  const memoryStore = new Map()
  const catalogCache = new Map()

  const storageKey = (sessionId) => STORAGE_PREFIX + String(sessionId)

  function storageRead(key) {
    try {
      const value = window.localStorage.getItem(key)
      // `null` is indistinguishable from a denied read, so fall through to the
      // memory copy, which holds the last value this tab wrote.
      if (typeof value === 'string') return value
    } catch (error) {
      // Private mode / storage disabled: the memory copy below still works.
    }
    return memoryStore.has(key) ? memoryStore.get(key) : undefined
  }

  function storageWrite(key, value) {
    memoryStore.set(key, value)
    try {
      window.localStorage.setItem(key, value)
    } catch (error) {
      // Persistence is best effort; the in-memory state is already committed.
    }
  }

  function normalizeStoredState(value) {
    const source = value !== null && typeof value === 'object' ? value : {}
    return {
      // No id validation on this side: the Host owns the catalog and rejects
      // unknown ids; the cache only has to survive as a plain preference pair.
      role: typeof source.role === 'string' && source.role !== '' ? source.role : DEFAULT_STATE.role,
      github: source.github === 'off' ? 'off' : 'new',
    }
  }

  function readStoredState(sessionId) {
    if (sessionId === undefined || sessionId === null) return DEFAULT_STATE
    const raw = storageRead(storageKey(sessionId))
    if (typeof raw !== 'string' || raw === '') return DEFAULT_STATE
    try {
      return normalizeStoredState(JSON.parse(raw))
    } catch (error) {
      // A corrupted entry must not wedge the screen; fall back to defaults.
      return DEFAULT_STATE
    }
  }

  function writeStoredState(sessionId, state) {
    if (sessionId === undefined || sessionId === null) return
    try {
      storageWrite(storageKey(sessionId), JSON.stringify({ role: state.role, github: state.github }))
    } catch (error) {
      // JSON.stringify cannot fail on a plain {role, github} pair.
    }
  }

  function cachedCatalog(sessionId) {
    if (sessionId === undefined || sessionId === null) return FALLBACK_CATALOG
    const cached = catalogCache.get(String(sessionId))
    return Array.isArray(cached) && cached.length > 0 ? cached : FALLBACK_CATALOG
  }

  function cacheCatalog(sessionId, roles) {
    if (sessionId === undefined || sessionId === null) return
    if (Array.isArray(roles) && roles.length > 0) catalogCache.set(String(sessionId), roles)
  }

  // ---------------------------------------------------------------------------
  // Localization helpers. The Host ships labels as `{ zh, en }`; pick the one
  // that matches the page language and fall back to whatever is available.
  // ---------------------------------------------------------------------------
  function detectLang() {
    try {
      const fromDocument = typeof document !== 'undefined' && document.documentElement !== undefined &&
        typeof document.documentElement.lang === 'string' ? document.documentElement.lang : ''
      const tag = fromDocument !== ''
        ? fromDocument
        : typeof navigator !== 'undefined' && typeof navigator.language === 'string' ? navigator.language : ''
      return tag.toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en'
    } catch (error) {
      return 'zh'
    }
  }

  function pickText(value, lang) {
    if (typeof value === 'string') return value
    if (value === null || typeof value !== 'object') return ''
    const preferred = value[lang]
    if (typeof preferred === 'string' && preferred !== '') return preferred
    const keys = Object.keys(value)
    for (const key of keys) {
      if (typeof value[key] === 'string' && value[key] !== '') return value[key]
    }
    return ''
  }

  function roleTitle(catalog, roleId, lang) {
    for (const role of catalog) {
      if (role.id !== roleId) continue
      const text = pickText(role.label, lang)
      if (text !== '') return text
    }
    const dict = lang === 'en' ? en : zh
    const builtin = dict['role.' + roleId + '.name']
    if (typeof builtin === 'string' && builtin !== '') return builtin
    return typeof roleId === 'string' && roleId !== '' ? roleId : DEFAULT_STATE.role
  }

  function errorText(t, failure) {
    if (failure === null || failure === undefined) return t('error.setFailed')
    if (failure.code === 'no-page-base') return t('error.noPageBase')
    if (failure.code === 'bad-response') return t('error.badResponse')
    // Host messages (`invalid role`, `invalid github mode`, 400 body) are already
    // user-readable and locale-neutral enough to show verbatim.
    if (typeof failure.error === 'string' && failure.error !== '') return failure.error
    return t('error.setFailed')
  }

  // ---------------------------------------------------------------------------
  // Styles. Every value is a theme token so the chips inherit light/dark and
  // user themes; class names are prefixed to keep them out of the host's way.
  // The chip rules are the agent-preset seat verbatim, so the two new chips are
  // visually indistinguishable from the mode picker beside them.
  // ---------------------------------------------------------------------------
  const CSS = [
    '.ph_root{display:inline-flex;align-items:center;gap:2px;min-width:0;max-width:100%}',
    '.ph_menuAnchor{min-width:54px;max-width:100%}',
    '.ph_menuAnchorWrap{position:relative;display:inline-flex;min-width:0}',
    '.ph_seat{border-radius:var(--dsw-radius-sm);min-width:0;max-width:min(100%,240px);min-height:28px;',
    'color:var(--dsw-alias-label-primary);white-space:nowrap;cursor:pointer;background:0 0;border:none;',
    'align-items:center;gap:4px;padding:0 8px;font-size:13px;font-weight:500;line-height:20px;display:inline-flex}',
    '.ph_seat:not(:disabled):hover,.ph_seat[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover)}',
    '.ph_seat:disabled{cursor:default;color:var(--dsw-alias-label-quaternary)}',
    '.ph_seatIcon{color:var(--dsw-alias-label-primary);flex:none}',
    '.ph_seatLabel{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}',
    '.ph_chevron{color:var(--dsw-alias-label-caption);flex:none}',
    '.ph_item{flex-direction:column;gap:2px;max-width:280px;display:flex}',
    '.ph_itemName{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}',
    '.ph_itemDesc{color:var(--dsw-alias-label-caption);white-space:normal;font-size:12px;line-height:16px}',
    '.ph_status{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;',
    'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px}',
    // Only the fallback menu needs these: the shared Menu portals itself.
    '.ph_menu{position:absolute;bottom:calc(100% + 6px);right:0;z-index:60;',
    'background:var(--dsw-alias-bg-elevated,canvas);border:1px solid var(--dsw-alias-border-secondary);',
    'border-radius:var(--dsw-radius-md);box-shadow:0 6px 20px rgb(0 0 0 / .18);padding:4px;min-width:220px;',
    'max-height:320px;overflow:auto;display:flex;flex-direction:column;gap:2px}',
    '.ph_menuItem{text-align:left;border:none;background:0 0;border-radius:var(--dsw-radius-sm);',
    'color:var(--dsw-alias-label-primary);cursor:pointer;padding:6px 8px;font:inherit;display:block;width:100%}',
    '.ph_menuItem:hover,.ph_menuItem[aria-checked=true]{background:var(--dsw-alias-interactive-bg-hover)}',
  ].join('')

  /**
   * Install the stylesheet once per document and return a disposer that removes
   * only the tag this call owns. HMR can re-run `apply` while the old tag is
   * still attached, so an existing tag is reused instead of duplicated.
   */
  function ensureStyle() {
    if (typeof document === 'undefined' || document.head === undefined) return () => {}
    const selector = 'style[data-plugin-css=' + JSON.stringify(STYLE_TAG_ID) + ']'
    if (document.querySelector(selector) !== null) return () => {}
    const tag = document.createElement('style')
    tag.dataset.plugin = MODULE_ID
    tag.dataset.pluginCss = STYLE_TAG_ID
    tag.textContent = CSS
    document.head.appendChild(tag)
    return () => {
      if (tag.parentNode !== null) tag.parentNode.removeChild(tag)
    }
  }

  // ---------------------------------------------------------------------------
  // Fallback icons. Drawn at 24px viewBox with a 1.6 stroke so they sit on the
  // same optical grid as the primitives icons they replace.
  // ---------------------------------------------------------------------------
  function FallbackAgentIcon({ className }) {
    return h('svg', {
      className,
      viewBox: '0 0 24 24',
      width: 16,
      height: 16,
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.6,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
      focusable: false,
    },
      h('circle', { cx: 12, cy: 8, r: 3.5 }),
      h('path', { d: 'M4.5 20a7.5 7.5 0 0 1 15 0' }))
  }

  function FallbackChevronIcon({ className }) {
    return h('svg', {
      className,
      viewBox: '0 0 24 24',
      width: 16,
      height: 16,
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.6,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
      focusable: false,
    }, h('path', { d: 'm6 9 6 6 6-6' }))
  }

  /** Upload/cloud mark for the GitHub chip; the primitives set has no GitHub icon. */
  function UploadIcon({ className }) {
    return h('svg', {
      className,
      viewBox: '0 0 24 24',
      width: 16,
      height: 16,
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.6,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
      focusable: false,
    },
      h('path', { d: 'M12 15.5V4' }),
      h('path', { d: 'm7.5 8.5 4.5-4.5 4.5 4.5' }),
      h('path', { d: 'M4 16v2.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V16' }))
  }

  // ---------------------------------------------------------------------------
  // Fallback menu. Used only when the shared Menu primitive is unavailable; it
  // keeps the same anchor contract (button + items) and closes on outside click
  // and Escape, so behaviour does not silently degrade.
  // ---------------------------------------------------------------------------
  function SimpleMenu({ open, onClose, items, selectedId, onSelect, anchor, className, ariaLabel }) {
    const wrapRef = useRef(null)
    const { useEffect: useMenuEffect } = React

    useMenuEffect(() => {
      if (!open) return undefined
      const handlePointer = (event) => {
        const wrap = wrapRef.current
        if (wrap !== null && wrap.contains(event.target)) return
        onClose()
      }
      const handleKey = (event) => {
        if (event.key === 'Escape') onClose()
      }
      document.addEventListener('mousedown', handlePointer, true)
      document.addEventListener('keydown', handleKey)
      return () => {
        document.removeEventListener('mousedown', handlePointer, true)
        document.removeEventListener('keydown', handleKey)
      }
    }, [open, onClose])

    const menu = open
      ? h('div', { className: 'ph_menu', role: 'menu', 'aria-label': ariaLabel },
        items.map((item) => h('button', {
          key: item.id,
          type: 'button',
          role: 'menuitemradio',
          'aria-checked': item.id === selectedId,
          className: 'ph_menuItem',
          onClick: () => onSelect(item.id),
        }, item.label)))
      : null

    return h('span', { className: className !== undefined ? className + ' ph_menuAnchorWrap' : 'ph_menuAnchorWrap', ref: wrapRef }, anchor, menu)
  }

  // ---------------------------------------------------------------------------
  // Slot component.
  // ---------------------------------------------------------------------------
  /**
   * @param props composed by the slot: `sessionId` from our `inject`, `t` bound
   * to the `prompt-hint` namespace, plus the bound translator carried through
   * `inject` for hosts that do not compose `t`.
   */
  function PromptHintOptions(props) {
    const sessionId = props.sessionId
    const t = typeof props.t === 'function'
      ? props.t
      : typeof props.translate === 'function' ? props.translate : fallbackTranslate
    const hasSession = sessionId !== undefined && sessionId !== null
    const lang = detectLang()

    // Paint from cache first: the chip must not flicker through a "loading"
    // state when the tab opens, and the Host response below is authoritative.
    const [state, setState] = useState(() => readStoredState(sessionId))
    const [catalog, setCatalog] = useState(() => cachedCatalog(sessionId))
    const [error, setError] = useState(null)
    const [roleOpen, setRoleOpen] = useState(false)
    const [githubOpen, setGithubOpen] = useState(false)

    const aliveRef = useRef(true)
    // The translator may be rebuilt on every parent render; holding it in a ref
    // keeps the mount effect independent of it, so state is fetched once per
    // session instead of on every parent render.
    const tRef = useRef(t)
    // Monotonic id of the newest user intent: a slow failure from an older click
    // must not roll back a newer, already-committed choice.
    const seqRef = useRef(0)

    useEffect(() => {
      aliveRef.current = true
      return () => {
        aliveRef.current = false
      }
    }, [])

    useEffect(() => {
      tRef.current = t
    })

    const report = useCallback((failure) => {
      if (!aliveRef.current) return
      setError(errorText(tRef.current, failure))
    }, [])

    // Read the Host state once per session. A failure is not user-facing: the
    // cached/default pair is already the right answer, so only a warning is due.
    useEffect(() => {
      let cancelled = false
      const seq = (seqRef.current += 1)
      setState(readStoredState(sessionId))
      setCatalog(cachedCatalog(sessionId))
      setError(null)
      if (!hasSession) {
        return () => {
          cancelled = true
        }
      }
      call('state', { sessionId }).then((result) => {
        if (cancelled) return
        if (!result.ok) {
          console.warn('[prompt-hint] could not read host state, keeping cached values', result.error)
          return
        }
        if (result.state.roles !== null) {
          setCatalog(result.state.roles)
          cacheCatalog(sessionId, result.state.roles)
        }
        if (seq !== seqRef.current) return
        const next = { role: result.state.role, github: result.state.github }
        setState(next)
        writeStoredState(sessionId, next)
      }, (reason) => {
        if (cancelled) return
        console.warn('[prompt-hint] could not read host state', reason)
      })
      return () => {
        cancelled = true
      }
    }, [sessionId, hasSession])

    const commit = useCallback((previous, next) => {
      setRoleOpen(false)
      setGithubOpen(false)
      // Optimistic: the chip must respond to a click immediately; the Host is
      // authoritative and a refusal rolls the local copy back.
      setState(next)
      writeStoredState(sessionId, next)
      setError(null)
      if (!hasSession) return
      const seq = (seqRef.current += 1)
      call('set', { sessionId, role: next.role, github: next.github }).then((result) => {
        if (!aliveRef.current || seq !== seqRef.current) return
        if (!result.ok) {
          setState(previous)
          writeStoredState(sessionId, previous)
          report(result)
          return
        }
        const confirmed = { role: result.state.role, github: result.state.github }
        setState(confirmed)
        writeStoredState(sessionId, confirmed)
        if (result.state.roles !== null) {
          setCatalog(result.state.roles)
          cacheCatalog(sessionId, result.state.roles)
        }
      }, (reason) => {
        if (!aliveRef.current || seq !== seqRef.current) return
        setState(previous)
        writeStoredState(sessionId, previous)
        report({ ok: false, code: 'network', error: reason instanceof Error ? reason.message : String(reason) })
      })
    }, [hasSession, report, sessionId])

    const handleRolePick = useCallback((roleId) => {
      setRoleOpen(false)
      // The catalog is Host-owned: anything it sends is selectable, and the Host
      // rejects ids it does not know.
      if (typeof roleId !== 'string' || roleId === '' || roleId === state.role) return
      commit(state, { role: roleId, github: state.github })
    }, [commit, state])

    const handleGithubPick = useCallback((modeId) => {
      setGithubOpen(false)
      if (modeId !== 'new' && modeId !== 'off') return
      if (modeId === state.github) return
      commit(state, { role: state.role, github: modeId })
    }, [commit, state])

    const roleName = roleTitle(catalog, state.role, lang)
    const githubMode = state.github === 'off' ? 'off' : 'new'

    const roleItems = catalog.map((role) => {
      const name = pickText(role.label, lang) || role.id
      const description = pickText(role.description, lang)
      return {
        id: role.id,
        label: h('span', { className: 'ph_item' },
          h('span', { className: 'ph_itemName' }, name),
          description === '' ? null : h('span', { className: 'ph_itemDesc' }, description)),
      }
    })

    const githubItems = GITHUB_MODES.map((mode) => ({
      id: mode,
      label: h('span', { className: 'ph_item' },
        h('span', { className: 'ph_itemName' }, t('github.' + mode + '.name')),
        h('span', { className: 'ph_itemDesc' }, t('github.' + mode + '.desc'))),
    }))

    const roleAnchor = h('button', {
      type: 'button',
      className: 'ph_seat',
      'aria-haspopup': 'menu',
      'aria-expanded': roleOpen,
      'aria-label': t('role.hint'),
      title: t('role.hint'),
      disabled: !hasSession,
      onClick: () => {
        setGithubOpen(false)
        setRoleOpen((open) => !open)
      },
    },
      h(AgentIcon, { className: 'ph_seatIcon' }),
      h('span', { className: 'ph_seatLabel' }, roleName),
      h(ChevronIcon, { className: 'ph_chevron' }))

    const githubAnchor = h('button', {
      type: 'button',
      className: 'ph_seat',
      'aria-haspopup': 'menu',
      'aria-expanded': githubOpen,
      'aria-label': t('github.hint'),
      title: t('github.hint'),
      disabled: !hasSession,
      onClick: () => {
        setRoleOpen(false)
        setGithubOpen((open) => !open)
      },
    },
      h(UploadIcon, { className: 'ph_seatIcon' }),
      h('span', { className: 'ph_seatLabel' }, t('github.' + githubMode + '.short')),
      h(ChevronIcon, { className: 'ph_chevron' }))

    const roleMenu = Menu !== null
      ? h(Menu, {
        open: roleOpen,
        onClose: () => setRoleOpen(false),
        items: roleItems,
        selectedId: state.role,
        onSelect: handleRolePick,
        align: 'start',
        portal: true,
        className: 'ph_menuAnchor',
        anchor: roleAnchor,
      })
      : h(SimpleMenu, {
        open: roleOpen,
        onClose: () => setRoleOpen(false),
        items: roleItems,
        selectedId: state.role,
        onSelect: handleRolePick,
        anchor: roleAnchor,
        ariaLabel: t('role.hint'),
      })

    const githubMenu = Menu !== null
      ? h(Menu, {
        open: githubOpen,
        onClose: () => setGithubOpen(false),
        items: githubItems,
        selectedId: githubMode,
        onSelect: handleGithubPick,
        align: 'start',
        portal: true,
        className: 'ph_menuAnchor',
        anchor: githubAnchor,
      })
      : h(SimpleMenu, {
        open: githubOpen,
        onClose: () => setGithubOpen(false),
        items: githubItems,
        selectedId: githubMode,
        onSelect: handleGithubPick,
        anchor: githubAnchor,
        ariaLabel: t('github.hint'),
      })

    const status = error === null
      ? null
      : h('span', { className: 'ph_status', role: 'status', title: error }, error)

    return h('span', { className: 'ph_root', 'data-plugin': MODULE_ID }, roleMenu, githubMenu, status)
  }

  // ---------------------------------------------------------------------------
  // Plugin entry.
  // ---------------------------------------------------------------------------
  // No `remote`/`remote.commands` anymore: the chips never touch the command
  // pipeline, so no command flow node can ever appear in a conversation.
  const inject = ['slots', 'locale']

  function apply(ctx) {
    try {
      const locale = ctx.locale || (typeof ctx.get === 'function' ? ctx.get('locale') : null)

      ctx.effect(() => ensureStyle(), MODULE_ID + ':style')

      // Dictionaries are scoped to this namespace; the slot's `locale` field
      // binds `t` for the component automatically.
      ctx.effect(() => {
        if (locale !== null && locale !== undefined && typeof locale.register === 'function') {
          return locale.register(NS, DICT)
        }
        return () => {}
      }, MODULE_ID + ':locale')

      let t = fallbackTranslate
      if (locale !== null && locale !== undefined && typeof locale.bind === 'function') {
        try {
          const bound = locale.bind(NS)
          if (typeof bound === 'function') t = bound
        } catch (error) {
          console.warn('[prompt-hint] locale bind failed, using built-in Chinese strings', error)
        }
      }

      // `conversation.hero.options` is a list slot with session scope, rendered
      // only when a session exists; `inject` receives that session id.
      ctx.effect(() => ctx.slots.inject('conversation.hero.options', () => ctx.slots.register({
        name: 'conversation.hero.options',
        id: 'prompt-hint',
        order: 10,
        locale: NS,
        inject: (sessionId) => ({ sessionId, translate: t }),
      }, PromptHintOptions)), MODULE_ID + ':hero options slot')
    } catch (error) {
      // Never let the chip take the Web UI down.
      console.error('[prompt-hint] client apply failed', error)
    }
  }

  return { inject, apply }
}

window.__ModuleLoader__.load({
  id: '@local/dsh-prompt-hint',
  factory(require) {
    try {
      return buildPromptHintClient(require)
    } catch (error) {
      // A throwing factory aborts the rest of this bundle's client entry; keep
      // the failure local so the Web UI still boots without the chips.
      console.error('[prompt-hint] client module failed to build', error)
      return { inject: [], apply() {} }
    }
  },
})
