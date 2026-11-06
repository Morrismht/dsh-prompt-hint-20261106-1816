/**
 * Host half of `@local/dsh-prompt-hint`.
 *
 * The New Session screen gets two controls (rendered by the Client half):
 * an agent **role** and the **GitHub delivery** mode. The Host owns the
 * authoritative instructions: it keeps the current selection per session and
 * contributes one system-prompt section, so the choice reaches the model on
 * every step without polluting the visible chat history.
 *
 * Why a per-section text function instead of an agent-scoped section:
 * `systemPrompt.section({ text })` may be a function that receives the
 * assembly context (`{ scope, agent, ... }`), which lets one global section
 * resolve a different value per agent at every assembly — no re-registration
 * when the user changes the role mid-session. Verified in the shipped
 * `@deepseek-ai/dsh-plan-mode` package (`plan:policy` section, text reads
 * `context.agent.session`).
 *
 * Why an in-memory Map instead of a session projection:
 * a projection would require appending a custom session event type, and an
 * unknown event type makes a persisted Session refuse to reopen.
 *
 * Why a same-origin HTTP route instead of a slash command:
 * `ctx.commands.execute` durably appends `command/run` / `command/done`, and
 * the shipped client renders those as a persistent flow node in the chat. The
 * Client half used to seed its state through such a command on every mount,
 * which decorated every conversation with a visible command row. The route
 * below carries the same state with no session-log writes at all. The slash
 * command stays registered as a manual/diagnostic fallback only.
 */

import { findRole, ROLES } from './roles.js';

/** Sections are joined in ascending `order`; 800 keeps guidance late but before summaries. */
const SECTION_ORDER = 800;

/** Prompt section name (namespaced so no shipped section can collide). */
const SECTION_NAME = 'prompt-hint:guidance';

/** Slash command name; kept as the manual fallback entry point. */
const COMMAND_NAME = 'prompt-hint';

/** Prefix route owned by this plugin (same-origin, POST + JSON only). */
const ROUTE_PREFIX = '/prompt-hint/api';

/** The two GitHub delivery modes understood by this plugin. */
const GITHUB_MODES = new Set(['new', 'off']);

/** Largest request body accepted by the route, in bytes. */
const BODY_LIMIT = 64 * 1024;

/** How many sessions the Host remembers before evicting the oldest. */
const SELECTION_CAP = 256;

const DEFAULTS = {
  /** Role id used when nothing better is known. */
  role: 'general',
  /** `new` = every task publishes to a freshly created repository. */
  github: 'new'
};

/**
 * @typedef {object} PromptHintConfig
 * @property {string} [githubOwner] Account that owns repositories created for
 *   results. Only used to write the instruction; this plugin never talks to
 *   GitHub itself.
 * @property {string} [publishGuidePath] Absolute path of the local guide that
 *   documents the exact create-and-push commands for this machine.
 * @property {string} [defaultRole] Role id used before the user picks one.
 * @property {'new'|'off'} [defaultGithub] GitHub mode used before the user picks one.
 */

/**
 * Read the session id from an agent, tolerating both the Session object and a
 * plain id string (different call sites in the harness use both shapes).
 *
 * @param {unknown} agent - The assembly context's agent, when present.
 * @returns {string | undefined} The owning session id, or undefined.
 */
function sessionIdOf(agent) {
  if (agent === null || typeof agent !== 'object') return undefined;
  const session = agent.session;
  if (session === null || session === undefined) return undefined;
  if (typeof session === 'string') return session;
  return typeof session.id === 'string' ? session.id : undefined;
}

/**
 * Build the GitHub delivery block of the prompt. Kept short on purpose: the
 * exact commands live in a local guide the model reads only when it actually
 * publishes, so every unrelated turn does not pay for the procedure text.
 *
 * @param {Required<PromptHintConfig>} config - Resolved plugin config.
 * @returns {string} Instruction block for a `github: 'new'` selection.
 */
function githubInstruction(config) {
  return [
    '【交付与发布】本次任务产出成果后，按下面方式交付到 GitHub：',
    '0. 只有真正产出了可交付成果（代码、文档、图表、可运行脚本等）才发布；纯问答、无文件产出的任务跳过发布，并在回复里写明「无成果，未发布」。',
    `1. 新建一个**全新**仓库（owner \`${config.githubOwner}\`，默认 public，默认分支 main），仓库名用 \`<项目名>-<yyyyMMdd-HHmm>\`，重名时加 \`-2\`。不要推送到任何已有仓库。`,
    '2. 只推送最终产物：临时文件、node_modules、.env、密钥、中间渲染件一律不推。',
    `3. 本机 \`github.com:443\` 不通、\`git push\` 会卡死，PowerShell 的 Invoke-RestMethod/curl 也因 TLS 后端不可用而失败；可用路径是 Python 走 REST Git Data API。完整脚本、命名约定与失败处理见本地指南 \`${config.publishGuidePath}\`，动手前先读它，不要凭记忆重写流程。`,
    '4. 完成后在回复里给出仓库 URL、提交 SHA 与文件清单；任何一步失败都要如实说明卡在哪一步（含 HTTP 状态码与错误原文），绝不伪造成功。'
  ].join('\n');
}

/**
 * Normalize plugin config: every field is optional and falls back to the
 * machine-appropriate default, so `config: {}` in the patch is enough.
 *
 * @param {PromptHintConfig} [config] - Raw config from the Cordis patch.
 * @returns {Required<PromptHintConfig>} A complete config.
 */
function resolveConfig(config = {}) {
  const defaultRole = typeof config.defaultRole === 'string' && findRole(config.defaultRole) !== undefined
    ? config.defaultRole
    : DEFAULTS.role;
  const defaultGithub = GITHUB_MODES.has(config.defaultGithub) ? config.defaultGithub : DEFAULTS.github;
  return {
    githubOwner: typeof config.githubOwner === 'string' && config.githubOwner.trim() !== ''
      ? config.githubOwner.trim()
      : 'Morrismht',
    publishGuidePath: typeof config.publishGuidePath === 'string' && config.publishGuidePath.trim() !== ''
      ? config.publishGuidePath.trim()
      : 'C:\\Users\\30123\\Desktop\\agent工作区\\项目文件\\prompt-hint插件\\GITHUB发布指南.md',
    defaultRole,
    defaultGithub
  };
}

/**
 * Read and JSON-parse a request body, refusing anything larger than the cap.
 *
 * @param {import('node:http').IncomingMessage} req - The HTTP request.
 * @returns {Promise<Record<string, unknown>>} The parsed body ({} when empty).
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new Error('body-too-large'));
        req.destroy?.();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text === '') {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

/**
 * Write one JSON response. The Host answers 400 for a throwing handler, but this
 * route always settles explicitly so a client sees a readable failure body.
 *
 * @param {import('node:http').ServerResponse} res - The HTTP response.
 * @param {number} status - HTTP status code.
 * @param {unknown} body - JSON-serializable payload.
 */
function writeJson(res, status, body) {
  if (res.headersSent === true) return;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

/** Services this plugin hard-depends on. */
export const inject = ['systemPrompt', 'commands', 'webServer'];

/**
 * Mount the Host half: one prompt section, the same-origin state route the
 * Client controls call, and the `/prompt-hint` command as a manual fallback.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host plugin context.
 * @param {PromptHintConfig} [config] - Patch config.
 */
export function apply(ctx, config = {}) {
  const settings = resolveConfig(config);

  /**
   * Latest selection per session id. Bounded by insertion order so a long-lived
   * Host cannot grow this map without limit.
   * @type {Map<string, {role: string, github: 'new'|'off'}>}
   */
  const selections = new Map();

  /**
   * Baseline for sessions that have no pick of their own: the configured
   * defaults, frozen at activation. A per-session choice never moves it, so a
   * new session always starts from the shipped defaults — "publish to a new
   * repository every time" stays the default even after another session was
   * switched off.
   */
  const baseline = { role: settings.defaultRole, github: settings.defaultGithub };

  /** Remember one selection, evicting the oldest entry past the cap. */
  function remember(sessionId, next) {
    selections.delete(sessionId);
    selections.set(sessionId, next);
    while (selections.size > SELECTION_CAP) {
      const oldest = selections.keys().next();
      if (oldest.done) break;
      selections.delete(oldest.value);
    }
  }

  /**
   * The selection in force for one session (its own, else the baseline).
   *
   * @param {string | undefined} sessionId - Session id, when known.
   * @returns {{role: string, github: 'new'|'off'}} Effective selection.
   */
  function effective(sessionId) {
    if (sessionId === undefined) return baseline;
    return selections.get(sessionId) ?? baseline;
  }

  /**
   * Validate and apply a partial change for one session; the baseline is left
   * alone so other sessions keep starting from the shipped defaults.
   *
   * @param {string | undefined} sessionId - Session id, when known.
   * @param {{role?: unknown, github?: unknown}} patch - Requested fields.
   * @returns {{ok: true, selection: {role: string, github: 'new'|'off'}} | {ok: false, code: string, message: string}}
   *   The applied selection, or a machine-readable refusal.
   */
  function applyPatch(sessionId, patch) {
    const current = effective(sessionId);
    const next = { role: current.role, github: current.github };
    if (patch.role !== undefined) {
      if (typeof patch.role !== 'string' || findRole(patch.role) === undefined) {
        return {
          ok: false,
          code: 'invalid-role',
          message: `unknown role ${JSON.stringify(patch.role)}; expected one of ${ROLES.map((role) => role.id).join(', ')}`
        };
      }
      next.role = patch.role;
    }
    if (patch.github !== undefined) {
      if (typeof patch.github !== 'string' || !GITHUB_MODES.has(patch.github)) {
        return { ok: false, code: 'invalid-github', message: 'github must be "new" or "off"' };
      }
      next.github = /** @type {'new'|'off'} */ (patch.github);
    }
    if (sessionId !== undefined) remember(sessionId, { role: next.role, github: next.github });
    return { ok: true, selection: { role: next.role, github: next.github } };
  }

  /**
   * The state payload shared by the route and its two methods: the effective
   * selection plus the role catalog so the Client can render its menu without
   * shipping a second copy of the labels.
   *
   * @param {string | undefined} sessionId - Session id, when known.
   * @returns {{role: string, github: 'new'|'off', roles: {id: string, label: object, description: object}[]}}
   *   Serialized state.
   */
  function stateOf(sessionId) {
    const selection = effective(sessionId);
    return {
      role: selection.role,
      github: selection.github,
      roles: ROLES.map((role) => ({
        id: role.id,
        label: role.label,
        description: role.description
      }))
    };
  }

  /** Human-readable summary of one selection (command result + tests). */
  function describe(selection) {
    const role = findRole(selection.role);
    const roleLabel = role === undefined ? selection.role : role.label.zh;
    const githubLabel = selection.github === 'new' ? '每次新建仓库' : '不上传';
    return `角色 = ${roleLabel}；GitHub = ${githubLabel}`;
  }

  // ---------------------------------------------------------------------
  // Prompt section
  // ---------------------------------------------------------------------
  // The text function must never throw: a throwing section fails the whole
  // assembly (the model request), so anything unexpected degrades to no hint.
  ctx.effect(() => ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: (assembly) => {
      try {
        const selection = effective(sessionIdOf(assembly?.agent));
        const blocks = [];
        const role = findRole(selection.role);
        if (role !== undefined && role.prompt !== '') blocks.push(role.prompt);
        if (selection.github === 'new') blocks.push(githubInstruction(settings));
        return blocks.join('\n\n');
      } catch {
        return '';
      }
    }
  }), 'prompt-hint: prompt section');

  // ---------------------------------------------------------------------
  // Same-origin state route (the Client-callable entry point)
  // ---------------------------------------------------------------------
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      try {
        // Same-origin only: the route answers no CORS headers, and a foreign
        // Origin is refused outright rather than trusted to the browser.
        const origin = req.headers.origin;
        const host = req.headers.host;
        if (typeof origin === 'string' && origin !== 'null' && host !== undefined) {
          try {
            if (new URL(origin).host !== host) {
              writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'cross-origin request refused' } });
              return;
            }
          } catch {
            writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'malformed origin' } });
            return;
          }
        }
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'POST required' } });
          return;
        }
        const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname;
        const method = pathname.startsWith(`${ROUTE_PREFIX}/`) ? pathname.slice(ROUTE_PREFIX.length + 1) : undefined;
        if (method === undefined || method.includes('/')) {
          writeJson(res, 404, { ok: false, error: { code: 'not-found', message: `unknown prompt-hint API "${method ?? ''}"` } });
          return;
        }
        let body;
        try {
          body = await readJsonBody(req);
        } catch (error) {
          writeJson(res, 400, { ok: false, error: { code: 'bad-json', message: error instanceof Error ? error.message : String(error) } });
          return;
        }
        const sessionId = typeof body.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : undefined;
        if (method === 'state') {
          writeJson(res, 200, { ok: true, state: stateOf(sessionId) });
          return;
        }
        if (method === 'set') {
          const applied = applyPatch(sessionId, { role: body.role, github: body.github });
          if (!applied.ok) {
            writeJson(res, 400, { ok: false, error: { code: applied.code, message: applied.message } });
            return;
          }
          writeJson(res, 200, { ok: true, state: stateOf(sessionId) });
          return;
        }
        writeJson(res, 404, { ok: false, error: { code: 'not-found', message: `unknown prompt-hint API "${method}"` } });
      } catch (error) {
        ctx.logger?.warn?.('prompt-hint: state route failed');
        ctx.logger?.warn?.(error);
        writeJson(res, 500, { ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : String(error) } });
      }
    }
  }), 'prompt-hint: state route');

  // ---------------------------------------------------------------------
  // Slash command (manual fallback; the Client no longer calls it)
  // ---------------------------------------------------------------------
  ctx.effect(() => ctx.commands.register({
    name: COMMAND_NAME,
    description: '设置本会话的角色与 GitHub 交付方式',
    input: { hint: '[set <roleId> <new|off>]' },
    handler: ({ agent, rawInput }) => {
      const sessionId = sessionIdOf(agent);
      const tokens = String(rawInput ?? '').trim().split(/\s+/).filter((token) => token !== '');
      if (tokens.length === 0) {
        return { kind: 'success', text: `当前：${describe(effective(sessionId))}` };
      }
      if (tokens[0] !== 'set' || tokens.length !== 3) {
        return { kind: 'error', text: `用法：/${COMMAND_NAME} set <roleId> <new|off>` };
      }
      const applied = applyPatch(sessionId, { role: tokens[1], github: tokens[2] });
      if (!applied.ok) {
        return { kind: 'error', text: applied.code === 'invalid-role'
          ? `未知角色 "${tokens[1]}"；可选：${ROLES.map((role) => role.id).join(', ')}`
          : 'GitHub 模式只能是 new 或 off' };
      }
      return { kind: 'success', text: `已设置：${describe(applied.selection)}` };
    }
  }), 'prompt-hint: command');
}
