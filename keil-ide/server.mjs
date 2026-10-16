#!/usr/bin/env node
/**
 * keil-ide v0.1 host — one Node process serving the single-window UI plus a small
 * JSON API over the shared Keil engine (`../keil-core.mjs`).
 *
 * Why this shape: the goal is "AI and the editor in ONE window" with the user's
 * own Keil install doing the compiling (BYOK). µVision cannot host an AI panel
 * (it has no plugin SDK), so the window is ours — but every Keil-specific step
 * stays in the shared core, which the DSH plugin and the MCP server also use.
 *
 * Layers:
 *   UI (public/, Monaco)  ->  this host (HTTP/JSON)  ->  keil-core.mjs  ->  UV4.exe
 *   AI panel              ->  POST /api/chat  ->  `dsh --profile headless` (one-shot agent)
 *
 * Deliberate v0.1 limits (see README): no packaging, no installer, no flashing,
 * no Proteus, no multi-project workspace.
 */
import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdir, copyFile, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildProject,
  inspectToolchain,
  makeNodeRunner,
  readProjectInfo,
} from '../keil-core.mjs'
import { buildSymbolIndex, resolveC51IncludeDir } from '../keil-symbols.mjs'
import { DEFAULT_STOPS, CompletionLruCache, decideMultiline, postprocessCompletion, truncateByTokens } from '../keil-completion.mjs'
import {
  findProjectRoot,
  isModelInvocable,
  isUserInvocable,
  listSkills as listSkillsRegistry,
  loadSkill,
  renderSkillBlock,
} from '../keil-skills.mjs'
import { DEFAULT_PRICING, TokenMeter } from '../keil-tokens.mjs'
import { installSkill, uninstallSkill } from '../keil-skill-install.mjs'
import { DEFAULT_DEVICE, c51ProjectXml, parseWorkspace, starterSource, workspaceXml } from '../keil-project.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = join(here, 'public')
const MONACO_DIR = join(here, 'node_modules', 'monaco-editor', 'min', 'vs')
// A packaged app cannot write into its own asar, so the desktop shell points this
// at the user's data folder (see electron-main.mjs).
const SETTINGS_PATH = process.env.KEIL_IDE_SETTINGS || join(here, 'settings.json')
const PORT = Number(process.env.KEIL_IDE_PORT ?? 4870)
const HOST = '127.0.0.1'
const MAX_BODY = 4 * 1024 * 1024
const CHAT_TIMEOUT_MS = Number(process.env.KEIL_IDE_CHAT_TIMEOUT ?? 300000)
/** Inline completion must fail fast: a late ghost text is worse than none. */
const COMPLETE_TIMEOUT_MS = Number(process.env.KEIL_IDE_INLINE_TIMEOUT ?? 8000)
const COMPLETE_CACHE_TTL_MS = 60_000
const COMPLETE_CACHE_MAX = 200

/**
 * Files the user explicitly opened through the dialog. They may be read AND written
 * for this session even when they sit outside the project — a deliberate, per-file
 * widening driven by the user's own choice (same philosophy as the backup folder).
 */
const sessionFiles = new Set()

/**
 * Preset prompts are EXTERNAL on purpose (the user asked for "外挂、可修改"):
 * they merge from four places, later ones overriding earlier ones BY NAME, so a
 * user can both add new presets and override a bundled one.
 *
 *   bundled  <app>/prompts.json            (seed, ships with the app)
 *   user     %APPDATA%\<product>\prompts.json   (dev: ~/.keil-ai/prompts.json)
 *   project  <project>/.keil-ide/prompts.json
 *   custom   settings.prompts.file
 */
function userPromptsPath() {
  const dir = process.env.KEIL_IDE_SETTINGS ? dirname(SETTINGS_PATH) : join(homedir(), '.keil-ai')
  return join(dir, 'prompts.json')
}

function promptSources(projectDir, promptConfig = {}) {
  const list = [{ path: join(here, 'prompts.json'), from: 'bundled' }]
  list.push({ path: userPromptsPath(), from: 'user' })
  if (projectDir) list.push({ path: join(projectDir, '.keil-ide', 'prompts.json'), from: 'project' })
  // NOTE: `settings` is a local of handleApi, so module-level helpers must be given
  // it explicitly — assuming it is global is exactly the trap that broke the skills
  // endpoints earlier ("settings is not defined").
  const custom = String(promptConfig.file ?? '').trim()
  if (custom) list.push({ path: resolve(custom), from: 'custom' })
  return list
}

/**
 * Read the preset files.
 *
 * Semantics (per the user's spec): the BUNDLED file is a FALLBACK ONLY. It is used
 * exactly when the user has configured no presets, or when their file is broken.
 * The moment any external layer (user / project / custom) yields a valid preset,
 * the bundled ones are not shown at all — merged by name across the external
 * layers, later ones winning.
 */
async function loadPrompts(projectDir, promptConfig = {}) {
  const sources = promptSources(projectDir, promptConfig)
  const read = async (source) => {
    const raw = await readFile(source.path, 'utf8').catch(() => undefined)
    if (raw === undefined) return { source, exists: false, presets: [], error: '' }
    try {
      const json = JSON.parse(raw)
      const presets = (Array.isArray(json.presets) ? json.presets : [])
        .map((entry) => ({
          name: String(entry?.name ?? '').trim(),
          description: String(entry?.description ?? '').trim(),
          text: String(entry?.text ?? '').trim(),
          from: source.from,
          path: source.path,
        }))
        .filter((entry) => entry.name && entry.text)
      return { source, exists: true, presets, error: '' }
    } catch (error) {
      return { source, exists: true, presets: [], error: error.message }
    }
  }

  const merged = new Map()
  const files = []
  const problems = []
  for (const source of sources.filter((entry) => entry.from !== 'bundled')) {
    const result = await read(source)
    for (const preset of result.presets) merged.set(preset.name, preset)
    if (result.error) problems.push(`${source.path}: ${result.error}`)
    files.push({ ...source, exists: result.exists, count: result.presets.length, error: result.error })
  }

  const bundled = sources.find((entry) => entry.from === 'bundled')
  let usedBundled = false
  let bundledReason = ''
  if (merged.size === 0) {
    usedBundled = true
    bundledReason = problems.length
      ? `你的预设文件读不出来（${problems[0]}），暂时用内置的`
      : '你还没有配置预设，先用内置的'
    const result = await read(bundled)
    for (const preset of result.presets) merged.set(preset.name, preset)
    files.unshift({ ...bundled, exists: result.exists, count: result.presets.length, error: result.error, used: true })
  } else {
    files.unshift({ ...bundled, exists: true, count: 0, error: '', used: false })
  }

  return { ok: true, prompts: [...merged.values()], files, problems, usedBundled, bundledReason }
}

const run = makeNodeRunner()

/**
 * Token metering, one isolated fold per surface (DSH's "Token 计量" keeps folds
 * per session; chat and FIM completion are two different surfaces here).
 */
const chatMeter = new TokenMeter()
const completeMeter = new TokenMeter()

/** Seeded on first run so the window is never empty; edit freely in settings.json. */
const DEFAULT_SETTINGS = {
  project: 'E:\\单片机\\作业2\\C program.uvproj',
  recent: ['E:\\单片机\\作业2\\C program.uvproj', 'E:\\单片机\\作业1\\C program\\led.uvproj'],
  // Multi-project workspace (`.uvmpw`); empty = single-project mode.
  workspace: '',
  recentWorkspaces: [],
  // AI backend. mode 'openai' speaks to ANY OpenAI-compatible endpoint
  // (DeepSeek / Ollama / vLLM / LM Studio / one-api / …); mode 'dsh' shells out to
  // `dsh --profile headless`. The apiKey is never returned to the browser.
  ai: {
    // DeepSeek's documented OpenAI-compatible values (docs: 首次调用 API).
    mode: 'openai',
    baseURL: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    apiKey: '',
    temperature: 0.2,
    // Chat answer cap. 2048 cut longer explanations mid-sentence (and the UI never
    // said why); 4096 covers a full Markdown walkthrough with code.
    maxTokens: 4096,
    stream: true,
    // Inline (ghost text) completion. It fires on typing, so the budget matters:
    // small maxTokens, a real stop sequence, debounce, cancel-on-type, and a cache.
    // `url` defaults to `${baseURL}/completions`; DeepSeek's FIM endpoint is
    // https://api.deepseek.com/beta/completions, so set it explicitly there.
    inline: {
      enabled: true,
      maxTokens: 96,
      maxPromptTokens: 2048,
      // Stream and return what exists after this deadline (Continue's
      // "show whatever we have at X ms"). 0 = wait for the full answer.
      partialMs: 350,
      debounceMs: 300,
      minPrefixChars: 3,
      url: '',
      stop: ['\n\n', '```'],
    },
  },
  // Editor preferences: pushed into Monaco right after saving.
  editor: {
    fontSize: 13,
    wordWrap: 'off',
    minimap: false,
    tabSize: 4,
  },
  // Skills: extra directories, the description budget. `sharedDsh: true` is an
  // explicit opt-in to also scan another agent's roots; the IDE ships isolated.
  skills: {
    dirs: [],
    descriptionMaxLength: 500,
    sharedDsh: false,
  },
  // Backups before every write. `dir` empty = "<project>/.backups". The backup
  // folder is its OWN write root: it may deliberately live outside the project.
  backup: {
    enabled: true,
    dir: '',
  },
  // Preset prompts: `file` points at an extra (external) preset file.
  prompts: {
    file: '',
  },
  // Follow files changed by another editor (or by git) while this window is open.
  sync: {
    enabled: true,
    intervalMs: 2000,
  },
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
}

/** Read settings, creating the file from the defaults on first use. */
async function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(await readFile(SETTINGS_PATH, 'utf8')) }
  } catch {
    await writeFile(SETTINGS_PATH, `${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`, 'utf8')
    return { ...DEFAULT_SETTINGS }
  }
}

/** Persist settings; the `ai`, `editor` and `skills` groups merge one level deep
 *  so a patch that omits the API key does not silently erase the stored one. */
async function saveSettings(patch) {
  const current = await loadSettings()
  const next = { ...current, ...patch }
  for (const group of ['ai', 'editor', 'skills', 'backup', 'sync', 'prompts']) {
    if (patch[group] && typeof patch[group] === 'object') {
      next[group] = { ...(current[group] ?? {}), ...patch[group] }
    }
  }
  await writeFile(SETTINGS_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}

/** Resolve a path and refuse anything outside the project directory. */
function insideProject(projectDir, target) {
  const resolved = resolve(target)
  const root = resolve(projectDir)
  return resolved === root || resolved.startsWith(root + sep) ? resolved : undefined
}

/** stat() with a null result instead of a throw. */
async function statOrNull(path) {
  try {
    return await stat(path)
  } catch {
    return null
  }
}

/** Hex artefact facts for the toolbar chip. */
async function hexInfo(info) {
  if (!info.hexPath) return { exists: false, path: '', bytes: 0, mtime: '' }
  const s = await statOrNull(info.hexPath)
  return {
    exists: Boolean(s),
    path: info.hexPath,
    bytes: s ? s.size : 0,
    mtime: s ? s.mtime.toISOString() : '',
    enabled: info.createHexFile,
  }
}

/** On-disk sources vs project-declared sources — catches orphan files. */
async function sourceInventory(info) {
  const entries = await readdir(info.projectDir, { withFileTypes: true }).catch(() => [])
  const onDisk = entries
    .filter((entry) => entry.isFile() && /\.(c|a51|asm|h)$/i.test(entry.name))
    .map((entry) => entry.name)
  const declared = new Set(info.declaredSources.map((source) => source.name.toLowerCase()))
  return {
    declared: info.declaredSources.map((source) => source.name),
    onDisk,
    // A .c/.a51 on disk that the project never declares is never compiled.
    orphans: onDisk.filter((name) => /\.(c|a51|asm)$/i.test(name) && !declared.has(name.toLowerCase())),
    headers: onDisk.filter((name) => /\.h$/i.test(name)),
  }
}

/** Compose the one-shot agent prompt with the facts the engine already knows. */
function agentPrompt({ prompt, project, toolchain }) {
  return [
    '[角色] 你是 8051 单片机开发助手，工作在本机用户的工程上。',
    `[工程] ${project || '(未选择)'}`,
    toolchain && toolchain.uv4Path ? `[工具链] 编译器=${toolchain.uv4Path} (${toolchain.uv4Source})，版本=${toolchain.c51Version}` : '',
    '[已核实的编译器约束] 诊断行形如 main.c(14): error C202: ...，**没有列号**；源文件必须是**无 BOM** 的 UTF-8/GBK，带 BOM 会报 C100 unprintable character 并淹没真错误；工程只编译它声明的文件，同目录下未声明的 .c 不会参与构建；8051 地址空间编码为 0xSSSS_AAAA（CODE=0xFF00、XDATA=0x0100）。',
    '[要求] 直接回答问题；不要编造未验证的 API。若给出代码修改，请用一个 ```c 代码块给出**完整的修改后文件内容**，并在块前写一行 `FILE: <绝对路径>`。',
    '---',
    prompt,
  ]
    .filter(Boolean)
    .join('\n')
}

/** Run the one-shot DSH agent; returns its stdout text. */
function runAgent(fullPrompt, cwd, signal) {
  const script =
    process.env.KEIL_IDE_DSH ??
    join(process.env.LOCALAPPDATA ?? 'C:\\Windows', 'deepseek-harness', 'bin', 'dsh.ps1')
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '--profile', 'headless', fullPrompt]
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, CHAT_TIMEOUT_MS)
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, text: `无法启动 agent: ${error.message}` })
    })
    child.on('close', (exitCode) => {
      clearTimeout(timer)
      resolve({
        ok: exitCode === 0 && !timedOut,
        text: stdout.trim() || (timedOut ? '（agent 超时被终止）' : ''),
        stderr: stderr.trim(),
        exitCode,
        timedOut,
        command: `powershell -File ${script} --profile headless <prompt>`,
      })
    })
  })
}

/* ---------- AI backends: OpenAI-compatible (default) and DSH headless ---------- */

/**
 * The measured C51 facts every model should start from, so answers are grounded
 * in this workspace's evidence instead of guesses.
 */
const C51_SYSTEM_PROMPT = [
  '你是 8051 单片机开发助手，运行在用户的本地 IDE 里，编译由用户本机安装的编译器完成。',
  '已核实的约束（必须遵守，不要编造 API）：',
  '- 编译器诊断行形如 main.c(14): error C202: xxx —— **没有列号**。',
  '- 源文件必须无 BOM：带 BOM 会被报成 C100 unprintable character 并淹没真错误。',
  '- 工程只编译它声明的文件；同目录下未加入工程的 .c 不会参与构建。',
  '- 8051 地址空间编码为 0xSSSS_AAAA：CODE=0xFF00、XDATA=0x0100。',
  '- 常用 SFR 由 <reg51.h> 提供（P0~P3、TMOD、TH0/TL0、SCON、IE、IP…）；sbit 只能定义在 SFR 的位上。',
  '回答要求：简洁、可执行；给出代码修改时用一个 ```c 代码块输出**完整文件内容**，并在代码块前一行写 `FILE: <绝对路径>`。',
].join('\n')

/**
 * The skill registry proper lives in ../keil-skills.mjs (ranked roots, kebab-case
 * names, bundle + flat shapes, invocation policy, fresh-body loading). This host
 * only supplies the roots it knows: the project (walking up to the nearest `.git`
 * like DSH does), any configured extra directories, the user level, and the
 * skills shipped next to the app.
 *
 * `skillConfig` is passed in explicitly: the settings object is a local of
 * `handleApi`, not a module-level binding.
 */
async function listSkills(projectDir, skillConfig = {}) {
  const extra = String(process.env.KEIL_IDE_SKILL_DIRS ?? '')
    .split(/[;:]/)
    .map((part) => part.trim())
    .filter(Boolean)
  return listSkillsRegistry({
    projectRoot: projectDir ? await findProjectRoot(projectDir) : '',
    bundledDir: join(here, 'skills'),
    customDirs: [...(skillConfig.dirs ?? []), ...extra],
    descriptionMaxLength: skillConfig.descriptionMaxLength ?? 500,
    // Default OFF: this IDE keeps its own skill table (see keil-skill-install.mjs
    // for the explicit install step).
    includeSharedRoots: skillConfig.sharedDsh === true,
  })
}

/** Effective AI config (environment overrides win over settings.json). */function effectiveAi(settings) {
  const ai = settings.ai ?? {}
  const inline = ai.inline ?? {}
  return {
    mode: process.env.KEIL_IDE_AI_MODE ?? ai.mode ?? 'openai',
    baseURL: String(process.env.KEIL_IDE_AI_BASEURL ?? ai.baseURL ?? 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
    model: String(process.env.KEIL_IDE_AI_MODEL ?? ai.model ?? 'deepseek-chat'),
    apiKey: String(process.env.KEIL_IDE_AI_KEY ?? ai.apiKey ?? ''),
    temperature: typeof ai.temperature === 'number' ? ai.temperature : 0.2,
    maxTokens: Number.isInteger(ai.maxTokens) ? ai.maxTokens : 2048,
    stream: ai.stream !== false,
    inline: {
      enabled: process.env.KEIL_IDE_INLINE === '0' ? false : inline.enabled !== false,
      // Autocomplete is a SEPARATE model role (Continue's central idea): chat can
      // use a big/slow model while completion uses a small/fast one — e.g. keep
      // DeepSeek for chat and point this at a local Ollama for instant tab text.
      // Empty values fall back to the chat configuration.
      baseURL: String(process.env.KEIL_IDE_INLINE_BASEURL ?? inline.baseURL ?? '').replace(/\/+$/, ''),
      model: String(process.env.KEIL_IDE_INLINE_MODEL ?? inline.model ?? ''),
      apiKey: String(process.env.KEIL_IDE_INLINE_KEY ?? inline.apiKey ?? ''),
      maxTokens: Number(process.env.KEIL_IDE_INLINE_TOKENS ?? inline.maxTokens ?? 96),
      maxPromptTokens: Number(inline.maxPromptTokens ?? 2048),
      /** >0 = stream and hand back what we have after this many ms (0 = wait). */
      partialMs: Number(process.env.KEIL_IDE_INLINE_PARTIAL_MS ?? inline.partialMs ?? 350),
      multiline: ['auto', 'always', 'never'].includes(inline.multiline) ? inline.multiline : 'auto',
      debounceMs: Number(inline.debounceMs ?? 300),
      minPrefixChars: Number(inline.minPrefixChars ?? 3),
      url: String(process.env.KEIL_IDE_INLINE_URL ?? inline.url ?? ''),
      stop: Array.isArray(inline.stop) ? inline.stop : DEFAULT_STOPS,
    },
  }
}

/** Never hand the key back to the browser; only report whether one is set. */
function redactSettings(settings) {
  const ai = effectiveAi(settings)
  return {
    ...settings,
    ai: {
      mode: ai.mode,
      baseURL: ai.baseURL,
      model: ai.model,
      temperature: ai.temperature,
      maxTokens: ai.maxTokens,
      stream: ai.stream,
      // The inline role may carry its own key: strip it like the chat key.
      // (JSON.stringify drops `undefined`, so no key can reach the browser.)
      inline: { ...ai.inline, apiKey: undefined },
      apiKeySet: Boolean(ai.apiKey),
      apiKeyHint: ai.apiKey ? `****${ai.apiKey.slice(-4)}` : '',
      inlineApiKeySet: Boolean(ai.inline.apiKey),
      inlineApiKeyHint: ai.inline.apiKey ? `****${ai.inline.apiKey.slice(-4)}` : '',
    },
  }
}

/** A compact project brief so the model writes code for the right device/target. */
async function projectContext(project) {
  if (!project) return ''
  const info = await readProjectInfo(project).catch(() => undefined)
  if (!info) return `[工程] ${project}（无法解析）`
  const sources = await sourceInventory(info).catch(() => undefined)
  const index = await symbolsFor(project).catch(() => undefined)
  const sfrNames = index?.symbols?.filter((symbol) => symbol.kind === 'sfr' || symbol.kind === 'sbit').map((symbol) => symbol.name) ?? []
  return [
    '[工程]',
    `路径: ${info.project}`,
    `器件: ${info.device}  目标: ${info.targetName}  输出: ${info.outputName}  生成HEX: ${info.createHexFile ? '是' : '否'}`,
    sources ? `声明源文件: ${sources.declared.join(', ') || '(无)'}` : '',
    sources?.orphans?.length ? `⚠ 未加入工程（不会被编译）: ${sources.orphans.join(', ')}` : '',
    index ? `头文件: ${index.headers.join(', ') || '(无)'}` : '',
    sfrNames.length ? `可用 SFR/位: ${sfrNames.join(', ')}` : '',
    index?.symbols?.length
      ? `工程符号: ${index.symbols.filter((symbol) => !symbol.system && symbol.from !== 'header').map((symbol) => symbol.name).slice(0, 40).join(', ')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Symbol index for one project, cached until the project file, its sources or the
 * linker map change (so completion does not re-parse on every keystroke).
 */
const symbolCache = new Map()
async function symbolsFor(project) {
  const info = await readProjectInfo(project).catch(() => undefined)
  if (!info) return { error: `无法读取工程: ${project}` }
  const stampFiles = [
    info.project,
    ...info.declaredSources.map((source) =>
      source.path ? resolve(info.projectDir, source.path) : join(info.projectDir, source.name),
    ),
    join(info.projectDir, 'Listings', `${info.outputName}.m51`),
  ]
  const parts = []
  for (const file of stampFiles) {
    const fileStat = await statOrNull(file)
    parts.push(`${fileStat ? fileStat.mtimeMs : 0}:${fileStat ? fileStat.size : 0}`)
  }
  const key = parts.join('|')
  const cached = symbolCache.get(project)
  if (cached && cached.key === key) return { ...cached.index, cached: true }
  const include = await resolveC51IncludeDir(run)
  const index = await buildSymbolIndex(project, { c51IncludeDir: include.dir })
  symbolCache.set(project, { key, index })
  return { ...index, cached: false }
}

/** One non-streaming OpenAI-compatible completion. */
async function chatOnce(ai, messages) {
  const url = `${ai.baseURL}/chat/completions`
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(ai.apiKey ? { authorization: `Bearer ${ai.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: ai.model,
        messages,
        temperature: ai.temperature,
        max_tokens: ai.maxTokens,
        stream: false,
      }),
    })
    const raw = await response.text()
    if (!response.ok) {
      return { ok: false, error: `上游 ${response.status}: ${raw.slice(0, 600) || '(空响应)'}`, status: response.status, url }
    }
    const json = JSON.parse(raw)
    return {
      ok: true,
      text: json.choices?.[0]?.message?.content ?? '',
      url,
      model: json.model ?? ai.model,
      usage: json.usage ?? null,
      // "length" = the provider cut the answer at the token cap.
      finishReason: json.choices?.[0]?.finish_reason ?? '',
    }
  } catch (error) {
    return { ok: false, error: `无法连接 ${url}: ${error.message}`, url }
  }
}

/** Stream an OpenAI-compatible completion to the browser as SSE. */
async function streamChat(res, ai, messages) {
  const url = `${ai.baseURL}/chat/completions`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS)
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
  try {
    const upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(ai.apiKey ? { authorization: `Bearer ${ai.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: ai.model,
        messages,
        temperature: ai.temperature,
        max_tokens: ai.maxTokens,
        stream: true,
      }),
      signal: controller.signal,
    })
    if (!upstream.ok || !upstream.body) {
      const raw = await upstream.text().catch(() => '')
      send({ error: `上游 ${upstream.status}: ${raw.slice(0, 600) || '(空响应)'}`, url })
      return res.end()
    }
    const reader = upstream.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let full = ''
    let usage = null
    let finishReason = ''
    const handleLine = (line) => {
      if (!line.startsWith('data:')) return
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') return
      try {
        const json = JSON.parse(payload)
        if (json.usage) usage = json.usage
        const choice = json.choices?.[0]
        // "length" means the provider cut the answer at the token cap. Without this
        // the UI showed a short reply and said nothing about why.
        if (choice?.finish_reason) finishReason = String(choice.finish_reason)
        const delta = choice?.delta?.content ?? ''
        if (delta) {
          full += delta
          send({ delta })
        }
      } catch {
        // providers emit keep-alive comments and non-JSON frames; ignore them
      }
    }
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        handleLine(line)
      }
    }
    // Flush the tail: a final `data:` line often arrives WITHOUT a trailing newline,
    // and a multi-byte character can still sit inside the decoder. Dropping that tail
    // is exactly how "回复被截断" happens.
    buffer += decoder.decode()
    for (const line of buffer.split('\n')) if (line.trim()) handleLine(line.trim())
    buffer = ''
    send({ done: true, text: full, url, model: ai.model, usage, finishReason })
    return usage
  } catch (error) {
    send({ error: `调用失败: ${error.message}`, url })
  } finally {
    clearTimeout(timer)
    res.end()
  }
}

/** One fill-in-the-middle completion.
 *
 *  Streams when `partialMs > 0`, and returns whatever the model has produced once
 *  that deadline passes — the trick Continue uses in `showWhateverWeHaveAtXMs`
 *  (`autocomplete/filtering/streamTransforms/lineStream.ts`). A slow cloud
 *  endpoint then still shows *something* in the few hundred milliseconds a
 *  developer is willing to wait, instead of nothing for 1-3 seconds.
 *
 *  An empty stream at the deadline keeps waiting (an empty ghost text is useless),
 *  and a partial answer is never cached by the caller.
 */
async function completeOnce(ai, prefix, suffix, options = {}) {
  const multiline = options.multiline !== false
  const partialMs = Math.max(0, Number(options.partialMs ?? ai.inline.partialMs ?? 0))
  const baseURL = ai.inline.baseURL || ai.baseURL
  const model = ai.inline.model || ai.model
  const apiKey = ai.inline.apiKey || ai.apiKey
  const url = ai.inline.url || `${baseURL}/completions`
  // A single-line request stops the model at the line break instead of hoping.
  const stop = multiline ? ai.inline.stop : [...new Set([...ai.inline.stop, '\n'])]
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), COMPLETE_TIMEOUT_MS)
  const started = Date.now()
  let firstChunkMs = 0
  let earlyStop = ''
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        prompt: prefix,
        suffix,
        max_tokens: ai.inline.maxTokens,
        temperature: 0,
        stream: partialMs > 0,
        stop,
      }),
      signal: controller.signal,
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      return { ok: false, error: `上游 ${response.status}: ${detail.slice(0, 300) || '(空响应)'}`, url, model }
    }

    const contentType = response.headers.get('content-type') ?? ''
    const isStream = contentType.includes('event-stream')
    let rawText = ''
    let usage = null

    /** Parse one SSE data-frame payload; both completion shapes are accepted. */
    const takeFrame = (payload) => {
      const trimmed = payload.trim()
      if (!trimmed || trimmed === '[DONE]') return
      try {
        const json = JSON.parse(trimmed)
        if (json.usage) usage = json.usage
        const choice = json.choices?.[0]
        rawText += choice?.text ?? choice?.delta?.content ?? ''
      } catch {
        // A malformed frame must not kill the completion.
      }
    }

    if (isStream) {
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let deadlinePassed = false
      // The deadline must fire on a TIMER, not on chunk arrival: a slow model can
      // pause for seconds between frames, and that pause is exactly what we want
      // to cut short. (Measured: a chunk-arrival check waited the full 1510 ms.)
      const deadlineTimer =
        partialMs > 0
          ? setTimeout(() => {
              deadlinePassed = true
              if (rawText.trim()) {
                earlyStop = 'deadline'
                reader.cancel().catch(() => {})
              }
            }, partialMs)
          : null
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (!firstChunkMs) firstChunkMs = Date.now() - started
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            if (line.trim().startsWith('data:')) takeFrame(line.trim().slice(5))
          }
          // Nothing usable yet: keep waiting even past the deadline (an empty
          // ghost text helps nobody). Cut as soon as there is text to show.
          if (deadlinePassed && !earlyStop && rawText.trim()) {
            earlyStop = 'deadline'
            await reader.cancel().catch(() => {})
            break
          }
        }
      } finally {
        if (deadlineTimer) clearTimeout(deadlineTimer)
      }
    } else {
      const text = await response.text()
      const json = JSON.parse(text)
      const choice = json.choices?.[0]
      rawText = choice?.text ?? choice?.message?.content ?? ''
      usage = json.usage ?? null
    }

    const { text, notes } = postprocessCompletion(rawText, { prefix, suffix, multiline })
    const partial = Boolean(earlyStop)
    if (partial) notes.push(`已到 ${partialMs} ms：先给已有内容`)
    return {
      ok: true,
      text,
      notes,
      url,
      model,
      rawLength: rawText.length,
      usage,
      partial,
      earlyStop: earlyStop || 'complete',
      firstChunkMs,
      ms: Date.now() - started,
    }
  } catch (error) {
    return { ok: false, error: error.name === 'AbortError' ? `超时（>${COMPLETE_TIMEOUT_MS} ms）` : error.message, url, model }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * One prefix-keyed LRU per endpoint+model (completions are model-specific).
 * Ported from Continue's `AutocompleteLruCache`: a query that merely typed more
 * characters reuses the stored answer instead of paying for another request.
 */
const completeCaches = new Map()
function cacheFor(namespace) {
  let cache = completeCaches.get(namespace)
  if (!cache) {
    cache = new CompletionLruCache({ capacity: COMPLETE_CACHE_MAX, ttlMs: COMPLETE_CACHE_TTL_MS })
    completeCaches.set(namespace, cache)
  }
  return cache
}
const completeStats = { requests: 0, hits: 0, errors: 0, lastMs: 0 }

/** Model lists are cached per endpoint+key: the picker asks often, providers dislike it. */
const modelCache = new Map()
const MODEL_CACHE_TTL_MS = 5 * 60_000

/**
 * Probe `GET /models` (also trying `/v1/models`), the OpenAI-compatible endpoint
 * DeepSeek documents as "列出模型" — `{ object: 'list', data: [{ id, owned_by }] }`.
 * The base URL already carries the version (`https://api.deepseek.com/v1`), so the
 * first candidate is normally the right one.
 */
async function listModels(ai, { useCache = true } = {}) {
  const cacheKey = `${ai.baseURL}|${ai.apiKey ? ai.apiKey.slice(-6) : ''}`
  const hit = modelCache.get(cacheKey)
  if (useCache && hit && Date.now() - hit.at < MODEL_CACHE_TTL_MS) {
    return { ...hit.value, cached: true }
  }
  // DeepSeek documents `https://api.deepseek.com` as the OpenAI-compatible base URL,
  // while many OpenAI clients add `/v1`. Accept both — and never build
  // "…/v1/v1/models" (that silly URL showed up in the failure list before).
  const base = String(ai.baseURL ?? '').replace(/\/+$/, '')
  const variants = [base, /\/v1$/i.test(base) ? base.replace(/\/v1$/i, '') : `${base}/v1`]
  const candidates = [...new Set(variants.map((entry) => `${entry}/models`))]
  const tried = []
  // Remember the most meaningful failure so the message can be about the CAUSE
  // (bad key / wrong URL / server down) instead of a generic "cannot list models".
  let failure = { status: 0, detail: '', network: '' }
  for (const url of candidates) {
    try {
      const response = await fetch(url, { headers: ai.apiKey ? { authorization: `Bearer ${ai.apiKey}` } : {} })
      const raw = await response.text()
      if (!response.ok) {
        tried.push(`${url} -> HTTP ${response.status}${raw ? `: ${raw.slice(0, 120)}` : ''}`)
        if (!failure.status) failure = { status: response.status, detail: raw.slice(0, 200), network: '' }
        continue
      }
      const json = JSON.parse(raw)
      const entries = Array.isArray(json.data) ? json.data : []
      const detailed = entries
        .map((entry) => ({
          id: String(entry?.id ?? entry ?? ''),
          ownedBy: String(entry?.owned_by ?? entry?.ownedBy ?? ''),
        }))
        .filter((entry) => entry.id)
      const value = {
        ok: true,
        url,
        models: detailed.map((entry) => entry.id),
        detailed,
        baseURL: ai.baseURL,
        model: ai.model,
      }
      modelCache.set(cacheKey, { value, at: Date.now() })
      return value
    } catch (error) {
      tried.push(`${url} -> ${error.message}`)
      if (!failure.network && !failure.status) failure = { status: 0, detail: '', network: error.message }
    }
  }
  return {
    ok: false,
    baseURL: ai.baseURL,
    model: ai.model,
    tried,
    status: failure.status,
    // Plain language on purpose: the settings dialog shows this sentence as-is.
    error: explainProbeFailure(ai, failure),
  }
}

/** Turn a probe failure into a sentence a user can act on. */
function explainProbeFailure(ai, failure) {
  const host = String(ai.baseURL ?? '').replace(/^https?:\/\//, '')
  const hasKey = Boolean(ai.apiKey)
  if (failure.status === 401 || failure.status === 403) {
    return hasKey
      ? `密钥被拒绝了（HTTP ${failure.status}）：检查密钥是否正确、是否过期，或者是不是另一个服务的密钥`
      : `没有带上密钥（HTTP ${failure.status}）：这个端点需要 API Key，请在下面填一个再试`
  }
  if (failure.status === 404) return `这个地址上没有模型列表接口（HTTP 404）：Base URL 一般写 https://api.deepseek.com（不带 /v1 也行，带 /v1 也认）`
  if (failure.status === 429) return '请求太频繁被限制了（HTTP 429）：等一会儿再试'
  if (failure.status >= 500) return `对方服务器出错（HTTP ${failure.status}）：不是你的配置问题，过一会儿再试`
  if (failure.network) return `连不上 ${host}：${failure.network}（检查网络或代理）`
  return `无法从 ${ai.baseURL} 获取模型列表`
}

/** Roots a READ may reach: the project, its include paths, and Keil's C51 INC.
 *  Writes stay restricted to the project directory (see the /api/file handler). */
async function readRoots(info) {
  const include = await resolveC51IncludeDir(run).catch(() => ({ dir: '' }))
  return [
    info.projectDir,
    ...(info.includePaths ?? []).map((part) => (isAbsolute(part) ? part : resolve(info.projectDir, part))),
    include.dir,
  ].filter(Boolean)
}

/** Resolve one `#include` name against the project dir, its include paths and INC. */
async function resolveInclude(name, searchDirs) {
  const wanted = basename(String(name).replace(/[<>"]/g, '').trim()).toLowerCase()
  if (!wanted) return ''
  for (const dir of searchDirs) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase() === wanted) return join(dir, entry.name)
    }
  }
  return ''
}

const INCLUDE_RE = /^[ \t]*#[ \t]*include[ \t]*[<"]([^>"]+)[>"]/gm

/**
 * The µVision-like project tree: Project > Target > Group > File > included headers.
 * µVision nests each source's `#include`s under it, so we resolve them the same way
 * (project dir, the project's include paths, then Keil's C51 INC).
 */
async function buildProjectTree(info) {
  const searchDirs = [info.projectDir, ...(await readRoots(info)).filter((root) => root !== info.projectDir)]
  const texts = new Map()
  const readText = async (file) => {
    if (!texts.has(file)) texts.set(file, await readFile(file, 'utf8').catch(() => ''))
    return texts.get(file)
  }
  const including = new Set()

  /** Header nodes for one file's #include lines (two levels deep, cycle-guarded). */
  const includeNodes = async (file, depth) => {
    const nodes = []
    const text = await readText(file)
    for (const match of text.matchAll(INCLUDE_RE)) {
      const resolvedPath = await resolveInclude(match[1], searchDirs)
      const node = {
        label: match[1],
        kind: 'header',
        path: resolvedPath,
        resolved: Boolean(resolvedPath),
        source: file,
        children: [],
      }
      if (resolvedPath && depth < 2 && !including.has(resolvedPath)) {
        including.add(resolvedPath)
        node.children = await includeNodes(resolvedPath, depth + 1)
        including.delete(resolvedPath)
      }
      nodes.push(node)
    }
    return nodes
  }

  const fileNode = async (entry) => {
    const absolute = isAbsolute(entry.path || '') ? entry.path : resolve(info.projectDir, entry.path || entry.name)
    const exists = await statOrNull(absolute)
    const node = {
      label: entry.name,
      kind: 'file',
      fileType: entry.fileType,
      path: absolute,
      missing: !exists,
      children: [],
    }
    if (!exists || including.has(absolute)) return node
    including.add(absolute)
    node.children = await includeNodes(absolute, 0)
    including.delete(absolute)
    return node
  }

  const targets = []
  for (const target of info.targets ?? []) {
    const groups = []
    for (const group of target.groups) {
      const children = []
      for (const entry of group.files) children.push(await fileNode(entry))
      groups.push({ label: group.name, kind: 'group', children })
    }
    targets.push({ label: target.name, kind: 'target', children: groups })
  }

  // On-disk sources the project never declares would silently not compile, so the
  // tree surfaces them instead of hiding them.
  const inventory = await sourceInventory(info).catch(() => undefined)
  if (inventory?.orphans?.length) {
    targets.push({
      label: '未加入工程（不会被编译）',
      kind: 'orphan-group',
      children: inventory.orphans.map((name) => ({
        label: name,
        kind: 'orphan',
        path: join(info.projectDir, name),
        children: [],
      })),
    })
  }

  return {
    label: `Project: ${info.outputName || basename(info.project)}`,
    kind: 'project',
    path: info.project,
    children: targets,
  }
}

/** Read a JSON request body with a hard size cap. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error.message}`))
      }
    })
    req.on('error', reject)
  })
}

/** Send a JSON response. */
function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/** Serve one file, or 404. */
function sendFile(res, path) {
  const type = MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
  createReadStream(path).pipe(res)
}

/** API routing. */
async function handleApi(req, res, url) {
  const settings = await loadSettings()

  if (url.pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, pid: process.pid, port: PORT, settings })
  }

  if (url.pathname === '/api/settings') {
    if (req.method === 'POST') {
      const patch = await readBody(req)
      if (patch.ai && typeof patch.ai === 'object') {
        const aiPatch = { ...patch.ai }
        if (aiPatch.clearApiKey) {
          // "清除密钥" clears BOTH roles: the chat key and the optional completion key.
          aiPatch.apiKey = ''
          aiPatch.inline = { ...(aiPatch.inline ?? {}), apiKey: '' }
          delete aiPatch.clearApiKey
        } else if (typeof aiPatch.apiKey === 'string' && aiPatch.apiKey.trim() === '') {
          delete aiPatch.apiKey // an empty string means "leave the stored key alone"
        }
        patch.ai = aiPatch
      }
      return sendJson(res, 200, redactSettings(await saveSettings(patch)))
    }
    // `paths` is not a preference: the 诊断/关于 tab shows where things live.
    return sendJson(res, 200, {
      ...redactSettings(settings),
      paths: { settingsFile: SETTINGS_PATH, appDir: here },
    })
  }

  if (url.pathname === '/api/doctor') {
    return sendJson(res, 200, await inspectToolchain(run))
  }

  if (url.pathname === '/api/project') {
    const project = url.searchParams.get('project') || settings.project
    if (!project) return sendJson(res, 400, { error: 'no project selected' })
    try {
      const info = await readProjectInfo(project)
      return sendJson(res, 200, {
        info,
        sources: await sourceInventory(info),
        hex: await hexInfo(info),
        tree: await buildProjectTree(info),
        readRoots: await readRoots(info),
      })
    } catch (error) {
      return sendJson(res, 200, { error: `无法读取工程: ${error.message}`, project })
    }
  }

  if (url.pathname === '/api/build') {
    const body = await readBody(req)
    const project = body.project || settings.project
    const mode = body.mode === 'rebuild' ? 'rebuild' : body.mode === 'clean' ? 'clean' : 'build'
    try {
      const value = await buildProject(run, { project, mode })
      const info = await readProjectInfo(project).catch(() => undefined)
      return sendJson(res, 200, { value, hex: info ? await hexInfo(info) : undefined })
    } catch (error) {
      return sendJson(res, 200, { error: error.message, project, mode })
    }
  }

  if (url.pathname === '/api/file') {
    // Reads take project/path from the query string; writes send them in the
    // JSON body (that is what the UI does). Accept both, in either case.
    const isWrite = req.method === 'POST'
    const body = isWrite ? await readBody(req) : {}
    const project = body.project || url.searchParams.get('project') || settings.project
    const target = body.path || url.searchParams.get('path')
    if (!project || !target) return sendJson(res, 400, { error: 'project and path are required' })
    const info = await readProjectInfo(project).catch(() => undefined)
    if (!info) return sendJson(res, 400, { error: 'cannot read project' })
    // A file the user explicitly opened through the dialog is readable (and
    // writable) for this session, wherever it lives.
    const safe = sessionFiles.has(String(target).toLowerCase())
      ? target
      : (isWrite ? [info.projectDir] : await readRoots(info))
          .map((root) => insideProject(root, target))
          .find(Boolean)
    if (!safe) {
      return sendJson(res, 403, {
        error: isWrite
          ? '这个文件在工程目录之外，不能直接写入（可以用"打开文件"显式打开它）'
          : '这个文件不在工程和它的头文件目录里（可以用"打开文件"显式打开它）',
      })
    }
    if (isWrite) {
      if (typeof body.text !== 'string') return sendJson(res, 400, { error: 'text is required' })
      const backupConfig = settings.backup ?? {}
      const backupEnabled = backupConfig.enabled !== false
      const previous = await readFile(safe).catch(() => undefined)
      let backup = ''
      let backupDir = ''
      if (backupEnabled && previous) {
        // The backup folder is deliberately its own write root, so it may sit
        // outside the project (a separate drive, OneDrive, …).
        backupDir = backupConfig.dir ? resolve(String(backupConfig.dir)) : join(info.projectDir, '.backups')
        await mkdir(backupDir, { recursive: true })
        backup = join(backupDir, `${Date.now()}-${safe.split(sep).pop()}`)
        await writeFile(backup, previous)
      }
      // Written without a byte-order mark: the compiler would otherwise report the
      // three marker bytes as unprintable characters and bury the real errors.
      await writeFile(safe, body.text, 'utf8')
      const bytes = Buffer.from(body.text, 'utf8')
      // The new mtime lets the page refresh its "external change" baseline, so its
      // own save is not mistaken for somebody else's edit.
      const written = await statOrNull(safe)
      return sendJson(res, 200, {
        ok: true,
        path: safe,
        bytes: bytes.length,
        mtimeMs: written?.mtimeMs ?? 0,
        bomFree: !(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf),
        backup,
        backupDir,
        backupEnabled,
      })
    }
    const text = await readFile(safe, 'utf8')
    const bytes = Buffer.from(text, 'utf8')
    const fileStat = await statOrNull(safe)
    return sendJson(res, 200, {
      path: safe,
      text,
      bomFree: !(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf),
      mtimeMs: fileStat?.mtimeMs ?? 0,
      bytes: bytes.length,
    })
  }

  if (url.pathname === '/api/file/new') {
    const body = await readBody(req)
    const project = body.project || settings.project
    if (!project) return sendJson(res, 400, { error: '还没有选工程' })
    const info = await readProjectInfo(project).catch(() => undefined)
    if (!info) return sendJson(res, 400, { error: '读不到这个工程' })
    const name = String(body.name ?? '').trim()
    // A bare file name only: no directories, no traversal, no drive letters.
    if (!name || /[\\/:*?"<>|]/.test(name) || name.startsWith('.')) {
      return sendJson(res, 400, { error: '文件名只能是不带路径的普通名字（不能有 \\ / : * ? " < > |，也不能以点开头）' })
    }
    const target = join(info.projectDir, name)
    if (await statOrNull(target)) return sendJson(res, 409, { error: `已经有同名文件了: ${target}` })
    const text = typeof body.text === 'string' ? body.text : starterSource(name)
    // No byte-order mark: the compiler would report those three bytes as garbage.
    await writeFile(target, text, 'utf8')
    sessionFiles.add(target.toLowerCase())
    return sendJson(res, 200, {
      ok: true,
      path: target,
      bytes: Buffer.from(text, 'utf8').length,
      fromTemplate: typeof body.text !== 'string',
      inProject: false,
    })
  }

  if (url.pathname === '/api/project/add-file') {
    // µVision only compiles the files its project declares, so a new file must be
    // added to a group to take part in the build. The project XML is backed up first.
    const body = await readBody(req)
    const project = body.project || settings.project
    const info = await readProjectInfo(project).catch(() => undefined)
    if (!info) return sendJson(res, 400, { error: '读不到这个工程' })
    const name = String(body.name ?? '').trim()
    if (!name || /[\\/]/.test(name)) return sendJson(res, 400, { error: '只能加入不带路径的文件名' })
    const target = join(info.projectDir, name)
    if (!(await statOrNull(target))) return sendJson(res, 404, { error: `文件不存在: ${target}` })
    if ((info.declaredSources ?? []).some((source) => String(source.name ?? '').toLowerCase() === name.toLowerCase())) {
      return sendJson(res, 409, { error: `工程里已经声明了 ${name}` })
    }
    const xmlText = await readFile(info.project, 'utf8')
    const openTag = '<Files>'
    const at = xmlText.indexOf(openTag)
    if (at < 0) return sendJson(res, 400, { error: '工程文件里找不到 <Files> 组，什么都没有改' })
    const escaped = name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    // µVision's file types: 1 = C source, 2 = assembler, 5 = text (headers, .inc…).
    // Getting this wrong makes µVision treat a header as a C file to compile.
    const fileType = /\.(c)$/i.test(name) ? 1 : /\.(a51|s)$/i.test(name) ? 2 : 5
    const entry = [
      '            <File>',
      `              <FileName>${escaped}</FileName>`,
      `              <FileType>${fileType}</FileType>`,
      `              <FilePath>.\\${escaped}</FilePath>`,
      '            </File>',
    ].join('\n')
    const backupConfig = settings.backup ?? {}
    let backup = ''
    if (backupConfig.enabled !== false) {
      const backupDir = backupConfig.dir ? resolve(String(backupConfig.dir)) : join(info.projectDir, '.backups')
      await mkdir(backupDir, { recursive: true })
      backup = join(backupDir, `${Date.now()}-${basename(info.project)}`)
      await writeFile(backup, xmlText)
    }
    const updated = `${xmlText.slice(0, at + openTag.length)}\n${entry}${xmlText.slice(at + openTag.length)}`
    await writeFile(info.project, updated, 'utf8')
    return sendJson(res, 200, { ok: true, project: info.project, added: name, backup })
  }

  if (url.pathname === '/api/project/new') {
    const body = await readBody(req)
    const dir = String(body.dir ?? '').trim()
    const name = String(body.name ?? '').trim()
    if (!dir) return sendJson(res, 400, { error: '请先选择工程文件夹' })
    if (!name || /[\\/:*?"<>|]/.test(name)) return sendJson(res, 400, { error: '工程名不能含 \\ / : * ? " < > |' })
    const targetDir = resolve(dir)
    await mkdir(targetDir, { recursive: true })
    const projectPath = join(targetDir, `${name}.uvproj`)
    if (await statOrNull(projectPath)) return sendJson(res, 409, { error: `这个文件夹里已经有 ${name}.uvproj 了` })
    const device = { ...DEFAULT_DEVICE, ...(body.device && typeof body.device === 'object' ? body.device : {}) }
    const files = []
    // STARTUP.A51 is COPIED FROM THE USER'S INSTALL (BYOK) — nothing is bundled.
    // The compiler's own LIB folder sits next to the INC folder we already resolve.
    const include = await resolveC51IncludeDir(run).catch(() => ({ dir: '' }))
    const startupSource = include.dir ? join(dirname(include.dir), 'LIB', 'STARTUP.A51') : ''
    let startupCopied = ''
    if (startupSource && (await statOrNull(startupSource))) {
      startupCopied = join(targetDir, 'STARTUP.A51')
      if (await statOrNull(startupCopied)) {
        // Keep the existing file: the user may have edited it.
        startupCopied = join(targetDir, 'STARTUP.A51')
      } else {
        await copyFile(startupSource, startupCopied)
      }
      files.push({ name: 'STARTUP.A51', fileType: 2 })
    }
    const mainPath = join(targetDir, 'main.c')
    if (!(await statOrNull(mainPath))) await writeFile(mainPath, starterSource('main.c', { withMain: true }), 'utf8')
    files.push({ name: 'main.c', fileType: 1 })
    await writeFile(projectPath, c51ProjectXml({ outputName: name, device, files }), 'utf8')
    return sendJson(res, 200, {
      ok: true,
      project: projectPath,
      dir: targetDir,
      device,
      library: files.map((entry) => entry.name),
      startup: startupCopied,
      startupSource,
    })
  }

  if (url.pathname === '/api/pick-file' || url.pathname === '/api/pick-project' || url.pathname === '/api/pick-workspace') {
    const wantsProject = url.pathname === '/api/pick-project'
    const wantsWorkspace = url.pathname === '/api/pick-workspace'
    const body = req.method === 'POST' ? await readBody(req) : {}
    // An explicit path is accepted so the flow can be driven by tests (and later by
    // drag & drop); otherwise the desktop shell opens a native dialog.
    let chosen = String(body.path ?? '').trim()
    if (!chosen) {
      if (!process.versions.electron) {
        return sendJson(res, 501, { error: '当前不是桌面应用模式，请直接填写文件路径' })
      }
      try {
        const { dialog } = await import('electron')
        const result = await dialog.showOpenDialog({
          title: wantsProject ? '打开工程' : wantsWorkspace ? '打开工作区' : '打开文件',
          properties: ['openFile'],
          filters: wantsWorkspace
            ? [{ name: '工作区文件', extensions: ['uvmpw'] }]
            : wantsProject
              ? [{ name: '工程文件', extensions: ['uvproj', 'uvprojx', 'uv2'] }]
              : [{ name: '源文件', extensions: ['c', 'h', 'a51', 's', 'inc', 'txt', 'md', 'uvproj'] }, { name: '全部文件', extensions: ['*'] }],
        })
        if (result.canceled) return sendJson(res, 200, { ok: false, canceled: true })
        chosen = result.filePaths?.[0] ?? ''
      } catch (error) {
        return sendJson(res, 500, { error: `打不开选择框: ${error.message}` })
      }
    }
    if (!chosen) return sendJson(res, 400, { error: '没有选择文件' })
    const fileStat = await statOrNull(chosen)
    if (!fileStat) return sendJson(res, 404, { error: `文件不存在: ${chosen}` })
    if (fileStat.isDirectory()) return sendJson(res, 400, { error: '这是一个文件夹，请用"选择文件夹"' })
    if (wantsProject) {
      // Remember it, so it shows up in the project dropdown next time.
      const recent = [...new Set([chosen, ...(settings.recent ?? [])])].slice(0, 12)
      await saveSettings({ ...settings, project: chosen, recent })
      settings.project = chosen
      settings.recent = recent
      return sendJson(res, 200, { ok: true, project: chosen, bytes: fileStat.size, recent })
    }
    if (wantsWorkspace) {
      const recentWorkspaces = [...new Set([chosen, ...(settings.recentWorkspaces ?? [])])].slice(0, 12)
      await saveSettings({ ...settings, workspace: chosen, recentWorkspaces })
      settings.workspace = chosen
      settings.recentWorkspaces = recentWorkspaces
      return sendJson(res, 200, { ok: true, workspace: chosen, bytes: fileStat.size, recentWorkspaces })
    }
    sessionFiles.add(chosen.toLowerCase())
    return sendJson(res, 200, { ok: true, path: chosen, bytes: fileStat.size })
  }

  if (url.pathname === '/api/sync') {
    // Cheap mtime stamps for: the file open in the editor, every source the project
    // declares, and the hex artefact — enough for the page to notice that another
    // editor wrote a file while this window stayed open.
    const project = url.searchParams.get('project') || settings.project
    if (!project) return sendJson(res, 400, { error: 'project is required' })
    const info = await readProjectInfo(project).catch(() => undefined)
    if (!info) return sendJson(res, 400, { error: 'cannot read project' })
    const stamp = async (file) => {
      const fileStat = await statOrNull(file)
      return fileStat ? { mtimeMs: fileStat.mtimeMs, size: fileStat.size } : { mtimeMs: 0, size: 0 }
    }
    const wanted = url.searchParams.get('path')
    const sources = []
    for (const declared of info.declaredSources) {
      const file = isAbsolute(declared.path || '') ? declared.path : join(info.projectDir, declared.path || declared.name)
      sources.push({ name: declared.name, path: file, ...(await stamp(file)) })
    }
    return sendJson(res, 200, {
      ok: true,
      project: info.project,
      file: wanted ? { path: wanted, ...(await stamp(wanted)) } : null,
      sources,
      hex: info.hexPath ? { path: info.hexPath, ...(await stamp(info.hexPath)) } : null,
      enabled: (settings.sync ?? {}).enabled !== false,
      intervalMs: Number(settings.sync?.intervalMs ?? 2000),
    })
  }

  if (url.pathname === '/api/pick-folder') {
    const body = req.method === 'POST' ? await readBody(req) : {}
    // Three separate complaints came from this one endpoint:
    //   * the title was hardcoded ("选择备份文件夹") even for 新建工程 / 新建工作区;
    //   * no `defaultPath`, so Windows reopened wherever the picker last was
    //     (the user landed in Downloads);
    //   * no parent window, so the dialog came up detached and unresizable.
    const title = String(body.title ?? '选择文件夹').trim() || '选择文件夹'
    const wanted = String(body.defaultPath ?? '').trim()
    const defaultPath = wanted && (await statOrNull(wanted)) ? wanted : ''
    if (body.dryRun === true) {
      // Lets the tests assert the decision without opening a window.
      return sendJson(res, 200, {
        ok: true,
        dryRun: true,
        title,
        defaultPath,
        parented: Boolean(process.versions.electron),
      })
    }
    // Only the desktop shell can open a native folder picker; in browser/dev mode
    // the UI simply lets the user type the path.
    if (!process.versions.electron) {
      return sendJson(res, 501, { error: '当前不是桌面应用模式，请直接填写文件夹路径' })
    }
    try {
      const { dialog, BrowserWindow } = await import('electron')
      const parent = BrowserWindow.getAllWindows()[0]
      const options = { title, properties: ['openDirectory', 'createDirectory'] }
      if (defaultPath) options.defaultPath = defaultPath
      const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
      return sendJson(res, 200, { ok: !result.canceled, path: result.filePaths?.[0] ?? '', title })
    } catch (error) {
      return sendJson(res, 500, { error: `无法打开文件夹选择框: ${error.message}` })
    }
  }

  if (url.pathname === '/api/prompts') {
    const project = url.searchParams.get('project') || settings.project
    const info = project ? await readProjectInfo(project).catch(() => undefined) : undefined
    return sendJson(res, 200, await loadPrompts(info?.projectDir, settings.prompts))
  }

  if (url.pathname === '/api/prompts/ensure') {
    // One click in the settings makes the presets editable: copy the bundled seed
    // to the user-level file (never overwriting an existing one).
    const target = userPromptsPath()
    if (await statOrNull(target)) {
      return sendJson(res, 200, { ok: true, path: target, created: false })
    }
    const seed = await readFile(join(here, 'prompts.json'), 'utf8').catch(() => '{\n  "presets": []\n}\n')
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, seed, 'utf8')
    return sendJson(res, 200, { ok: true, path: target, created: true })
  }

  if (url.pathname === '/api/prompts/source') {
    // The raw JSON of ONE source, so the settings dialog can edit it in place.
    const which = url.searchParams.get('which') || 'user'
    const project = url.searchParams.get('project') || settings.project
    const info = project ? await readProjectInfo(project).catch(() => undefined) : undefined
    const source = promptSources(info?.projectDir, settings.prompts).find((entry) => entry.from === which)
    if (!source) return sendJson(res, 404, { error: `没有这个预设来源: ${which}` })
    const exists = Boolean(await statOrNull(source.path))
    const text = exists ? await readFile(source.path, 'utf8') : ''
    return sendJson(res, 200, { ok: true, which, path: source.path, exists, text })
  }

  if (url.pathname === '/api/prompts/save') {
    const body = await readBody(req)
    const which = String(body.which ?? 'user')
    const project = body.project || settings.project
    const info = project ? await readProjectInfo(project).catch(() => undefined) : undefined
    // Only the known preset sources may be written — never an arbitrary path.
    const source = promptSources(info?.projectDir, settings.prompts).find((entry) => entry.from === which)
    if (!source) return sendJson(res, 404, { error: `没有这个预设来源: ${which}` })
    const text = String(body.text ?? '')
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      return sendJson(res, 400, { error: `JSON 格式不对：${error.message}` })
    }
    if (!Array.isArray(parsed?.presets)) return sendJson(res, 400, { error: '顶层需要 { "presets": [ … ] }' })
    for (const entry of parsed.presets) {
      if (!String(entry?.name ?? '').trim() || !String(entry?.text ?? '').trim()) {
        return sendJson(res, 400, { error: '每条预设都要有 name（名字）和 text（内容）' })
      }
    }
    await mkdir(dirname(source.path), { recursive: true })
    await writeFile(source.path, text, 'utf8')
    return sendJson(res, 200, { ok: true, path: source.path, which, count: parsed.presets.length })
  }

  if (url.pathname === '/api/workspace') {
    const file = url.searchParams.get('file') || settings.workspace || ''
    if (!file) return sendJson(res, 200, { ok: true, workspace: '', name: '', projects: [] })
    const workspaceFile = resolve(file)
    const text = await readFile(workspaceFile, 'utf8').catch(() => undefined)
    if (text === undefined) return sendJson(res, 404, { error: `读不到工作区文件: ${workspaceFile}` })
    const parsed = parseWorkspace(text)
    const workspaceDir = dirname(workspaceFile)
    const projects = []
    for (const member of parsed.projects) {
      const absPath = isAbsolute(member.pathAndName) ? member.pathAndName : resolve(workspaceDir, member.pathAndName)
      const info = await readProjectInfo(absPath).catch(() => undefined)
      projects.push({
        ...member,
        absPath,
        exists: Boolean(await statOrNull(absPath)),
        name: info?.outputName || basename(absPath).replace(/\.uvproj$/i, ''),
        device: info?.device ?? '',
        // Reported so the UI can offer the one-click "let µVision batch-build it too".
        selectedForBatchBuild: info?.selectedForBatchBuild === true,
        isCurrent: settings.project ? resolve(settings.project).toLowerCase() === absPath.toLowerCase() : false,
      })
    }
    return sendJson(res, 200, { ok: true, workspace: workspaceFile, name: parsed.name || basename(workspaceFile), dir: workspaceDir, projects })
  }

  if (url.pathname === '/api/workspace/new' || url.pathname === '/api/workspace/add' || url.pathname === '/api/workspace/remove') {
    const body = await readBody(req)
    const isNew = url.pathname.endsWith('/new')
    let workspaceFile = ''
    let text = ''
    if (isNew) {
      const dir = String(body.dir ?? '').trim()
      const name = String(body.name ?? '').trim()
      if (!dir) return sendJson(res, 400, { error: '请先选择工作区文件夹' })
      if (!name || /[\\/:*?"<>|]/.test(name)) return sendJson(res, 400, { error: '工作区名不能含 \\ / : * ? " < > |' })
      const targetDir = resolve(dir)
      await mkdir(targetDir, { recursive: true })
      workspaceFile = join(targetDir, `${name}.uvmpw`)
      if (await statOrNull(workspaceFile)) return sendJson(res, 409, { error: `这个文件夹里已经有 ${name}.uvmpw 了` })
    } else {
      workspaceFile = resolve(String(body.file ?? settings.workspace ?? ''))
      if (!workspaceFile) return sendJson(res, 400, { error: '还没有打开工作区' })
      text = await readFile(workspaceFile, 'utf8').catch(() => undefined)
      if (text === undefined) return sendJson(res, 404, { error: `读不到工作区文件: ${workspaceFile}` })
    }
    const parsed = parseWorkspace(text)
    const workspaceDir = dirname(workspaceFile)
    const members = [...parsed.projects]
    if (!isNew) {
      const project = resolve(String(body.project ?? ''))
      if (!project) return sendJson(res, 400, { error: '缺少 project' })
      if (url.pathname.endsWith('/add')) {
        if (!(await statOrNull(project))) return sendJson(res, 404, { error: `工程不存在: ${project}` })
        if (members.some((member) => resolve(workspaceDir, member.pathAndName).toLowerCase() === project.toLowerCase())) {
          return sendJson(res, 409, { error: '这个工程已经在工作区里了' })
        }
        // Relative when it sits under the workspace folder, absolute otherwise.
        const relative = project.toLowerCase().startsWith(workspaceDir.toLowerCase())
        members.push({ pathAndName: relative ? `.\\${project.slice(workspaceDir.length + 1)}` : project, active: true, expanded: true, batchBuild: true })
      } else {
        const before = members.length
        const kept = members.filter((member) => resolve(workspaceDir, member.pathAndName).toLowerCase() !== project.toLowerCase())
        if (kept.length === before) return sendJson(res, 404, { error: '工作区里没有这个工程' })
        members.length = 0
        members.push(...kept)
      }
    } else if (Array.isArray(body.projects)) {
      for (const entry of body.projects) {
        const project = resolve(String(entry))
        if (!(await statOrNull(project))) continue
        const relative = project.toLowerCase().startsWith(dirname(workspaceFile).toLowerCase())
        members.push({ pathAndName: relative ? `.\\${project.slice(dirname(workspaceFile).length + 1)}` : project, active: true, expanded: true, batchBuild: true })
      }
    }
    // An existing file is backed up before it is rewritten (same switch as sources).
    let backup = ''
    if (!isNew && (settings.backup ?? {}).enabled !== false) {
      const backupConfig = settings.backup ?? {}
      const backupDir = backupConfig.dir ? resolve(String(backupConfig.dir)) : join(dirname(workspaceFile), '.backups')
      await mkdir(backupDir, { recursive: true })
      backup = join(backupDir, `${Date.now()}-${basename(workspaceFile)}`)
      await writeFile(backup, text)
    }
    const name = parsed.name || basename(workspaceFile).replace(/\.uvmpw$/i, '')
    await writeFile(workspaceFile, workspaceXml({ name, projects: members }), 'utf8')
    if (isNew) {
      const recentWorkspaces = [...new Set([workspaceFile, ...(settings.recentWorkspaces ?? [])])].slice(0, 12)
      await saveSettings({ ...settings, workspace: workspaceFile, recentWorkspaces })
      settings.workspace = workspaceFile
      settings.recentWorkspaces = recentWorkspaces
    }
    return sendJson(res, 200, { ok: true, workspace: workspaceFile, name, backup, projects: members.length })
  }

  if (url.pathname === '/api/workspace/allow-batch') {
    // µVision's own Batch Build skips a target whose <SelectedForBatchBuild> is 0
    // (measured: "skipped", no hex). Setting it is a change to the user's project
    // file, so it is an explicit action and the file is backed up first.
    const body = await readBody(req)
    const file = resolve(String(body.file ?? settings.workspace ?? ''))
    if (!file) return sendJson(res, 400, { error: '还没有打开工作区' })
    const text = await readFile(file, 'utf8').catch(() => undefined)
    if (text === undefined) return sendJson(res, 404, { error: `读不到工作区文件: ${file}` })
    const parsed = parseWorkspace(text)
    const workspaceDir = dirname(file)
    const backupConfig = settings.backup ?? {}
    const changed = []
    for (const member of parsed.projects) {
      const project = isAbsolute(member.pathAndName) ? member.pathAndName : resolve(workspaceDir, member.pathAndName)
      const xmlText = await readFile(project, 'utf8').catch(() => undefined)
      if (xmlText === undefined) continue
      if (!/<SelectedForBatchBuild>0<\/SelectedForBatchBuild>/.test(xmlText)) continue
      if (backupConfig.enabled !== false) {
        const backupDir = backupConfig.dir ? resolve(String(backupConfig.dir)) : join(dirname(project), '.backups')
        await mkdir(backupDir, { recursive: true })
        await writeFile(join(backupDir, `${Date.now()}-${basename(project)}`), xmlText)
      }
      await writeFile(project, xmlText.replace(/<SelectedForBatchBuild>0<\/SelectedForBatchBuild>/, '<SelectedForBatchBuild>1</SelectedForBatchBuild>'), 'utf8')
      changed.push(project)
    }
    return sendJson(res, 200, { ok: true, changed, count: changed.length })
  }

  if (url.pathname === '/api/workspace/build') {
    // Batch build: every member whose NodeIsCheckedInBatchBuild is set, in order.
    const body = await readBody(req)
    const file = resolve(String(body.file ?? settings.workspace ?? ''))
    if (!file) return sendJson(res, 400, { error: '还没有打开工作区' })
    const text = await readFile(file, 'utf8').catch(() => undefined)
    if (text === undefined) return sendJson(res, 404, { error: `读不到工作区文件: ${file}` })
    const parsed = parseWorkspace(text)
    const workspaceDir = dirname(file)
    const results = []
    for (const member of parsed.projects) {
      const project = isAbsolute(member.pathAndName) ? member.pathAndName : resolve(workspaceDir, member.pathAndName)
      if (!member.batchBuild) {
        results.push({ project, name: basename(project), skipped: true, reason: '未勾选"参与批量编译"' })
        continue
      }
      if (!(await statOrNull(project))) {
        results.push({ project, name: basename(project), skipped: true, reason: '文件不存在' })
        continue
      }
      try {
        const value = await buildProject(run, { project, mode: body.mode === 'rebuild' ? 'rebuild' : 'build' })
        const info = await readProjectInfo(project).catch(() => undefined)
        results.push({
          project,
          name: info?.outputName || basename(project),
          status: value.status,
          exitCode: value.exitCode,
          errors: value.errorCount ?? 0,
          warnings: value.warningCount ?? 0,
          hex: info ? await hexInfo(info) : undefined,
        })
      } catch (error) {
        results.push({ project, name: basename(project), status: 'error', error: error.message })
      }
    }
    return sendJson(res, 200, {
      ok: true,
      workspace: file,
      name: parsed.name,
      results,
      failed: results.filter((entry) => !entry.skipped && entry.status !== 'ok').length,
    })
  }

  if (url.pathname === '/api/reveal') {
    const body = req.method === 'POST' ? await readBody(req) : {}
    const fallback = (await readProjectInfo(settings.project).catch(() => undefined))?.objectsDir
    let target = String(body.path || fallback || '').trim()
    if (!target) return sendJson(res, 400, { error: '没有可打开的路径（工程和 hex 都没有）' })
    // A missing path is the common case (the hex is not generated yet) and Explorer
    // reacts to it by opening 文档, so walk up to the nearest existing ancestor.
    let fileStat = await statOrNull(target)
    while (!fileStat) {
      const parent = dirname(target)
      if (!parent || parent === target) return sendJson(res, 404, { error: `路径不存在: ${target}` })
      target = parent
      fileStat = await statOrNull(target)
    }
    const isDirectory = fileStat.isDirectory()
    // Only the path may be quoted — never the switch. `windowsVerbatimArguments` is
    // required because Node would otherwise wrap the whole "/select,<path>" token in
    // quotes, Explorer would not recognise the switch and would open 文档 instead.
    // (Surfaced by `C program.hex`: the space is what triggers Node's auto-quoting.)
    const quote = (value) => (/\s/.test(value) ? `"${value.replace(/\\+$/, '')}"` : value)
    const argv = isDirectory ? [quote(target)] : [`/select,${quote(target)}`]
    // `dryRun` reports the decision without opening a window (used by the tests, so
    // verifying this does not spray Explorer windows over the user's desktop).
    const dryRun = body.dryRun === true
    if (!dryRun) {
      spawn('explorer.exe', argv, { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref()
    }
    return sendJson(res, 200, { ok: true, revealed: target, kind: isDirectory ? 'directory' : 'file', argv, dryRun })
  }

  if (url.pathname === '/api/symbols') {
    const project = url.searchParams.get('project') || settings.project
    if (!project) return sendJson(res, 400, { error: 'no project selected' })
    return sendJson(res, 200, await symbolsFor(project))
  }

  if (url.pathname === '/api/complete') {
    const body = await readBody(req)
    const ai = effectiveAi(settings)
    if (ai.mode !== 'openai') {
      return sendJson(res, 200, { ok: false, error: `ai.mode=${ai.mode} 不支持行内补全`, items: [] })
    }
    if (!ai.inline.enabled) return sendJson(res, 200, { ok: false, error: '行内补全已关闭', items: [] })
    const prefix = String(body.prefix ?? '')
    const suffix = String(body.suffix ?? '')
    if (prefix.trim().length < ai.inline.minPrefixChars) return sendJson(res, 200, { ok: true, text: '', items: [] })
    // Context budget in tokens (roughly 4 chars per token): three quarters before
    // the cursor, one quarter after — code ahead matters for FIM, but less.
    const budget = Number.isInteger(body.maxPromptTokens) ? body.maxPromptTokens : ai.inline.maxPromptTokens
    const clippedPrefix = truncateByTokens(prefix, Math.max(64, budget - Math.floor(budget / 4)), true)
    const clippedSuffix = truncateByTokens(suffix, Math.max(32, Math.floor(budget / 4)), false)
    // The multi-line decision lives in keil-completion.mjs (unit-tested), not in
    // the browser: it needs the current line both before and after the cursor.
    const multilineMode = typeof body.multilineMode === 'string' ? body.multilineMode : ai.inline.multiline
    const lineBefore = clippedPrefix.text.split('\n').pop() ?? ''
    const lineAfter = clippedSuffix.text.split('\n')[0] ?? ''
    const multiline =
      body.multiline === undefined
        ? decideMultiline(multilineMode, { lineBefore, lineAfter })
        : Boolean(body.multiline)

    const cache = cacheFor(`${ai.inline.baseURL || ai.baseURL}|${ai.inline.model || ai.model}`)
    const hit = cache.get(clippedPrefix.text)
    if (hit) {
      completeStats.hits += 1
      return sendJson(res, 200, {
        ok: true,
        text: hit.text,
        cached: true,
        reusedShift: hit.shift,
        ms: 0,
        multiline,
        model: ai.inline.model || ai.model,
        url: ai.inline.url || `${ai.inline.baseURL || ai.baseURL}/completions`,
        stats: completeStats,
        cache: cache.stats,
      })
    }

    completeStats.requests += 1
    // Token metering for the completion surface (prefix/suffix are what FIM pays for).
    completeMeter.pricing = Array.isArray(ai.pricing) ? ai.pricing : DEFAULT_PRICING
    completeMeter.observeSurface(
      { model: ai.inline.model || ai.model, baseURL: ai.inline.baseURL || ai.baseURL },
      [
        { role: 'prompt', content: clippedPrefix.text },
        { role: 'suffix', content: clippedSuffix.text },
      ],
    )
    const started = Date.now()
    const partialMs = Number.isInteger(body.partialMs) ? body.partialMs : ai.inline.partialMs
    const result = await completeOnce(ai, clippedPrefix.text, clippedSuffix.text, { multiline, partialMs })
    if (result.usage) completeMeter.observeUsage(result.usage)
    const ms = Date.now() - started
    completeStats.lastMs = ms
    if (!result.ok) completeStats.errors += 1
    // A PARTIAL answer must never be cached: it would poison later hits with a
    // truncated completion for the same prefix.
    else if (!result.partial) cache.put(clippedPrefix.text, result.text)
    return sendJson(res, 200, {
      ...result,
      cached: false,
      ms,
      truncated: clippedPrefix.truncated || clippedSuffix.truncated,
      multiline,
      stats: completeStats,
      cache: cache.stats,
    })
  }

  if (url.pathname === '/api/models') {
    // The picker may test UNSAVED credentials, so an `ai` patch wins over settings
    // (environment overrides still win over both, as everywhere else).
    const body = req.method === 'POST' ? await readBody(req) : {}
    const patch = body.ai && typeof body.ai === 'object' ? body.ai : {}
    const merged = effectiveAi({ ...settings, ai: { ...(settings.ai ?? {}), ...patch } })
    const result = await listModels(
      { baseURL: String(merged.baseURL ?? '').replace(/\/+$/, ''), apiKey: merged.apiKey, model: merged.model },
      { useCache: body.refresh !== true },
    )
    return sendJson(res, 200, { ...result, mode: merged.mode })
  }

  if (url.pathname === '/api/ai/test') {
    // The dialog may test UNSAVED credentials, so the request's `ai` patch must win
    // over the saved settings — exactly like /api/models. Ignoring it here made
    // "test connection" fail with 401 while "fetch model list" succeeded, because
    // only the latter saw the key the user had just typed.
    const body = req.method === 'POST' ? await readBody(req) : {}
    const patch = body.ai && typeof body.ai === 'object' ? body.ai : {}
    const ai = effectiveAi({ ...settings, ai: { ...(settings.ai ?? {}), ...patch } })
    if (ai.mode !== 'openai') {
      return sendJson(res, 200, { ok: false, mode: ai.mode, error: `当前 ai.mode=${ai.mode}，不是 openai` })
    }
    const result = await listModels({ ...ai, baseURL: String(ai.baseURL ?? '').replace(/\/+$/, '') })
    if (result.ok) return sendJson(res, 200, { ...result, mode: 'openai', usedKey: Boolean(ai.apiKey) })
    // A failed live probe may still have a cached list from an earlier success: say
    // so instead of contradicting what the dropdown shows.
    const stale = modelCache.get(`${String(ai.baseURL ?? '').replace(/\/+$/, '')}|${ai.apiKey ? ai.apiKey.slice(-6) : ''}`)
    return sendJson(res, 200, {
      ...result,
      mode: 'openai',
      usedKey: Boolean(ai.apiKey),
      cachedModels: stale?.value?.models ?? [],
      cachedAt: stale ? new Date(stale.at).toISOString() : '',
    })
  }

  if (url.pathname === '/api/tokens') {
    return sendJson(res, 200, {
      chat: chatMeter.measure(),
      complete: completeMeter.measure(),
      breakdown: { chat: chatMeter.breakdown(), complete: completeMeter.breakdown() },
    })
  }

  if (url.pathname === '/api/tokens/reset' && req.method === 'POST') {
    chatMeter.reset()
    completeMeter.reset()
    return sendJson(res, 200, { ok: true })
  }

  if (url.pathname === '/api/skills/install') {
    const body = await readBody(req)
    const project = body.project || settings.project
    const info = project ? await readProjectInfo(project).catch(() => undefined) : undefined
    const projectRoot = info?.projectDir ? await findProjectRoot(info.projectDir) : ''
    const scope = body.scope === 'project' ? 'project' : 'user'
    const targetDir =
      scope === 'project' ? (projectRoot ? join(projectRoot, '.keil-ide', 'skills') : '') : join(homedir(), '.keil-ai', 'skills')
    if (!targetDir) return sendJson(res, 400, { error: '安装到工程范围需要先选择一个工程' })
    const result = await installSkill({
      source: String(body.source ?? '').trim(),
      targetDir,
      scope,
      force: body.force === true,
      descriptionMaxLength: (settings.skills ?? {}).descriptionMaxLength ?? 500,
    })
    return sendJson(res, result.ok ? 200 : result.code ?? 400, result)
  }

  if (url.pathname === '/api/skills/uninstall') {
    const body = await readBody(req)
    const project = body.project || settings.project
    const info = project ? await readProjectInfo(project).catch(() => undefined) : undefined
    const registry = await listSkills(info?.projectDir, settings.skills)
    // Only this IDE's own tables: never delete another agent's skill, and never a
    // bundled one.
    const roots = registry.roots.filter(
      (root) => !['bundled', 'project-dsh', 'user-dsh', 'project-agents'].includes(root.source),
    )
    const result = await uninstallSkill({ name: body.name, roots })
    return sendJson(res, result.ok ? 200 : result.code ?? 400, result)
  }

  if (url.pathname === '/api/skills') {
    const project = url.searchParams.get('project') || settings.project
    const info = project ? await readProjectInfo(project).catch(() => undefined) : undefined
    const registry = await listSkills(info?.projectDir, settings.skills)
    // Invocation-NEUTRAL summaries: the caller applies the policy at its own
    // boundary (the UI is the human surface). Bodies are never sent here — they
    // are read fresh when a skill is actually used.
    return sendJson(res, 200, {
      skills: registry.skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        whenToUse: skill.whenToUse,
        rank: skill.rank,
        source: skill.source,
        path: skill.path,
        bytes: skill.bytes,
        invocation: skill.invocation,
      })),
      roots: registry.roots,
      problems: registry.problems,
      complete: registry.complete,
    })
  }

  if (url.pathname === '/api/chat') {
    const body = await readBody(req)
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
    if (!prompt) return sendJson(res, 400, { error: 'prompt is required' })
    const project = body.project || settings.project
    const ai = effectiveAi(settings)

    if (ai.mode === 'dsh') {
      const toolchain = await inspectToolchain(run).catch(() => undefined)
      const info = project ? await readProjectInfo(project).catch(() => undefined) : undefined
      const result = await runAgent(agentPrompt({ prompt, project, toolchain }), info?.projectDir ?? here, undefined)
      return sendJson(res, 200, result)
    }

    const context = await projectContext(project)
    // An explicitly chosen skill is injected as extra system instructions.
    let skillBlock = ''
    let skillName = ''
    if (typeof body.skill === 'string' && body.skill.trim()) {
      const info = project ? await readProjectInfo(project).catch(() => undefined) : undefined
      const registry = await listSkills(info?.projectDir, settings.skills)
      const wanted = body.skill.trim().toLowerCase()
      const summary = registry.skills.find((item) => item.name.toLowerCase() === wanted)
      if (!summary) return sendJson(res, 404, { error: `找不到技能: ${body.skill}` })
      // The operational boundary: a human-picked skill needs userInvocable, a
      // model-selected one needs modelInvocable (DSH's policy split).
      const surface = body.skillInvocation === 'model' ? 'model' : 'user'
      const allowed = surface === 'model' ? isModelInvocable(summary) : isUserInvocable(summary)
      if (!allowed) {
        return sendJson(res, 403, {
          error: `技能 ${summary.name} 不允许由${surface === 'model' ? '模型' : '用户'}调用`,
        })
      }
      // Load the body FRESH and revalidate the name against the stored candidate:
      // editing a skill takes effect on the next use, renaming it is reported.
      const loaded = await loadSkill(summary.name, { candidate: summary })
      if (loaded.error) return sendJson(res, loaded.code ?? 500, { error: loaded.error })
      skillName = loaded.skill.name
      skillBlock = renderSkillBlock(loaded.skill)
    }
    const messages = [
      { role: 'system', content: [C51_SYSTEM_PROMPT, skillBlock].filter(Boolean).join('\n\n') },
      { role: 'user', content: [context, prompt].filter(Boolean).join('\n\n') },
    ]
    // The UI asks for text/event-stream to render tokens as they arrive; plain
    // callers (no Accept header) get one JSON response instead.
    // Token metering: price the surface being sent, then anchor on the provider's
    // own usage numbers once they arrive (baseline 'usage' vs 'estimated').
    chatMeter.pricing = Array.isArray(ai.pricing) ? ai.pricing : DEFAULT_PRICING
    chatMeter.observeSurface(
      { model: ai.model, baseURL: ai.baseURL, temperature: ai.temperature, maxTokens: ai.maxTokens },
      messages,
    )
    // The UI asks for text/event-stream to render tokens as they arrive; plain
    // callers (no Accept header) get one JSON response instead.
    const wantsStream = String(req.headers.accept ?? '').includes('text/event-stream') && ai.stream
    if (wantsStream) {
      const usage = await streamChat(res, ai, messages)
      if (usage) chatMeter.observeUsage(usage)
      return
    }
    const result = await chatOnce(ai, messages)
    if (result.usage) chatMeter.observeUsage(result.usage)
    return sendJson(res, 200, { ...result, mode: 'openai', skill: skillName })
  }

  return sendJson(res, 404, { error: `unknown api route: ${url.pathname}` })
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`)
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url)
    if (url.pathname === '/' || url.pathname === '/index.html') return sendFile(res, join(PUBLIC_DIR, 'index.html'))
    if (url.pathname.startsWith('/vs/')) {
      const target = join(MONACO_DIR, url.pathname.slice('/vs/'.length))
      const safe = insideProject(MONACO_DIR, target)
      if (!safe) return sendJson(res, 403, { error: 'forbidden' })
      if (!(await statOrNull(safe))) return sendJson(res, 404, { error: 'not found' })
      return sendFile(res, safe)
    }
    const safe = insideProject(PUBLIC_DIR, join(PUBLIC_DIR, url.pathname))
    if (!safe || !(await statOrNull(safe))) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('not found')
    }
    return sendFile(res, safe)
  } catch (error) {
    return sendJson(res, 500, { error: error.message })
  }
})

server.on('error', async (error) => {
  if (error.code !== 'EADDRINUSE') throw error
  // Two copies used to fight over the port and the second one died with a raw
  // "Uncaught Exception: listen EADDRINUSE" dialog. The desktop shell now takes a
  // single-instance lock, and this is the human-readable fallback.
  const message = [
    `端口 ${PORT} 已被占用，可能是已经有一个 Fixpoint 在运行。`,
    '',
    '请先关掉那一个；或者设一个别的端口再启动（环境变量 KEIL_IDE_PORT）。',
  ].join('\n')
  process.stderr.write(`Fixpoint: ${message.replace(/\n+/g, ' ')}\n`)
  try {
    const { dialog } = await import('electron')
    dialog.showErrorBox('Fixpoint 无法启动', message)
  } catch {
    // Plain-node mode: the stderr line above is the whole message.
  }
  process.exit(1)
})

server.listen(PORT, HOST, () => {
  process.stdout.write(`Fixpoint v0.1 (Powered by wangcangxing)  http://${HOST}:${PORT}/  (pid ${process.pid})\n`)
})
