/* keil-ide v0.1 renderer.
 *
 * Deliberately plain JS + Monaco via the AMD loader: no bundler, no framework, so
 * the whole UI is one readable file that the Node host serves directly.
 *
 * Everything Keil-specific happens on the host (../keil-core.mjs); this file only
 * renders state and composes AI prompts.
 */
'use strict'

const state = {
  settings: { project: '', recent: [] },
  info: null, // readProjectInfo() result: projectDir, device, declaredSources, hexPath…
  sources: null, // { declared, onDisk, orphans, headers }
  hex: null, // { exists, path, bytes, mtime, enabled }
  lastBuild: null, // last /api/build response
  current: null, // { name, path, text }
  lastReply: '', // last AI text, used by the apply button
  symbols: null, // C51 symbol index from /api/symbols
  tree: null, // µVision-like project tree from /api/project
  readRoots: [], // directories a READ may reach (project + include roots)
  dirty: false, // the editor buffer differs from what is already on disk
  editor: null,
  monaco: null,
}

/** External-change tracking (another editor, or git, writing into the project). */
const syncState = { timer: 0, fileMtime: 0, sources: new Map(), busy: false, conflict: false, noticeUntil: 0 }

/* ---------- tiny helpers ---------- */

const $ = (id) => document.getElementById(id)

/** Fetch JSON with a friendly error. */
async function api(path, options) {
  const response = await fetch(path, options)
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${path} 返回了非 JSON 内容: ${text.slice(0, 200)}`)
  }
}

/** POST a JSON body. */
function post(path, body) {
  return api(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
}

/** Absolute path of a project-relative file name. */
function absPath(name) {
  if (!state.info) return name
  const dir = state.info.projectDir.replace(/[\\/]+$/, '')
  return `${dir}\\${name}`
}

/** File name (basename) of an absolute path. */
function baseName(path) {
  return String(path).split(/[\\/]/).pop()
}

/** Human-friendly bytes. */
function formatBytes(bytes) {
  if (!bytes) return '0 B'
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
}

/** Local time from an ISO string. */
function formatTime(iso) {
  if (!iso) return '—'
  const date = new Date(iso)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/* ---------- wording helpers: the UI deliberately avoids compiler jargon ---------- */

/**
 * What "written without a byte-order mark" means for the user, in their words.
 * The flag itself stays technical on the wire; only the sentence is plain.
 */
function encodingNote(form) {
  return form ? '文件格式检查通过' : '⚠ 文件开头有多余标记，编译器可能报一堆看不懂的错'
}

/** Where the previous version went (or why there is none). */
function backupNote(data) {
  if (data.backup) return `\n旧版本已备份到: ${data.backup}`
  if (data.backupEnabled === false) return '\n（这次没备份：备份开关是关的）'
  return ''
}

/** How the compiler was located, in plain words. */
function toolchainSourceNote(source) {
  const map = {
    registry: '自动找到',
    env: '按环境变量找到',
    settings: '按设置找到',
    fallback: '按常见安装位置找到',
  }
  return map[String(source ?? '').toLowerCase()] ?? (source ? `来源: ${source}` : '来源未知')
}

/** The multiline policy, in plain words. */
function multilineNote(mode) {
  if (mode === 'off') return '只补一行'
  if (mode === 'on') return '允许多行'
  return '自动判断要不要多行'
}

/* ---------- rendering: toolbar, tree, problems, transcript ---------- */

function renderChips() {
  const hex = state.hex
  const chip = $('hex-chip')
  if (!hex || !hex.path) {
    chip.textContent = 'hex: —'
    chip.className = 'chip'
  } else if (hex.exists) {
    chip.textContent = `hex: ${baseName(hex.path)} ✔ ${formatTime(hex.mtime)} ${formatBytes(hex.bytes)}`
    chip.className = 'chip ok'
    chip.title = hex.path
  } else {
    chip.textContent = hex.enabled ? 'hex: 尚未生成' : 'hex: 工程未启用 CreateHexFile'
    chip.className = 'chip bad'
    chip.title = hex.path
  }
  $('device-chip').textContent = state.info ? `${state.info.device || '?'} · ${state.info.targetName || '?'}` : '—'
}

/** Render the µVision-like project tree: Project > Target > Group > File > headers. */
function renderTree() {
  const host = $('tree')
  host.textContent = ''
  // The tree itself carries the orphan group now, so the flat warning is redundant.
  $('orphan-note').classList.add('hidden')
  if (!state.tree) return
  host.appendChild(renderTreeNode(state.tree, 0))
}

function renderTreeNode(node, depth) {
  const children = node.children ?? []
  const li = document.createElement('li')
  li.className = `node kind-${node.kind}`
  const row = document.createElement('div')
  row.className = 'node-row'
  row.style.paddingLeft = `${depth * 14 + 4}px`

  const twisty = document.createElement('span')
  twisty.className = 'twisty'
  twisty.textContent = children.length ? (node.collapsed ? '▸' : '▾') : '·'
  row.appendChild(twisty)

  const label = document.createElement('span')
  label.className = 'node-label'
  label.textContent = node.label
  if (node.kind === 'header' && node.resolved === false) {
    label.classList.add('unresolved')
    label.title = '未找到该头文件'
  }
  if (node.missing) {
    label.classList.add('missing')
    label.title = '文件不存在'
  } else if (node.path) {
    label.title = node.path
  }
  row.appendChild(label)

  if (node.kind === 'orphan') {
    const tag = document.createElement('span')
    tag.className = 'tag'
    tag.textContent = '未加入构建'
    row.appendChild(tag)
  }
  if (state.current?.path && node.path && state.current.path.toLowerCase() === node.path.toLowerCase()) {
    li.classList.add('active')
  }
  li.appendChild(row)

  if (children.length) {
    const list = document.createElement('ul')
    list.className = 'children'
    for (const child of children) list.appendChild(renderTreeNode(child, depth + 1))
    if (node.collapsed) list.classList.add('hidden')
    li.appendChild(list)
    twisty.onclick = (event) => {
      event.stopPropagation()
      node.collapsed = !node.collapsed
      renderTree()
    }
  }

  if (node.kind === 'file' || node.kind === 'header' || node.kind === 'orphan') {
    row.onclick = () => {
      if (node.path) openFileByPath(node.path)
      else appendMessage('ai', '打开文件', `${node.label} 没有解析到路径（头文件未找到）`)
    }
  }
  return li
}

function renderProblems() {
  const list = $('problems')
  list.textContent = ''
  const build = state.lastBuild
  if (!build || !build.value) {
    $('problem-count').textContent = ''
    return
  }
  const value = build.value
  const items = [...value.errors, ...value.warnings]
  $('problem-count').textContent = `${value.errors.length} 错误 / ${value.warnings.length} 警告 · ERRORLEVEL ${value.exitCode} · ${value.status}`
  for (const item of items) {
    const li = document.createElement('li')
    li.className = item.severity === 'warning' ? 'warning' : 'error'
    const loc = document.createElement('span')
    loc.className = 'loc'
    loc.textContent = item.file ? `${item.file}(${item.line})` : '(链接)'
    const msg = document.createElement('span')
    msg.textContent = `${item.severity} ${item.code}: ${item.message}`
    li.append(loc, msg)
    li.onclick = async () => {
      if (!item.file) return
      await openFile(item.file)
      if (state.editor && item.line) {
        state.editor.revealLineInCenter(item.line)
        state.editor.setPosition({ lineNumber: item.line, column: 1 })
        state.editor.focus()
      }
    }
    list.appendChild(li)
  }
}

/* ---------- tiny Markdown renderer (no dependency, DOM-built so nothing is injected) ---------- */

/** Inline markdown → nodes appended to `host`. Text is set via textContent only. */
function renderInline(host, text) {
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(\[[^\]]+\]\([^)]+\))|(https?:\/\/[^\s)]+)/g
  let last = 0
  for (const match of String(text).matchAll(pattern)) {
    if (match.index > last) host.appendChild(document.createTextNode(text.slice(last, match.index)))
    const token = match[0]
    if (token.startsWith('`')) {
      const code = document.createElement('code')
      code.textContent = token.slice(1, -1)
      host.appendChild(code)
    } else if (token.startsWith('**')) {
      const strong = document.createElement('strong')
      strong.textContent = token.slice(2, -2)
      host.appendChild(strong)
    } else if (token.startsWith('*')) {
      const em = document.createElement('em')
      em.textContent = token.slice(1, -1)
      host.appendChild(em)
    } else {
      const link = document.createElement('a')
      const labelled = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
      link.textContent = labelled ? labelled[1] : token
      link.href = labelled ? labelled[2] : token
      link.target = '_blank'
      link.rel = 'noreferrer'
      host.appendChild(link)
    }
    last = match.index + token.length
  }
  if (last < String(text).length) host.appendChild(document.createTextNode(text.slice(last)))
}

const MD_BULLET = /^(\s*)[-*+]\s+(.*)$/
const MD_ORDERED = /^(\s*)\d+[.)]\s+(.*)$/

/**
 * Markdown text → DocumentFragment (headings, lists, quotes, fenced code, inline
 * styles). Written by hand because the answers MUST read as formatted text: the
 * transcript used to show the raw `##` / `**` / ``` markers.
 */
function renderMarkdown(text) {
  const fragment = document.createDocumentFragment()
  // Normalise line endings FIRST. `.` does not match `\r` in JavaScript (it is a
  // line terminator), so every `…(.*)$` pattern silently failed on CRLF lines —
  // which meant headings/lists/fences were never recognised, and a CRLF fence line
  // was claimed by no branch at all (that mismatch is what made the loop spin).
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  let index = 0
  while (index < lines.length) {
    const line = lines[index]

    // Accept ANY info string ("```c", "```c extra", "```"): the paragraph loop below
    // only checks `/^\s*```/`, so a stricter test here left lines claimed by nobody.
    const fence = /^\s*```(.*)$/.exec(line)
    if (fence) {
      const language = (fence[1] || 'c51').trim().split(/\s+/)[0] || 'c51'
      const body = []
      index += 1
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        body.push(lines[index])
        index += 1
      }
      index += 1
      const pre = document.createElement('pre')
      const code = document.createElement('code')
      code.textContent = body.join('\n')
      pre.appendChild(code)
      fragment.appendChild(pre)
      // Colour it with the editor's own tokenizer when available (best effort).
      if (state.monaco?.editor?.colorize) {
        state.monaco.editor
          .colorize(code.textContent, language, { tabSize: 4 })
          .then((html) => {
            pre.innerHTML = html
          })
          .catch(() => {})
      }
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      // Kept small on purpose: these live inside a chat bubble, not a document.
      const node = document.createElement(`h${Math.min(6, heading[1].length + 2)}`)
      renderInline(node, heading[2].trim())
      fragment.appendChild(node)
      index += 1
      continue
    }

    if (/^\s*>\s?/.test(line)) {
      const quote = document.createElement('blockquote')
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        renderInline(quote, lines[index].replace(/^\s*>\s?/, ''))
        quote.appendChild(document.createElement('br'))
        index += 1
      }
      fragment.appendChild(quote)
      continue
    }

    if (MD_BULLET.test(line) || MD_ORDERED.test(line)) {
      const ordered = MD_ORDERED.test(line) && !MD_BULLET.test(line)
      const matcher = ordered ? MD_ORDERED : MD_BULLET
      const list = document.createElement(ordered ? 'ol' : 'ul')
      while (index < lines.length && matcher.test(lines[index])) {
        const [, indent, content] = matcher.exec(lines[index])
        const item = document.createElement('li')
        // Keep the nesting the model wrote, without a full list parser.
        item.style.marginLeft = `${Math.min(3, Math.floor(indent.length / 2)) * 14}px`
        renderInline(item, content)
        list.appendChild(item)
        index += 1
      }
      fragment.appendChild(list)
      continue
    }

    if (!line.trim()) {
      index += 1
      continue
    }

    const paragraph = document.createElement('p')
    // IMPORTANT: these predicates must match the branch guards above EXACTLY. When
    // they disagreed, a line was claimed by neither side: the paragraph loop refused
    // to consume it, `index` never advanced, and the outer loop spun forever,
    // appending an empty <p> every turn until the renderer ran out of memory and the
    // page froze. `verify/md-unit.mjs` (child process + watchdog) is what caught it.
    const isBlockStart = (value) =>
      /^\s*```/.test(value) ||
      /^#{1,6}\s+/.test(value) ||
      /^\s*>\s?/.test(value) ||
      MD_BULLET.test(value) ||
      MD_ORDERED.test(value)
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index])) {
      if (paragraph.childNodes.length) paragraph.appendChild(document.createElement('br'))
      renderInline(paragraph, lines[index])
      index += 1
    }
    if (!paragraph.childNodes.length) {
      // Belt and braces: the outer loop must always make progress.
      index += 1
      continue
    }
    fragment.appendChild(paragraph)
  }
  return fragment
}

/** The "provider cut the answer" notice, shared by the streaming and plain paths. */
function truncationNote() {
  const note = document.createElement('div')
  note.className = 'md-note'
  note.textContent = `⚠ 回答到长度上限被截断了（本次最多 ${state.ai?.maxTokens ?? 4096} 个词元；可在"设置 → AI 后端"里调大"聊天最多生成"）`
  return note
}

function appendMessage(kind, title, text) {
  const box = document.createElement('div')
  box.className = `msg ${kind}`
  const meta = document.createElement('div')
  meta.className = 'meta'
  meta.textContent = title
  const body = document.createElement('div')
  // Only the AI's answers are markdown; everything else stays literal text.
  const markdown = kind === 'ai'
  if (markdown) {
    body.className = 'md'
    body.appendChild(renderMarkdown(text))
  } else {
    body.textContent = text
  }
  box.append(meta, body)
  box.bodyEl = body // streaming keeps re-rendering here
  box.setBody = (value) => {
    body.textContent = ''
    if (markdown) body.appendChild(renderMarkdown(value))
    else body.textContent = value
  }
  $('transcript').appendChild(box)
  $('transcript').scrollTop = $('transcript').scrollHeight
  return box
}

/** Show which AI backend the panel will use. */
function renderAiChip(ai) {
  const chip = $('ai-chip')
  if (!ai) {
    chip.textContent = '—'
    return
  }
  chip.textContent =
    ai.mode === 'openai'
      ? `${ai.model || '(未设模型)'} @ ${ai.baseURL}${ai.apiKeySet ? ' 🔑' : ' (无密钥)'}`
      : '本机 DSH headless'
  chip.title = ai.mode === 'openai' ? 'OpenAI 兼容接口' : 'dsh --profile headless（一次性）'
}

/* ---------- project + file operations ---------- */

async function loadProject(project, { keepFile = false } = {}) {
  const target = project || state.settings.project
  if (!target) return
  const data = await api(`/api/project?project=${encodeURIComponent(target)}`)
  if (data.error) {
    appendMessage('err', '工程', data.error)
    return
  }
  state.settings.project = target
  state.info = data.info
  state.sources = data.sources
  state.hex = data.hex
  state.tree = data.tree
  state.readRoots = data.readRoots ?? []
  // The symbol index is best-effort: if it fails, word-based completion still works.
  state.symbols = await api(`/api/symbols?project=${encodeURIComponent(target)}`).catch(() => null)
  renderChips()
  renderSymbolChip()
  renderTree()
  await loadSkills()
  const firstSource =
    data.sources.declared.find((n) => /\.c$/i.test(n)) || data.sources.declared[0] || data.sources.onDisk[0]
  // `keepFile` is for refreshes triggered by an external change: reopening the
  // first source would yank the file the user is actually editing.
  if (firstSource && !keepFile) await openFile(firstSource)
}

/** Open one absolute path (a project source, or a header under an include root). */
async function openFileByPath(path) {
  const data = await api(
    `/api/file?project=${encodeURIComponent(state.settings.project)}&path=${encodeURIComponent(path)}`,
  )
  if (data.error) {
    appendMessage('err', '打开文件', `${path}\n${data.error}`)
    return undefined
  }
  state.current = { name: baseName(data.path), path: data.path, text: data.text }
  closeDiff()
  state.dirty = false
  syncState.fileMtime = data.mtimeMs ?? 0
  syncState.conflict = false
  if (state.editor) {
    const model = state.editor.getModel()
    state.monaco.editor.setModelLanguage(model, 'c51')
    model.setValue(data.text)
    state.editor.setPosition({ lineNumber: 1, column: 1 })
  }
  renderTree()
  renderFileChip()
  return data
}

/** Open a project-relative file name. */
function openFile(name) {
  return openFileByPath(absPath(name))
}

async function saveCurrent() {
  if (!state.current || !state.editor) return
  const text = state.editor.getValue()
  const data = await post('/api/file', {
    project: state.settings.project,
    path: state.current.path,
    text,
  })
  if (data.error) {
    appendMessage('err', '保存失败', data.error)
    return
  }
  state.current.text = text
  state.dirty = false
  if (data.mtimeMs) syncState.fileMtime = data.mtimeMs
  renderFileChip()
  appendMessage(
    'ai',
    `已保存 ${baseName(data.path)}`,
    `${data.bytes} 字节 · ${encodingNote(data.bomFree)}${backupNote(data)}`,
  )
}

async function build(mode) {
  const button = $('btn-build')
  button.disabled = true
  button.textContent = '编译中…'
  try {
    const data = await post('/api/build', { project: state.settings.project, mode })
    state.lastBuild = data
    if (data.error) {
      appendMessage('err', '编译失败', data.error)
    } else {
      state.hex = data.hex || state.hex
      renderChips()
      renderProblems()
      const value = data.value
      appendMessage(
        value.errorCount ? 'err' : 'ai',
        `编译 ${value.mode} → ${value.status} (ERRORLEVEL ${value.exitCode})`,
        [
          value.programSize,
          value.summary,
          value.translated.length ? `translated: ${value.translated.join(', ')}` : '',
          `${value.errorCount} 错误 / ${value.warningCount} 警告`,
        ]
          .filter(Boolean)
          .join('\n'),
      )
    }
  } catch (error) {
    appendMessage('err', '编译异常', error.message)
  } finally {
    button.disabled = false
    button.innerHTML = '编译 <kbd>F7</kbd>'
  }
}

/* ---------- AI panel ---------- */

/** What is attached to the outgoing request — as ONE short line for the transcript. */
function describeAttachments() {
  const bits = []
  if ($('ctx-file').checked && state.current) bits.push(`当前文件 ${state.current.name}`)
  if ($('ctx-errors').checked && state.lastBuild?.value) {
    const items = [...(state.lastBuild.value.errors ?? []), ...(state.lastBuild.value.warnings ?? [])]
    if (items.length) bits.push(`编译信息 ${items.length} 条`)
  }
  return bits.length ? `（已附带：${bits.join(' · ')}）` : ''
}

function buildPrompt(userText) {
  const parts = []
  if ($('ctx-file').checked && state.current) {
    parts.push(`当前文件: ${state.current.path}\n\`\`\`c\n${state.editor ? state.editor.getValue() : state.current.text}\n\`\`\``)
  }
  if ($('ctx-errors').checked && state.lastBuild?.value) {
    const value = state.lastBuild.value
    const items = [...value.errors, ...value.warnings]
    if (items.length) {
      parts.push(
        `最近一次编译 (${value.status}, ERRORLEVEL ${value.exitCode}):\n` +
          items.map((i) => `${i.file || '(link)'}(${i.line ?? '-'}): ${i.severity} ${i.code}: ${i.message}`).join('\n'),
      )
    }
  }
  parts.push((userText ?? $('prompt').value).trim())
  return parts.filter(Boolean).join('\n\n')
}

const SKILL_SOURCE_LABEL = {
  'project-ide': '工程',
  'project-dsh': '工程·DSH',
  'project-agents': '工程·agents',
  custom: '自定义',
  'user-ide': '用户',
  'user-dsh': '用户·DSH',
  bundled: '内置',
}

/**
 * Load the skill catalog for the current project.
 *
 * Two DSH rules are honoured here: this picker is the HUMAN surface, so only
 * `userInvocable` skills are listed (a model-only skill stays out of the menu);
 * and an incomplete discovery (`complete: false`) must NOT blank the picker —
 * the last good catalog is kept instead.
 */
async function loadSkills() {
  const select = $('skill')
  const previous = select.value
  const data = await api(`/api/skills?project=${encodeURIComponent(state.settings.project ?? '')}`).catch(() => null)
  if (!data || (data.complete === false && select.options.length > 1)) {
    select.title = '技能目录暂时不完整，已保留上一次的结果'
    return
  }
  select.textContent = ''
  const none = document.createElement('option')
  none.value = ''
  none.textContent = '（不用技能）'
  select.appendChild(none)
  for (const skill of data.skills ?? []) {
    if (!skill.invocation?.userInvocable) continue
    const option = document.createElement('option')
    option.value = skill.name
    const where = SKILL_SOURCE_LABEL[skill.source] ?? skill.source
    const modelOnly = skill.invocation?.modelInvocable === false ? '·仅用户' : ''
    option.textContent = `${skill.name}（${where}${modelOnly}）`
    option.title = [skill.description, skill.whenToUse ? `适用场景: ${skill.whenToUse}` : '', skill.path ?? '']
      .filter(Boolean)
      .join('\n')
    select.appendChild(option)
  }
  if (previous && [...select.options].some((option) => option.value === previous)) select.value = previous
  select.title = [
    ...(data.roots ?? []).map((root) => `${root.rank}  ${root.source}  ${root.dir}`),
    ...(data.problems ?? []),
  ].join('\n')
  renderSkillHint()
}

/** Show the selected skill's description next to the picker. */
function renderSkillHint() {
  const select = $('skill')
  const option = select.selectedOptions?.[0]
  const hint = $('skill-hint')
  if (!hint) return
  hint.textContent = select.value ? option?.title ?? '' : ''
  hint.title = hint.textContent
}

async function send() {
  // `/skill-name rest…` picks a skill for this one message (Continue-style slash
  // command); otherwise the picker decides.
  const typed = $('prompt').value.trim()
  let skill = $('skill').value
  let userText = typed
  const slash = /^\/([^\s/]+)\s*([\s\S]*)$/.exec(typed)
  if (slash) {
    const wanted = slash[1].toLowerCase()
    const option = [...$('skill').options].find((item) => item.value.toLowerCase() === wanted)
    if (option) {
      skill = option.value
      userText = slash[2].trim()
    }
  }
  const prompt = buildPrompt(userText)
  if (!prompt) return
  const skillTag = skill ? `（技能: ${skill}）` : ''
  // Show the user's OWN words (plus a one-line note about what was attached).
  // Pasting the whole attached file into the transcript was the complaint:
  // "不要将…写入对话框，直接输出用户原话即可".
  const attachmentNote = describeAttachments()
  appendMessage('user', `我${skillTag}`, attachmentNote ? `${userText}\n${attachmentNote}` : userText)
  $('prompt').value = ''
  const button = $('btn-send')
  button.disabled = true
  button.textContent = '思考中…'
  const ai = state.ai ?? {}
  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ prompt, project: state.settings.project, skill }),
    })
    const type = response.headers.get('content-type') ?? ''

    // Streaming path (OpenAI-compatible backend): render tokens as they arrive.
    if (type.includes('text/event-stream')) {
      const box = appendMessage('ai', `AI（流式 · ${ai.model || 'openai'}${skillTag}）`, '')
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let full = ''
      let lastRender = 0
      let finishReason = ''
      const handlePayload = (payload) => {
        if (payload.error) {
          box.className = 'msg err'
          box.setBody(`调用失败: ${payload.error}`)
        }
        if (payload.delta) {
          full += payload.delta
          // Re-render markdown as it grows, but not on every single token.
          const now = Date.now()
          if (now - lastRender > 120) {
            lastRender = now
            box.setBody(full)
            $('transcript').scrollTop = $('transcript').scrollHeight
          }
        }
        if (payload.done) {
          if (payload.text) full = payload.text
          if (payload.finishReason) finishReason = String(payload.finishReason)
        }
      }
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let index
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          const line = frame.split('\n').find((part) => part.startsWith('data:'))
          if (!line) continue
          try {
            handlePayload(JSON.parse(line.slice(5).trim()))
          } catch {
            continue
          }
        }
      }
      // Flush the tail: the last frame may arrive WITHOUT its blank-line terminator
      // (and the decoder may still hold a partial multi-byte character). Dropping it
      // is one of the two ways a reply came out truncated.
      buffer += decoder.decode()
      for (const part of buffer.split('\n')) {
        const line = part.trim()
        if (!line.startsWith('data:')) continue
        try {
          handlePayload(JSON.parse(line.slice(5).trim()))
        } catch {
          // ignore a partial frame at EOF
        }
      }
      buffer = ''
      state.lastReply = full
      box.setBody(full || '(空回复)')
      // Say it out loud when the provider cut the answer at the token cap: a short
      // reply with no explanation is the second half of "回复被截断".
      if (finishReason === 'length') box.bodyEl.appendChild(truncationNote())
      $('transcript').scrollTop = $('transcript').scrollHeight
      $('btn-apply').disabled = !extractCodeBlock(full)
      // Auto-open the side-by-side diff: current file vs the AI's block.
      maybeAutoDiff(full)
      return
    }

    const data = await response.json()
    state.lastReply = data.text || ''
    if (data.ok) {
      const box = appendMessage('ai', `AI · ${data.model || ai.model || ''}`, state.lastReply || '(空回复)')
      if (data.finishReason === 'length') box.bodyEl.appendChild(truncationNote())
    } else {
      appendMessage('err', 'AI 调用失败', `${data.error || '(无错误信息)'}${data.url ? `\nurl: ${data.url}` : ''}`)
    }
    $('btn-apply').disabled = !extractCodeBlock(state.lastReply)
    maybeAutoDiff(state.lastReply)
  } catch (error) {
    appendMessage('err', 'AI 调用异常', error.message)
  } finally {
    button.disabled = false
    button.textContent = '发送'
  }
}

/** Pull the first fenced code block (and an optional `FILE:` line) out of a reply. */
function extractCodeBlock(text) {
  if (!text) return null
  const match = /```(?:c|c51|cpp)?\s*\n([\s\S]*?)```/.exec(text)
  if (!match) return null
  const before = text.slice(0, match.index)
  const fileMatch = /FILE:\s*(.+)\s*$/m.exec(before)
  return { code: match[1], file: fileMatch ? fileMatch[1].trim() : '' }
}

async function applyReply() {
  const block = extractCodeBlock(state.lastReply)
  if (!block) return
  const target = block.file || state.current?.path
  if (!target) {
    appendMessage('err', '应用失败', '回复里没有 FILE: 行，且当前没有打开文件')
    return
  }
  if (!confirm(`用 AI 的代码块覆盖这个文件？\n\n${target}\n\n（覆盖前的旧内容会自动备份；备份文件夹可在"设置 → 文件"里指定）`)) return
  const data = await post('/api/file', { project: state.settings.project, path: target, text: block.code })
  if (data.error) {
    appendMessage('err', '应用失败', data.error)
    return
  }
  appendMessage('ai', `已写入 ${baseName(data.path)}`, `${data.bytes} 字节 · ${encodingNote(data.bomFree)}${backupNote(data)}`)
  await openFile(baseName(data.path))
}

/* ---------- AI diff: 当前文件 ↔ 回复里的代码块（并排、增绿删红） ---------- */

/**
 * Monaco's DiffEditor gives exactly the requested presentation: left = what is on
 * disk/buffer now, right = the AI's proposal, added lines green and removed lines
 * red. It is built once and reused; the models are kept so a new reply only fills
 * text instead of rebuilding the editor.
 */
function ensureDiffEditor() {
  if (state.diffEditor) return state.diffEditor
  state.diffModels = {
    original: monaco.editor.createModel('', 'c51'),
    modified: monaco.editor.createModel('', 'c51'),
  }
  state.diffEditor = monaco.editor.createDiffEditor($('diff-editor'), {
    theme: 'vs-dark',
    automaticLayout: true,
    readOnly: true,
    originalEditable: false,
    renderSideBySide: true,
    // Monaco silently falls back to an inline (one-column) view when the editor is
    // narrower than ~900px — measured: the editor pane here is ~840px, so without
    // this the "split" the user asked for would look like a single column.
    useInlineViewWhenSpaceIsLimited: false,
    scrollBeyondLastLine: false,
    fontSize: 13,
    minimap: { enabled: false },
    renderOverviewRuler: false,
    // Each pane is half of a ~840px editor, so long C lines must wrap.
    wordWrap: 'on',
    diffWordWrap: 'on',
  })
  state.diffEditor.setModel(state.diffModels)
  return state.diffEditor
}

/** +added / −removed line counts (LCS); null above ~4M cell pairs to stay snappy. */
function lineDiffStats(before, after) {
  const a = String(before).split('\n')
  const b = String(after).split('\n')
  if (a.length * b.length > 4000000) return { added: null, removed: null }
  const width = b.length + 1
  let previous = new Uint32Array(width)
  let current = new Uint32Array(width)
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j < width; j += 1) {
      current[j] = a[i - 1] === b[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1])
    }
    const swap = previous
    previous = current
    current = swap
    current.fill(0)
  }
  const common = previous[width - 1]
  return { added: b.length - common, removed: a.length - common }
}

/** Show the diff for `original` -> `modified` against `target`. */
function showDiff(original, modified, target) {
  ensureDiffEditor()
  state.diffModels.original.setValue(original)
  state.diffModels.modified.setValue(modified)
  state.diffTarget = target
  state.diffModified = modified
  const stats = lineDiffStats(original, modified)
  $('diff-title').textContent = `${baseName(target)} · 当前 ↔ AI 建议`
  $('diff-stats').innerHTML =
    stats.added === null
      ? ''
      : `<span class="add">+${stats.added}</span> <span class="del">−${stats.removed}</span>`
  $('diff-view').classList.remove('hidden')
  // The layer was display:none while hidden, so Monaco must re-measure now.
  state.diffEditor.layout()
}

function closeDiff() {
  const view = $('diff-view')
  if (!view || view.classList.contains('hidden')) return
  view.classList.add('hidden')
  state.diffTarget = ''
  state.diffModified = ''
}

/** Which open file does a reply's `FILE:` line refer to? Empty when it is another file. */
function currentFileMatch(file) {
  if (!state.current) return ''
  const target = String(file ?? '').trim()
  if (!target) return state.current.path
  return baseName(target).toLowerCase() === state.current.name.toLowerCase() ? state.current.path : ''
}

/**
 * Open the diff automatically when a reply carries a code block for the file the
 * user is looking at. A reply about a different file keeps the old explicit
 * "write it" button, so nothing is silently switched under the user.
 */
function maybeAutoDiff(text = state.lastReply) {
  const block = extractCodeBlock(text)
  if (!block || !state.current || !state.editor) return false
  const target = currentFileMatch(block.file)
  if (!target) return false
  const original = state.editor.getValue()
  if (original === block.code) return false
  showDiff(original, block.code, target)
  return true
}

/** Write the AI side of the diff (the same backup path as a manual save). */
async function applyDiff() {
  const target = state.diffTarget
  if (!target) return
  const data = await post('/api/file', { project: state.settings.project, path: target, text: state.diffModified })
  if (data.error) {
    appendMessage('err', '应用失败', data.error)
    return
  }
  closeDiff()
  appendMessage('ai', `已写入 ${baseName(data.path)}`, `${data.bytes} 字节 · ${encodingNote(data.bomFree)}${backupNote(data)}`)
  await openFile(baseName(data.path))
}

/** Resolve a reply's `FILE:` value to an absolute path (project-relative or absolute). */
function resolveReplyPath(file) {
  const value = String(file ?? '').trim()
  if (!value) return state.current?.path ?? ''
  if (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\')) return value
  return absPath(value)
}

/**
 * The chat button: show a diff before writing. The open file uses the live buffer
 * (unsaved edits included); another file is read from disk and stays unopened.
 * Only when the target cannot be read (e.g. a brand-new file) does it fall back to
 * the old confirm-and-write flow.
 */
async function previewOrApply() {
  if (maybeAutoDiff()) return
  const block = extractCodeBlock(state.lastReply)
  if (!block) return
  const target = resolveReplyPath(block.file || state.current?.path)
  if (!target) {
    appendMessage('err', '应用失败', '回复里没有 FILE: 行，且当前没有打开文件')
    return
  }
  const query = `/api/file?project=${encodeURIComponent(state.settings.project)}&path=${encodeURIComponent(target)}`
  const data = await api(query).catch(() => null)
  if (!data || data.error) {
    await applyReply()
    return
  }
  if (data.text === block.code) {
    appendMessage('ai', '无需修改', 'AI 给的代码和这个文件一致')
    return
  }
  showDiff(data.text, block.code, data.path)
}

/* ---------- Settings dialog: AI / 补全 / 编辑器 / 技能 / 诊断 ---------- */

/** Switch the visible settings tab (the choice sticks while the app runs). */
function showSettingsTab(name) {
  for (const button of document.querySelectorAll('.settings-tabs .tab')) {
    button.classList.toggle('active', button.dataset.tab === name)
  }
  for (const pane of document.querySelectorAll('.settings-panes .pane-tab')) {
    pane.classList.toggle('active', pane.dataset.pane === name)
  }
  state.settingsTab = name
}

/** Editor preferences apply immediately (and persist on save). */
function applyEditorSettings() {
  const editor = state.settings?.editor ?? {}
  if (!state.editor) return
  state.editor.updateOptions({
    fontSize: Number(editor.fontSize) || 13,
    wordWrap: editor.wordWrap === 'on' ? 'on' : 'off',
    minimap: { enabled: editor.minimap === true },
    tabSize: Number(editor.tabSize) || 4,
  })
}

/** Skills tab: which roots were scanned, what went wrong, and what is installed. */
async function refreshSkillsAdmin() {
  const data = await api(`/api/skills?project=${encodeURIComponent(state.settings.project ?? '')}`).catch(() => null)
  const roots = data?.roots ?? []
  state.skillRoots = roots
  $('skills-roots').textContent = [
    `完整: ${data?.complete ? '是' : '否（有读取错误，界面保留上一次目录）'}`,
    ...roots.map((root) => `优先级 ${String(root.rank).padStart(3)} · ${SKILL_SOURCE_LABEL[root.source] ?? root.source} · ${root.dir}`),
    ...(data?.problems ?? []).map((line) => `⚠ ${line}`),
  ].join('\n')

  // Only skills living in THIS IDE's own tables can be uninstalled.
  const ownSources = ['project-ide', 'user-ide', 'custom']
  const installed = (data?.skills ?? []).filter((skill) => ownSources.includes(skill.source))
  const list = $('skills-installed')
  list.textContent = ''
  if (!installed.length) {
    const empty = document.createElement('div')
    empty.className = 'dim'
    empty.textContent = '还没有单独安装的技能（内置技能随 IDE 提供，不可卸载）'
    list.appendChild(empty)
    return
  }
  for (const skill of installed) {
    const row = document.createElement('div')
    row.className = 'row'
    const label = document.createElement('span')
    label.textContent = `${skill.name}（${SKILL_SOURCE_LABEL[skill.source] ?? skill.source}${skill.bytes ? ` · ${skill.bytes} B` : ''}）`
    row.appendChild(label)
    const spacer = document.createElement('span')
    spacer.className = 'spacer'
    row.appendChild(spacer)
    const button = document.createElement('button')
    button.textContent = '卸载'
    button.onclick = () => uninstallSkillByName(skill.name)
    row.appendChild(button)
    list.appendChild(row)
  }
}

/** Install one skill (absolute path: .md file, directory bundle, or .zip). */
async function installSkillFromForm() {
  const source = $('skills-source').value.trim()
  if (!source) {
    $('settings-status').textContent = '请填写技能来源（.md 文件、含 SKILL.md 的目录，或 .zip）'
    return
  }
  const result = await post('/api/skills/install', {
    source,
    scope: $('skills-scope').value,
    force: $('skills-force').checked,
    project: state.settings.project,
  }).catch((error) => ({ ok: false, error: error.message }))
  $('settings-status').textContent = result.ok
    ? `已安装 ${result.name}（${result.form === 'bundle' ? '目录包' : '单文件'}，${result.files} 个文件，${result.bytes} 字节）`
    : `安装失败: ${result.error}`
  if (result.ok) $('skills-source').value = ''
  await loadSkills()
  await refreshSkillsAdmin()
}

/** Remove an installed skill from this IDE's own table. */
async function uninstallSkillByName(name) {
  const result = await post('/api/skills/uninstall', { name, project: state.settings.project }).catch((error) => ({
    ok: false,
    error: error.message,
  }))
  $('settings-status').textContent = result.ok ? `已卸载 ${name}` : `卸载失败: ${result.error}`
  await loadSkills()
  await refreshSkillsAdmin()
}

/** Token chip (DSH "Token 计量"): surface price per fold + the signed delta. */
async function refreshTokens() {
  const data = await api('/api/tokens').catch(() => null)
  const chip = $('token-chip')
  if (!chip) return
  if (!data) {
    chip.textContent = 'tokens: —'
    return
  }
  const format = (value) => (value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value ?? 0))
  const chat = data.chat ?? {}
  const inline = data.complete ?? {}
  const delta = chat.surfaceDeltaTokens ?? 0
  chip.textContent = `用量: 对话 ${format(chat.surfaceTokens)} · 补全 ${format(inline.surfaceTokens)}`
  chip.className = `chip ${chat.baseline?.kind === 'usage' ? '' : 'dim'}`
  chip.title = [
    `这次对话要发出去的内容约 ${chat.surfaceTokens} 个词元（大致 2 个字符算 1 个），比上次的真实用量${delta > 0 ? `多 ${delta}` : delta < 0 ? `少 ${-delta}` : '一样多'}`,
    chat.baseline?.kind === 'usage'
      ? `上游上次报的真实用量：发送 ${chat.baseline.promptTokens} + 生成 ${chat.baseline.completionTokens} 个词元`
      : '还没拿到上游报的真实用量，所以这里是估算值',
    `累计（按上游报告算）：${chat.totalTokens} 个词元`,
    `代码补全：这次要发出约 ${inline.surfaceTokens} 个词元，累计 ${inline.totalTokens ?? 0}`,
    `按 ${chat.route?.model || '-'} 的价格估算：¥${(chat.cost?.surface ?? 0).toFixed(4)}`,
  ].join('\n')
}

/** Diagnostics tab: toolchain facts + where settings live. */
async function refreshDiagnostics(settings) {
  $('about-settings-file').value = settings?.paths?.settingsFile ?? ''
  const doctor = await api('/api/doctor').catch(() => null)
  state.doctor = doctor
  $('about-doctor').textContent = doctor
    ? [
        `编译器: ${doctor.uv4Path || '(未找到)'}`,
        `来源: ${doctor.uv4Source || '-'}    版本: ${doctor.c51Version || '-'}`,
        `头文件根: ${doctor.c51Root || '-'}`,
      ].join('\n')
    : '(诊断接口不可用)'
  const tokens = await api('/api/tokens').catch(() => null)
  const about = $('about-tokens')
  if (about) {
    about.textContent = tokens
      ? [
          `对话：这次发出 ${tokens.chat.surfaceTokens} 个词元（分 ${tokens.chat.nodes?.length ?? 0} 段） · 真实用量来源：${tokens.chat.baseline?.kind === 'usage' ? '上游报告' : '本地估算'} · 比上次 ${tokens.chat.surfaceDeltaTokens > 0 ? '+' : ''}${tokens.chat.surfaceDeltaTokens} · 累计 ${tokens.chat.totalTokens}`,
          `代码补全：这次发出 ${tokens.complete.surfaceTokens} 个词元 · 真实用量来源：${tokens.complete.baseline?.kind === 'usage' ? '上游报告' : '本地估算'} · 累计 ${tokens.complete.totalTokens}`,
          `分段用量：对话 ${JSON.stringify(tokens.breakdown?.chat ?? {})} · 补全 ${JSON.stringify(tokens.breakdown?.complete ?? {})}`,
          `按价格表估算：对话 ¥${(tokens.chat.cost?.surface ?? 0).toFixed(4)} · 补全 ¥${(tokens.complete.cost?.surface ?? 0).toFixed(4)}（${tokens.chat.route?.model || '-'}，输入 ${tokens.chat.route?.input ?? 0} / 输出 ${tokens.chat.route?.output ?? 0} 元每百万词元）`,
        ].join('\n')
      : '(token 计量不可用)'
  }
}

/** Reveal a path in Explorer; when the host refuses, at least show the path. */
async function revealPath(path, label) {
  if (!path) return
  const result = await post('/api/reveal', { path }).catch(() => ({ error: '调用失败' }))
  $('settings-status').textContent = result?.error ? `${label}: ${path}` : `已在资源管理器中定位${label}`
}

/**
 * Ask the endpoint for its model list (DeepSeek documents this as `GET /models`,
 * also reachable as `/v1/models`) and fill the model picker. Unsaved credentials
 * in the form are used, so it works before "保存".
 */
async function fetchModels({ silent = false } = {}) {
  const hint = $('model-hint')
  const list = $('ai-model-select')
  if (!hint || !list) return
  if (!silent) hint.textContent = '获取中…'
  // An explicit click must be a LIVE probe (a stale cache must never look like a
  // fresh answer); the silent pre-fill on opening the dialog may use the cache.
  const result = await post('/api/models', { ai: formSettingsPatch().ai, refresh: !silent }).catch((error) => ({
    ok: false,
    error: error.message,
  }))
  if (!result.ok) {
    hint.textContent = silent ? '' : `没拿到模型列表: ${result.error}`
    hint.title = (result.tried ?? []).join('\n')
    return
  }
  const current = $('ai-model').value.trim()
  list.textContent = ''
  for (const entry of result.detailed ?? []) {
    const option = document.createElement('option')
    option.value = entry.id
    option.textContent = entry.ownedBy ? `${entry.id}（提供方: ${entry.ownedBy}）` : entry.id
    list.appendChild(option)
  }
  const custom = document.createElement('option')
  custom.value = ''
  custom.textContent = '（手动填写下面的模型名）'
  list.appendChild(custom)
  // Preselect what is configured, when the endpoint still offers it.
  list.value = (result.models ?? []).includes(current) ? current : ''
  hint.textContent = `${result.models.length} 个可用模型${result.cached ? '（刚查过，用的缓存）' : ''}`
  hint.title = [result.url, ...(result.detailed ?? []).map((entry) => entry.id)].join('\n')
  // The key in the box only lives in this form until "保存全部设置" is pressed —
  // chat would then run without it, which is worth saying out loud.
  if (!silent && $('ai-key').value.trim()) {
    $('settings-status').textContent = '模型列表已更新。注意：密钥还没保存，聊天之前记得点"保存全部设置"。'
  }
}

async function openSettings() {
  const settings = await api('/api/settings')
  state.settings = { ...state.settings, ...settings }
  state.ai = settings.ai

  // --- AI 后端 ---
  $('ai-mode').value = settings.ai.mode
  $('ai-baseurl').value = settings.ai.baseURL
  $('ai-model').value = settings.ai.model
  $('ai-temp').value = settings.ai.temperature
  $('ai-max-tokens').value = settings.ai.maxTokens ?? 4096
  const key = $('ai-key')
  key.value = ''
  key.placeholder = settings.ai.apiKeySet
    ? `已保存 ${settings.ai.apiKeyHint}（留空表示不修改）`
    : '粘贴 API Key（本地端点可留空）'

  // --- 代码补全 ---
  const inline = settings.ai.inline ?? {}
  $('ai-inline').checked = inline.enabled !== false
  $('ai-inline-tokens').value = inline.maxTokens ?? 96
  $('ai-inline-debounce').value = inline.debounceMs ?? 300
  $('ai-inline-url').value = inline.url ?? ''
  $('ai-inline-model').value = inline.model ?? ''
  $('ai-inline-baseurl').value = inline.baseURL ?? ''
  $('ai-inline-multiline').value = inline.multiline ?? 'auto'
  $('ai-inline-prompt-tokens').value = inline.maxPromptTokens ?? 2048
  $('ai-inline-partial').value = inline.partialMs ?? 350
  const inlineKey = $('ai-inline-key')
  inlineKey.value = ''
  inlineKey.placeholder = settings.ai.inlineApiKeySet
    ? `已保存 ${settings.ai.inlineApiKeyHint}（留空表示不修改）`
    : '留空 = 用聊天的 Key'

  // --- 编辑器 ---
  const editor = settings.editor ?? {}
  $('editor-fontsize').value = editor.fontSize ?? 13
  $('editor-wordwrap').checked = editor.wordWrap === 'on'
  $('editor-minimap').checked = editor.minimap === true
  $('editor-tabsize').value = editor.tabSize ?? 4

  // --- 技能 ---
  const skills = settings.skills ?? {}
  $('skills-shared-dsh').checked = skills.sharedDsh !== false
  $('skills-dirs').value = (skills.dirs ?? []).join('\n')
  $('skills-desc-max').value = skills.descriptionMaxLength ?? 500

  // --- 文件：备份 + 跟随外部改动 ---
  const backup = settings.backup ?? {}
  $('backup-enabled').checked = backup.enabled !== false
  $('backup-dir').value = backup.dir ?? ''
  const sync = settings.sync ?? {}
  $('sync-enabled').checked = sync.enabled !== false
  $('sync-interval').value = sync.intervalMs ?? 2000

  // --- 预设提示词（外挂文件，可在界面里改）---
  const prompts = settings.prompts ?? {}
  $('prompts-file').value = prompts.file ?? ''
  await refreshPresetsAdmin()
  await loadPresets()
  // Start on the user layer, which is the one people normally edit.
  $('presets-which').value = 'user'
  await loadPresetsSource()

  await refreshSkillsAdmin()
  await refreshDiagnostics(settings)
  await refreshTokens()
  $('settings-status').textContent = ''
  showSettingsTab(state.settingsTab ?? 'ai')
  // Silent pre-fill when there is something to authenticate with (a stored key or a
  // local endpoint); remote endpoints without a key would only 401.
  if (settings.ai.apiKeySet || /127\.0\.0\.1|localhost/.test(settings.ai.baseURL)) fetchModels({ silent: true })
  $('settings').classList.remove('hidden')
}

/** Every settings field as one patch (keys only when the user typed one). */
function formSettingsPatch() {
  const ai = {
    mode: $('ai-mode').value,
    baseURL: $('ai-baseurl').value.trim(),
    model: $('ai-model').value.trim(),
    temperature: Number($('ai-temp').value) || 0,
    // The CHAT answer limit (the inline-completion limit lives under ai.inline).
    maxTokens: Number($('ai-max-tokens').value) || 4096,
    inline: {
      enabled: $('ai-inline').checked,
      maxTokens: Number($('ai-inline-tokens').value) || 96,
      debounceMs: Number($('ai-inline-debounce').value) || 300,
      url: $('ai-inline-url').value.trim(),
      model: $('ai-inline-model').value.trim(),
      baseURL: $('ai-inline-baseurl').value.trim(),
      multiline: $('ai-inline-multiline').value,
      maxPromptTokens: Number($('ai-inline-prompt-tokens').value) || 2048,
      partialMs: Number($('ai-inline-partial').value) || 350,
    },
  }
  const inlineKey = $('ai-inline-key').value.trim()
  if (inlineKey) ai.inline.apiKey = inlineKey
  const key = $('ai-key').value.trim()
  if (key) ai.apiKey = key
  return {
    ai,
    editor: {
      fontSize: Number($('editor-fontsize').value) || 13,
      wordWrap: $('editor-wordwrap').checked ? 'on' : 'off',
      minimap: $('editor-minimap').checked,
      tabSize: Number($('editor-tabsize').value) || 4,
    },
    skills: {
      sharedDsh: $('skills-shared-dsh').checked,
      dirs: $('skills-dirs')
        .value.split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
      descriptionMaxLength: Number($('skills-desc-max').value) || 500,
    },
    backup: {
      enabled: $('backup-enabled').checked,
      dir: $('backup-dir').value.trim(),
    },
    sync: {
      enabled: $('sync-enabled').checked,
      intervalMs: Number($('sync-interval').value) || 2000,
    },
    prompts: {
      file: $('prompts-file').value.trim(),
    },
  }
}

async function saveSettings() {
  const saved = await post('/api/settings', formSettingsPatch())
  state.settings = { ...state.settings, ...saved }
  state.ai = saved.ai
  applyEditorSettings()
  renderAiChip(saved.ai)
  renderInlineChip()
  await loadSkills()
  await loadPresets()
  await refreshSkillsAdmin()
  await refreshPresetsAdmin()
  startSync()
  $('settings-status').textContent = '已保存到 settings.json'
}

async function testAi() {
  $('settings-status').textContent = '测试中…'
  const data = await post('/api/ai/test', { ai: formSettingsPatch().ai })
  if (data.ok) {
    $('settings-status').textContent = `连接成功 ✔ ${data.url} · 拿到 ${data.models.length} 个模型${data.usedKey ? '' : '（这个端点不需要密钥）'}`
    return
  }
  // A failed live probe can coexist with a cached list — say both, so the dialog
  // never shows "连接失败" next to a filled-in dropdown without explanation.
  const stale = (data.cachedModels ?? []).length
    ? `\n（下拉里的 ${data.cachedModels.length} 个模型是 ${formatTime(data.cachedAt)} 缓存的，不是刚拿到的）`
    : ''
  $('settings-status').textContent = `连接失败 ✘ ${data.error}${stale}`
  $('settings-status').title = (data.tried ?? []).join('\n')
}

async function clearAiKey() {
  const saved = await post('/api/settings', { ai: { clearApiKey: true } })
  state.ai = saved.ai
  renderAiChip(saved.ai)
  $('settings-status').textContent = '已清除两个角色的密钥'
}

/* ---------- C51 symbol intelligence: completion / hover / signature / F12 ---------- */

const C51_KEYWORDS = [
  'bit', 'sbit', 'sfr', 'sfr16', 'data', 'idata', 'pdata', 'xdata', 'code', 'bdata',
  'interrupt', 'using', 'reentrant', 'compact', 'large', 'small', '_at_', '_nop_', 'alien',
  'static', 'extern', 'const', 'volatile', 'unsigned', 'signed', 'char', 'int', 'long',
  'float', 'double', 'void', 'struct', 'union', 'enum', 'typedef', 'return', 'if', 'else',
  'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue', 'goto', 'sizeof',
]

/** Index entries minus C51 runtime internals (empty until /api/symbols answers). */
function indexedSymbols() {
  return (state.symbols?.symbols ?? []).filter((symbol) => !symbol.system)
}

/** Case-insensitive symbol lookup. */
function findSymbol(name) {
  const wanted = String(name ?? '').toLowerCase()
  return indexedSymbols().find((symbol) => symbol.name.toLowerCase() === wanted)
}

/** Right-hand text of a completion row: address, parameter list, or type. */
function symbolDetailText(symbol) {
  if (symbol.address) return `${symbol.space ? `${symbol.space}:` : ''}${symbol.address}`
  if (symbol.params?.length) return `(${symbol.params.join(', ')})`
  return symbol.type || symbol.detail || ''
}

/** Monaco completion kind for one index entry. */
function symbolCompletionKind(monaco, symbol) {
  switch (symbol.kind) {
    case 'function': return monaco.languages.CompletionItemKind.Function
    case 'macro': return monaco.languages.CompletionItemKind.Constant
    case 'struct': return monaco.languages.CompletionItemKind.Struct
    case 'typedef': return monaco.languages.CompletionItemKind.Interface
    default: return monaco.languages.CompletionItemKind.Variable
  }
}

/** Markdown for the hover card. */
function symbolMarkdown(symbol) {
  const lines = [`**${symbol.name}** · ${symbol.kind}${symbol.from === 'linker' ? '（来自链接映射）' : ''}`]
  if (symbol.type) lines.push(`类型: \`${symbol.type}\``)
  if (symbol.params?.length) lines.push(`参数: \`(${symbol.params.join(', ')})\``)
  if (symbol.address) lines.push(`地址: \`${symbol.space ? `${symbol.space}:` : ''}${symbol.address}\``)
  if (symbol.members?.length) lines.push(`成员: ${symbol.members.map((member) => `${member.type} ${member.name}`).join('; ')}`)
  if (symbol.detail && !symbol.address) lines.push(symbol.detail)
  if (symbol.source?.file) lines.push(`定义: ${symbol.source.file}:${symbol.source.line}`)
  return { value: lines.join('\n\n') }
}

/** Show what the index found, and whether the linker map may be stale. */
function renderSymbolChip() {
  const chip = $('symbol-chip')
  const index = state.symbols
  if (!index || index.error) {
    chip.textContent = '符号: 不可用'
    chip.className = 'chip bad'
    chip.title = index?.error ?? ''
    return
  }
  const stats = index.stats ?? {}
  const bits = (stats.sfr ?? 0) + (stats.sfr16 ?? 0) + (stats.sbit ?? 0)
  chip.textContent = `符号: ${bits} 个寄存器/位 · ${stats.function ?? 0} 个函数 · ${index.headers?.length ?? 0} 个头文件`
  chip.className = `chip ${index.linkerMap?.stale ? 'bad' : ''}`
  chip.title = [
    `索引头文件: ${(index.headers ?? []).join(', ') || '(无)'}`,
    `链接映射: ${index.linkerMap?.count ?? 0} 个符号${index.linkerMap?.stale ? '（⚠ 可能过期：源码比映射新，先编译一次）' : ''}`,
    `工程源码: ${(index.sources?.sources ?? []).join(', ') || '(无)'}`,
  ].join('\n')
}

/** Register C51 completion, hover, signature help and the F12 jump. */
function registerC51Intelligence(monaco) {
  const linePrefix = (model, position) =>
    model.getValueInRange({
      startLineNumber: position.lineNumber,
      startColumn: 1,
      endLineNumber: position.lineNumber,
      endColumn: position.column,
    })

  monaco.languages.registerCompletionItemProvider('c51', {
    triggerCharacters: ['.', '>'],
    provideCompletionItems(model, position) {
      const line = linePrefix(model, position)
      // Member completion: `obj.` or `ptr->`
      const member = /([A-Za-z_]\w*)\s*(?:\.|->)\s*\w*$/.exec(line)
      if (member) {
        const variable = findSymbol(member[1])
        const typeName = (variable?.type ?? '').replace(/^struct\s+/, '').trim()
        const members = variable?.members ?? state.symbols?.structs?.[typeName] ?? []
        const memberSuggestions = members.map((entry) => ({
          label: entry.name,
          kind: monaco.languages.CompletionItemKind.Field,
          detail: entry.type,
          insertText: entry.name,
        }))
        if (memberSuggestions.length) return { suggestions: memberSuggestions }
      }

      const word = /([A-Za-z_]\w*)$/.exec(line)?.[1] ?? ''
      const range = word
        ? {
            startLineNumber: position.lineNumber,
            startColumn: position.column - word.length,
            endLineNumber: position.lineNumber,
            endColumn: position.column,
          }
        : undefined
      const suggestions = []
      for (const symbol of indexedSymbols()) {
        suggestions.push({
          label: symbol.name,
          kind: symbolCompletionKind(monaco, symbol),
          detail: symbolDetailText(symbol),
          documentation: symbolMarkdown(symbol),
          insertText: symbol.name,
          range,
          // project symbols first, then header symbols, then linker-only names
          sortText: `${symbol.from === 'source' ? '0' : symbol.from === 'header' ? '1' : '2'}${symbol.name}`,
        })
      }
      for (const keyword of C51_KEYWORDS) {
        suggestions.push({
          label: keyword,
          kind: monaco.languages.CompletionItemKind.Keyword,
          insertText: keyword,
          range,
          sortText: `3${keyword}`,
        })
      }
      return { suggestions }
    },
  })

  monaco.languages.registerHoverProvider('c51', {
    provideHover(model, position) {
      const word = model.getWordAtPosition(position)
      const symbol = word ? findSymbol(word.word) : undefined
      if (!symbol) return null
      return {
        range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
        contents: [symbolMarkdown(symbol)],
      }
    },
  })

  monaco.languages.registerSignatureHelpProvider('c51', {
    signatureHelpTriggerCharacters: ['(', ','],
    provideSignatureHelp(model, position) {
      const text = model.getValueInRange({
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      })
      const call = /([A-Za-z_]\w*)\s*\(([^()]*)$/.exec(text)
      const symbol = call ? findSymbol(call[1]) : undefined
      if (!symbol?.params?.length) return null
      return {
        value: {
          signatures: [
            {
              label: `${symbol.type ?? 'void'} ${symbol.name}(${symbol.params.join(', ')})`,
              parameters: symbol.params.map((parameter) => ({ label: parameter })),
            },
          ],
          activeSignature: 0,
          activeParameter: call[2].split(',').length - 1,
        },
        dispose() {},
      }
    },
  })

  // F12 goes through the host instead of Monaco's file URIs: standalone Monaco
  // cannot open arbitrary files, and the host enforces the project-directory rule.
  state.editor.addAction({
    id: 'c51.gotoDefinition',
    label: '跳转到定义',
    keybindings: [monaco.KeyCode.F12],
    run: async () => {
      const position = state.editor.getPosition()
      const word = state.editor.getModel().getWordAtPosition(position)
      const symbol = word ? findSymbol(word.word) : undefined
      if (!symbol?.source?.file) {
        appendMessage('ai', '跳转', `未找到 ${word?.word ?? '(空白)'} 的定义`)
        return
      }
      const file = symbol.source.file
      const allowed = (state.readRoots ?? []).some((root) => {
        const prefix = root.replace(/[\\/]+$/, '').toLowerCase()
        return file.toLowerCase() === prefix || file.toLowerCase().startsWith(`${prefix}\\`)
      })
      if (!allowed) {
        appendMessage('ai', '跳转到定义', `${symbol.name} 定义在可读范围之外：\n${file}:${symbol.source.line}`)
        return
      }
      const opened = await openFileByPath(file)
      if (!opened) return
      state.editor.revealLineInCenter(symbol.source.line)
      state.editor.setPosition({ lineNumber: symbol.source.line, column: 1 })
      state.editor.focus()
    },
  })
}

/* ---------- Inline (ghost text) completion ---------- */

const inlineStats = { ms: 0, cached: false, errors: 0, shown: 0 }

/** Show inline-completion latency/state in the toolbar. */
function renderInlineChip() {
  const chip = $('inline-chip')
  const config = state.ai?.inline
  if (!chip) return
  if (!config) {
    chip.textContent = '补全: —'
    chip.className = 'chip dim'
    return
  }
  if (!config.enabled) {
    chip.textContent = '补全: 已关闭'
    chip.className = 'chip dim'
    chip.title = '在 ⚙ AI 设置里可打开行内补全'
    return
  }
  const parts = [inlineStats.ms ? `${inlineStats.ms} ms` : '待触发']
  if (inlineStats.cached) parts.push('缓存')
  if (inlineStats.shown) parts.push(`出字 ${inlineStats.shown} 次`)
  if (inlineStats.notes?.length) parts.push(`后处理 ${inlineStats.notes.length}`)
  if (inlineStats.errors) parts.push(`失败 ${inlineStats.errors}`)
  chip.textContent = `补全: ${parts.join(' · ')}`
  chip.className = `chip ${inlineStats.errors ? 'bad' : ''}`
  chip.title = [
    `行内补全（Ghost text）：${config.url || '(默认 {baseURL}/completions)'}`,
    `模型: ${config.model || '(跟随聊天模型)'}  端点: ${config.baseURL || '(跟随聊天 BaseURL)'}`,
    `一次最多生成 ${config.maxTokens} 个词元 · 参考上文最多 ${config.maxPromptTokens} 个词元 · 停 ${config.debounceMs} 毫秒才请求 · ${multilineNote(config.multiline)}`,
    `停止符=${JSON.stringify(config.stop)}`,
    inlineStats.notes?.length ? `最近一次后处理: ${inlineStats.notes.join('；')}` : '',
    inlineStats.context,
    'Tab 接受；输入时自动请求，上一条请求会被取消',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Register inline (ghost text) completion.
 *
 * Monaco calls this on every keystroke and cancels the previous token, so the
 * pattern is: debounce inside the provider, abort the in-flight request when the
 * token is cancelled, and keep the answer tiny — a late ghost text is worse than
 * none. Only a cursor right after non-blank code is worth asking about.
 */
function registerInlineCompletion(monaco) {
  monaco.languages.registerInlineCompletionsProvider('c51', {
    async provideInlineCompletions(model, position, context, token) {
      const config = state.ai?.inline
      // Instrumentation for verify/inline-test.mjs: prove what the provider saw
      // and returned, independent of whether Monaco chose to paint it.
      const debug = (window.__inlineDebug = window.__inlineDebug ?? { calls: 0, returned: 0, lastText: '', lastError: '' })
      debug.calls += 1
      debug.lastError = ''
      if (!config?.enabled) {
        debug.lastError = 'disabled'
        return { items: [] }
      }

      const lineBefore = model.getLineContent(position.lineNumber).slice(0, position.column - 1)
      if (!lineBefore.trim()) return { items: [] } // never guess on a blank line
      if (position.column <= 1) return { items: [] }

      await new Promise((resolve) => setTimeout(resolve, config.debounceMs ?? 300))
      if (token.isCancellationRequested) return { items: [] }

      const firstLine = Math.max(1, position.lineNumber - 80)
      const lastLine = Math.min(model.getLineCount(), position.lineNumber + 40)
      const prefix = model
        .getValueInRange({
          startLineNumber: firstLine,
          startColumn: 1,
          endLineNumber: position.lineNumber,
          endColumn: position.column,
        })
        .slice(-2000)
      const suffix = model
        .getValueInRange({
          startLineNumber: position.lineNumber,
          startColumn: position.column,
          endLineNumber: lastLine,
          endColumn: model.getLineMaxColumn(lastLine),
        })
        .slice(0, 600)

      // The multi-line decision is made by the host (keil-completion.mjs), so the
      // rule exists in exactly one place and is unit-tested.
      const controller = new AbortController()
      token.onCancellationRequested(() => controller.abort())
      try {
        const data = await api('/api/complete', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            project: state.settings.project,
            prefix,
            suffix,
            multilineMode: config.multiline,
            maxPromptTokens: config.maxPromptTokens,
          }),
          signal: controller.signal,
        })
        if (!data.ok || !data.text) {
          if (data.error) {
            inlineStats.errors += 1
            renderInlineChip()
          }
          return { items: [] }
        }
        inlineStats.ms = data.ms ?? 0
        inlineStats.cached = Boolean(data.cached)
        inlineStats.notes = data.notes ?? []
        inlineStats.model = data.model ?? ''
        inlineStats.context = data.truncated ? '上文太长，已自动截断' : ''
        inlineStats.shown += 1
        renderInlineChip()
        const text = String(data.text).replace(/\s+$/, '')
        if (!text.trim()) return { items: [] }
        debug.returned += 1
        debug.lastText = text
        // Monaco REQUIRES an explicit range. Without one it assumes the current
        // word is the replacement range and then silently drops any item whose
        // insertText does not start with that word — every completion vanished.
        // An empty range at the cursor means "insert here, replace nothing".
        // (Verified with verify/inline-range.mjs: no range -> ghostCount 0,
        //  empty range -> ghostCount 1.)
        const range = new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column)
        return { items: [{ insertText: text, range, completeBracketPairs: true }] }
      } catch (error) {
        if (error.name !== 'AbortError') {
          inlineStats.errors += 1
          renderInlineChip()
        }
        return { items: [] }
      }
    },
    freeInlineCompletions() {
      // Nothing to release: items are plain objects.
    },
  })
}

/* ---------- Monaco bootstrap ---------- */

/** Load Monaco and create the editor. Returns a promise that resolves once the
 *  editor exists, because the AMD load is asynchronous and the first
 *  openFile() would otherwise race it and render nothing. */
function startMonaco() {
  return new Promise((resolve) => {
    require.config({ paths: { vs: '/vs' } })
    require(['vs/editor/editor.main'], (monaco) => {
    state.monaco = monaco
    monaco.languages.register({ id: 'c51' })
    monaco.languages.setLanguageConfiguration('c51', {
      comments: { lineComment: '//', blockComment: ['/*', '*/'] },
      brackets: [
        ['{', '}'],
        ['[', ']'],
        ['(', ')'],
      ],
      autoClosingPairs: [
        { open: '{', close: '}' },
        { open: '[', close: ']' },
        { open: '(', close: ')' },
        { open: '"', close: '"' },
        { open: "'", close: "'" },
      ],
    })
    // C51 adds storage classes, memory-space keywords and SFR syntax on top of C.
    monaco.languages.setMonarchTokensProvider('c51', {
      keywords: [
        'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum', 'extern',
        'float', 'for', 'goto', 'if', 'int', 'long', 'register', 'return', 'short', 'signed', 'sizeof', 'static',
        'struct', 'switch', 'typedef', 'union', 'unsigned', 'void', 'volatile', 'while',
        'bit', 'sbit', 'sfr', 'sfr16', 'data', 'idata', 'pdata', 'xdata', 'code', 'bdata', 'interrupt', 'using',
        'reentrant', 'compact', 'large', 'small', '_at_', '_nop_', 'alien',
      ],
      builtins: [
        'P0', 'P1', 'P2', 'P3', 'PSW', 'ACC', 'B', 'SP', 'DPL', 'DPH', 'IE', 'IP', 'TMOD', 'TCON', 'TH0', 'TL0',
        'TH1', 'TL1', 'SCON', 'SBUF', 'PCON', 'EA', 'ET0', 'ET1', 'EX0', 'EX1', 'ES', 'TR0', 'TR1', 'TF0', 'TF1',
        'TI', 'RI', 'IT0', 'IT1',
      ],
      tokenizer: {
        root: [
          [/[a-zA-Z_]\w*/, { cases: { '@keywords': 'keyword', '@builtins': 'type.identifier', '@default': 'identifier' } }],
          { include: '@whitespace' },
          [/[{}()\[\]]/, '@brackets'],
          [/[;,.]/, 'delimiter'],
          [/\d*\.\d+([eE][\-+]?\d+)?/, 'number.float'],
          [/0[xX][0-9a-fA-F]+/, 'number.hex'],
          [/\d+/, 'number'],
          [/"([^"\\]|\\.)*$/, 'string.invalid'],
          [/"/, 'string', '@string'],
        ],
        whitespace: [
          [/[ \t\r\n]+/, ''],
          [/\/\*/, 'comment', '@comment'],
          [/\/\/.*$/, 'comment'],
        ],
        comment: [
          [/[^\/*]+/, 'comment'],
          [/\*\//, 'comment', '@pop'],
          [/[\/*]/, 'comment'],
        ],
        string: [
          [/[^\\"]+/, 'string'],
          [/\\./, 'string.escape.invalid'],
          [/"/, 'string', '@pop'],
        ],
      },
    })

    state.editor = monaco.editor.create($('editor'), {
      value: '// 选择左侧文件开始编辑',
      language: 'c51',
      theme: 'vs-dark',
      automaticLayout: true,
      fontSize: 13,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      inlineSuggest: { enabled: true },
    })
    state.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveCurrent())
    state.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyS, () => saveAs())
    state.editor.addCommand(monaco.KeyCode.F7, () => build('build'))
    // Track "has unsaved edits" so the external-change watcher knows whether it may
    // reload the file silently or must ask first.
    state.editor.onDidChangeModelContent(() => {
      if (state.current) state.dirty = state.editor.getValue() !== state.current.text
      renderFileChip()
    })
    registerC51Intelligence(monaco)
    registerInlineCompletion(monaco)
      resolve()
    })
  })
}

/* ---------- following files changed by other programs ---------- */

/** Small toolbar chip: what the external-change watcher is doing right now. */
function setSyncChip(text, kind = 'dim', title = '') {
  const chip = $('sync-chip')
  if (!chip) return
  chip.textContent = `同步: ${text}`
  chip.className = `chip ${kind}`
  chip.title = title
}

/**
 * A message that must SURVIVE the next poll. Without this the "read in an
 * external change" notice was overwritten by "up to date" within milliseconds —
 * the end-to-end test caught exactly that.
 */
function setSyncNotice(text, kind = '', title = '', holdMs = 6000) {
  setSyncChip(text, kind, title)
  syncState.noticeUntil = Date.now() + holdMs
}

/** One poll: pick up files changed outside this window, never clobbering edits. */
async function pollSync() {
  if (syncState.busy || state.settings?.sync?.enabled === false) return
  const project = state.settings?.project
  if (!project) return
  syncState.busy = true
  try {
    const current = state.current?.path ?? ''
    const query = `/api/sync?project=${encodeURIComponent(project)}${current ? `&path=${encodeURIComponent(current)}` : ''}`
    const data = await api(query).catch(() => null)
    if (!data?.ok) {
      setSyncChip('检查失败', 'dim', '拿不到文件改动时间，工程可能被移动了')
      return
    }
    // 1) the file open in the editor
    const fileMtime = data.file?.mtimeMs ?? 0
    if (current && fileMtime) {
      if (syncState.fileMtime && fileMtime !== syncState.fileMtime) await handleExternalChange(current)
      syncState.fileMtime = fileMtime
    }
    // 2) the project's sources and the hex artefact: refresh the tree and chips only
    let changed = false
    for (const source of data.sources ?? []) {
      const known = syncState.sources.get(source.path)
      if (known !== undefined && known !== source.mtimeMs) changed = true
      syncState.sources.set(source.path, source.mtimeMs)
    }
    if (changed) await loadProject(project, { keepFile: true })
    if (!syncState.conflict && Date.now() > syncState.noticeUntil) {
      setSyncChip(
        `已是最新 ${formatTime(new Date().toISOString())}`,
        'dim',
        `每 ${data.intervalMs ?? 2000} 毫秒检查一次工程里的文件变化`,
      )
    }
  } finally {
    syncState.busy = false
  }
}

/** A file changed on disk: read it in, unless this window has unsaved edits. */
async function handleExternalChange(path) {
  if (!state.dirty) {
    await openFileByPath(path)
    setSyncNotice('已自动读入外部改动', '', `${formatTime(new Date().toISOString())} 重新读取了 ${path}`)
    return
  }
  syncState.conflict = true
  setSyncChip(
    '有冲突：文件被外部改过',
    'bad',
    `${path}\n你在本窗口也有还没保存的修改，所以我没有覆盖它。\n点这里 = 放弃你的修改，重新读磁盘上的那一版。`,
  )
}

/** (Re)start the watcher according to the settings. */
function startSync() {
  clearInterval(syncState.timer)
  if (state.settings?.sync?.enabled === false) {
    setSyncChip('已关闭', 'dim', '可以在"设置 → 文件"里打开')
    return
  }
  const interval = Math.max(500, Number(state.settings?.sync?.intervalMs ?? 2000))
  syncState.timer = setInterval(pollSync, interval)
  pollSync()
}

/**
 * A promise-based text prompt.
 *
 * IMPORTANT: `window.prompt()` is NOT supported in Electron (it logs an error and
 * returns null), so every "type a name" flow must use this instead.
 */
function askText({ title, label = '名称', value = '', hint = '' }) {
  return new Promise((resolve) => {
    $('prompt-title').textContent = title
    $('prompt-label').textContent = label
    $('prompt-input').value = value
    $('prompt-hint').textContent = hint
    $('prompt-status').textContent = ''
    // `#ask-modal`, NOT `#prompt`: the chat textarea already owns that id, and
    // reusing it made getElementById return the textarea so this dialog never
    // appeared (the "新建文件没反应" bug).
    $('ask-modal').classList.remove('hidden')
    $('prompt-input').focus()
    $('prompt-input').select()
    const finish = (result) => {
      $('ask-modal').classList.add('hidden')
      $('btn-prompt-ok').onclick = null
      $('btn-prompt-close').onclick = null
      $('prompt-input').onkeydown = null
      resolve(result)
    }
    $('btn-prompt-ok').onclick = () => finish($('prompt-input').value.trim() || null)
    $('btn-prompt-close').onclick = () => finish(null)
    $('prompt-input').onkeydown = (event) => {
      if (event.key === 'Enter') finish($('prompt-input').value.trim() || null)
      if (event.key === 'Escape') finish(null)
    }
  })
}

/* ---------- preset prompts (external files, editable) ---------- */

/** Load the merged preset list and fill the dropdown. */
async function loadPresets() {
  const select = $('preset')
  if (!select) return
  const data = await api(`/api/prompts?project=${encodeURIComponent(state.settings.project ?? '')}`).catch(() => null)
  state.presets = data?.prompts ?? []
  state.presetsUsedBundled = data?.usedBundled === true
  state.presetsBundledReason = data?.bundledReason ?? ''
  const previous = select.value
  select.textContent = ''
  const none = document.createElement('option')
  none.value = ''
  none.textContent = state.presets.length ? '（选一条预设提示词，填进下面的输入框）' : '（没有预设：见"设置 → 预设提示词"）'
  select.appendChild(none)
  for (const preset of state.presets) {
    const option = document.createElement('option')
    option.value = preset.name
    option.textContent = preset.name
    option.title = [preset.description, `来自: ${preset.path}`].filter(Boolean).join('\n')
    select.appendChild(option)
  }
  select.value = state.presets.some((preset) => preset.name === previous) ? previous : ''
  $('preset-hint').textContent = state.presets.length
    ? `${state.presets.length} 条${state.presetsUsedBundled ? '（内置兜底）' : ''}`
    : ''
  $('preset-hint').title = state.presetsUsedBundled ? state.presetsBundledReason : '来自你自己的预设文件'
}

/** Put the chosen preset text into the chat box (the user can still edit it). */
function applyPreset() {
  const preset = (state.presets ?? []).find((entry) => entry.name === $('preset').value)
  if (!preset) return
  $('prompt').value = preset.text
  $('prompt').focus()
  $('preset-hint').textContent = preset.from === 'bundled' ? '内置兜底（你还没配置预设）' : `来自 ${preset.from}`
}

/** Load one preset layer into the JSON editor. */
async function loadPresetsSource() {
  const which = $('presets-which').value
  const data = await api(
    `/api/prompts/source?which=${encodeURIComponent(which)}&project=${encodeURIComponent(state.settings.project ?? '')}`,
  ).catch((error) => ({ error: error.message }))
  if (data.error) {
    $('settings-status').textContent = `载入失败: ${data.error}`
    return
  }
  $('presets-json').value = data.text
  $('settings-status').textContent = data.exists
    ? `已载入 ${which} 层: ${data.path}`
    : `这一层还没有文件（${data.path}）——点"生成可编辑副本"或直接在下面写内容后保存`
}

/** Save the JSON editor back into the chosen layer (the server validates it). */
async function savePresetsSource() {
  const which = $('presets-which').value
  const data = await post('/api/prompts/save', {
    which,
    text: $('presets-json').value,
    project: state.settings.project,
  }).catch((error) => ({ error: error.message }))
  $('settings-status').textContent = data.error ? `保存失败: ${data.error}` : `已保存 ${data.count} 条预设到 ${which} 层: ${data.path}`
  if (!data.error) {
    await loadPresets()
    await refreshPresetsAdmin()
  }
}

/** Show where presets come from, and let the user open/create the editable file. */
async function refreshPresetsAdmin() {
  const host = $('presets-info')
  if (!host) return
  const data = await api(`/api/prompts?project=${encodeURIComponent(state.settings.project ?? '')}`).catch(() => null)
  const files = data?.files ?? []
  host.textContent = [
    data?.usedBundled
      ? `正在用**内置**预设：${data.bundledReason ?? ''}`
      : `正在用你自己的预设（${data?.prompts?.length ?? 0} 条），内置的不参与`,
    ...files.map(
      (file) =>
        `${file.used ? '▶' : file.exists ? '✔' : '·'} ${String(file.from).padEnd(8)} ${String(file.count ?? 0).padStart(2)} 条  ${file.path}`,
    ),
    ...(data?.problems ?? []).map((line) => `⚠ ${line}`),
  ].join('\n')
}

/* ---------- file / project commands (the File and Project menus) ---------- */

/** Toolbar chip: which file is open, and whether it has unsaved edits. */
function renderFileChip() {
  const chip = $('file-chip')
  if (!chip) return
  const current = state.current
  chip.textContent = current ? `文件: ${current.name}${state.dirty ? ' ● 未保存' : ''}` : '文件: 未打开'
  chip.className = `chip ${state.dirty ? 'bad' : current ? '' : 'dim'}`
  chip.title = current ? `${current.path}\n（● = 还没保存）` : '用左侧的"打开"按钮选一个文件'
}

/** Create a source file in the project; optionally declare it in the .uvproj. */
async function newFile() {
  const name = await askText({
    title: '新建文件',
    label: '文件名',
    value: 'led.c',
    hint: '只能是不带路径的名字，例如 led.c / led.h / test.a51（会按扩展名填一个起始骨架）',
  })
  if (!name) return
  const data = await post('/api/file/new', { project: state.settings.project, name }).catch((error) => ({ error: error.message }))
  if (data.error) {
    appendMessage('err', '新建文件', data.error)
    return
  }
  let extra = ''
  // µVision only builds the files its project declares, so offer to declare it.
  if (confirm(`已创建：\n${data.path}\n\n要把它加进工程吗？\n（不加进去就不会参与编译）`)) {
    const added = await post('/api/project/add-file', { project: state.settings.project, name }).catch((error) => ({
      error: error.message,
    }))
    extra = added.error
      ? `\n加入工程失败: ${added.error}`
      : `\n已加入工程${added.backup ? `（工程文件已备份: ${added.backup}）` : '（未备份：备份开关是关的）'}`
  }
  appendMessage('ai', `新建文件 ${name}`, `${data.bytes} 字节${data.fromTemplate ? '（已填入起始骨架）' : ''}${extra}`)
  await loadProject(state.settings.project, { keepFile: true })
  await openFileByPath(data.path)
}

/** Open any file through the native dialog — it may live outside the project. */
async function openPickedFile() {
  const data = await post('/api/pick-file', {}).catch((error) => ({ error: error.message }))
  if (data.error) {
    appendMessage('err', '打开文件', data.error)
    return
  }
  if (data.canceled) return
  await openFileByPath(data.path)
  appendMessage('ai', `已打开 ${baseName(data.path)}`, `${data.path}\n${data.bytes} 字节`)
}

/** Browse for an existing project and switch to it. */
async function openProject() {
  const data = await post('/api/pick-project', {}).catch((error) => ({ error: error.message }))
  if (data.error) {
    appendMessage('err', '打开工程', data.error)
    return
  }
  if (data.canceled) return
  state.settings.project = data.project
  state.settings.recent = data.recent ?? state.settings.recent
  await refreshProjectSelect()
  await loadProject(data.project)
  startSync()
  appendMessage('ai', '已打开工程', data.project)
}

/** Rebuild the project dropdown from settings (after opening or creating one). */
async function refreshProjectSelect() {
  const settings = await api('/api/settings').catch(() => null)
  if (settings) state.settings = { ...state.settings, ...settings }
  const select = $('project')
  const options = [...new Set([state.settings.project, ...(state.settings.recent || [])])].filter(Boolean)
  select.textContent = ''
  for (const project of options) {
    const option = document.createElement('option')
    option.value = project
    option.textContent = project
    select.appendChild(option)
  }
  select.value = state.settings.project ?? ''
}

/** Save the current buffer under another name inside the project. */
async function saveAs() {
  if (!state.editor) return
  const name = await askText({
    title: '另存为',
    label: '文件名',
    value: state.current?.name ?? 'main.c',
    hint: '存到当前工程目录里；如果这个名字还没在工程里，我可以接着帮你加进去',
  })
  if (!name) return
  const data = await post('/api/file', {
    project: state.settings.project,
    path: absPath(name),
    text: state.editor.getValue(),
  }).catch((error) => ({ error: error.message }))
  if (data.error) {
    appendMessage('err', '另存为失败', data.error)
    return
  }
  appendMessage('ai', `已另存为 ${name}`, `${data.bytes} 字节 · ${encodingNote(data.bomFree)}${backupNote(data)}`)
  await loadProject(state.settings.project, { keepFile: true })
  await openFileByPath(data.path)
}

/** Close the file in the editor (the buffer stays on disk). */
function closeFile() {
  if (!state.current) return
  if (state.dirty && !confirm(`${state.current.name} 还有没保存的修改，确定要关掉吗？`)) return
  state.current = null
  state.dirty = false
  if (state.editor) state.editor.setValue('')
  renderTree()
  renderFileChip()
}

/* ---------- 新建工程：器件库选择 ---------- */

/** The whole C51 device list (fetched once) and the device the user picked. */
let deviceLibrary = null
let npDevice = null
const DEVICE_MENU_MAX = 60

async function ensureDeviceLibrary() {
  if (deviceLibrary) return deviceLibrary
  const info = $('np-device-info')
  if (info) info.textContent = '正在读取 Keil 器件库…'
  const data = await api('/api/devices').catch((error) => ({ error: error.message }))
  if (data.error) {
    if (info) info.textContent = `器件库读取失败：${data.error}（仍可手填型号）`
    return null
  }
  deviceLibrary = data
  if (info) info.textContent = `已从本机 Keil 读到 ${data.total} 个 C51 器件（${data.vendors.length} 个厂商）`
  return deviceLibrary
}

/** Filter by substring, prefix matches first. 1703 items is small enough to scan. */
function deviceMatches(query) {
  if (!deviceLibrary) return { devices: [], total: 0 }
  const needle = query.trim().toLowerCase()
  if (!needle) return { devices: deviceLibrary.devices.slice(0, DEVICE_MENU_MAX), total: deviceLibrary.total }
  const hits = []
  for (const device of deviceLibrary.devices) {
    const at = device.name.toLowerCase().indexOf(needle)
    if (at !== -1) hits.push({ device, at })
  }
  hits.sort((left, right) => (left.at === 0 ? 0 : 1) - (right.at === 0 ? 0 : 1) || left.at - right.at)
  return { devices: hits.slice(0, DEVICE_MENU_MAX).map((hit) => hit.device), total: hits.length }
}

/** Place the fixed-position list under the input, flipping up when space is short. */
function positionDeviceMenu() {
  const input = $('np-device')
  const menu = $('np-device-menu')
  if (!input || !menu || menu.classList.contains('hidden')) return
  const rect = input.getBoundingClientRect()
  const gap = 2
  const margin = 8
  const below = window.innerHeight - rect.bottom - gap - margin
  const above = rect.top - gap - margin
  const openUp = below < 160 && above > below
  const space = Math.max(120, openUp ? above : below)
  menu.style.left = `${Math.round(rect.left)}px`
  menu.style.width = `${Math.round(rect.width)}px`
  menu.style.maxHeight = `${Math.floor(Math.min(240, space))}px`
  if (openUp) {
    menu.style.top = 'auto'
    menu.style.bottom = `${Math.round(window.innerHeight - rect.top + gap)}px`
  } else {
    menu.style.bottom = 'auto'
    menu.style.top = `${Math.round(rect.bottom + gap)}px`
  }
}

function renderDeviceMenu() {
  const menu = $('np-device-menu')
  menu.replaceChildren()
  if (!deviceLibrary) {
    menu.classList.add('hidden')
    return
  }
  const query = $('np-device').value
  const { devices, total } = deviceMatches(query)
  if (!devices.length) {
    const empty = document.createElement('div')
    empty.className = 'item'
    empty.textContent = '没有匹配的器件（可手填型号，内存配置会沿用 AT89C51）'
    menu.append(empty)
  }
  for (const device of devices) {
    const item = document.createElement('div')
    item.className = 'item'
    item.dataset.name = device.name
    const name = document.createElement('span')
    name.textContent = device.name
    const meta = document.createElement('span')
    meta.className = 'vendor'
    meta.textContent = `${device.vendor}${device.hasMemory ? '' : ' · 无内存配置'}`
    item.append(name, meta)
    // mousedown, not click: the input's blur would hide the menu first.
    item.onmousedown = (event) => {
      event.preventDefault()
      selectDevice(device.name)
    }
    menu.append(item)
  }
  // Say so when the list is truncated — the count sits on top (sticky) so it is
  // visible before scrolling, not only after the last row.
  if (total > devices.length) {
    const more = document.createElement('div')
    more.className = 'item more'
    more.textContent = query.trim()
      ? `共 ${total} 个匹配，这里显示前 ${devices.length} 个 —— 继续输入可缩小范围`
      : `共 ${total} 个器件，这里显示前 ${devices.length} 个 —— 输入型号可筛选`
    menu.prepend(more)
  }
  menu.classList.remove('hidden')
  positionDeviceMenu()
}

/** Load one device's real parameters and show them under the field. */
async function selectDevice(name) {
  const input = $('np-device')
  input.value = name
  $('np-device-menu').classList.add('hidden')
  const info = $('np-device-info')
  if (info) info.textContent = `正在读取 ${name} 的参数…`
  const data = await api(`/api/device?name=${encodeURIComponent(name)}`).catch((error) => ({ error: error.message }))
  if (data.error) {
    npDevice = null
    if (info) info.textContent = `读取失败：${data.error}`
    return
  }
  npDevice = data.device
  const project = data.project || {}
  const memory = project.iramSize
    ? `ROM ${project.iromSize || '0x0'} / RAM ${project.iramSize}`
    : '库中没有内存配置（将沿用默认值）'
  const description = String(data.device.description ?? '').replace(/\s+/g, ' ').slice(0, 120)
  if (info) {
    info.textContent = [
      `${data.device.vendor} · ${memory} · 头文件 ${project.registerFile || '(无)'}`,
      description,
    ]
      .filter(Boolean)
      .join(' — ')
  }
}

/** The 新建工程 dialog. */
function openNewProject() {
  const currentDir = state.info?.projectDir ?? ''
  $('np-dir').value = currentDir.replace(/[\\/][^\\/]*$/, '')
  $('np-name').value = 'led'
  $('np-device').value = 'AT89C51'
  $('np-status').textContent = ''
  npDevice = null
  $('new-project').classList.remove('hidden')
  ensureDeviceLibrary().then(() => {
    if (deviceLibrary?.devices.some((device) => device.name === 'AT89C51')) selectDevice('AT89C51')
    else renderDeviceMenu()
  })
}

async function createNewProject() {
  const dir = $('np-dir').value.trim()
  const name = $('np-name').value.trim()
  if (!dir || !name) {
    $('np-status').textContent = '文件夹和工程名都要填'
    return
  }
  $('np-status').textContent = '创建中…'
  const typed = $('np-device').value.trim() || 'AT89C51'
  // Only trust the picked device when the input still shows it; typing after a
  // pick must not silently keep the previous chip's memory map.
  const chosen = npDevice && npDevice.name.toLowerCase() === typed.toLowerCase() ? npDevice : null
  const device = chosen
    ? {
        device: chosen.name,
        vendor: chosen.vendor,
        cpu: chosen.cpu,
        registerFile: chosen.registerFile,
        iromSize: chosen.iromSize || '0x0',
        iramSize: chosen.iramSize,
        xramSize: chosen.xramSize || '0x0',
      }
    : { device: typed }
  const data = await post('/api/project/new', { dir, name, device }).catch((error) => ({ error: error.message }))
  if (data.error) {
    $('np-status').textContent = `失败: ${data.error}`
    return
  }
  await post('/api/settings', { project: data.project, recent: [...new Set([data.project, ...(state.settings.recent ?? [])])] })
  $('new-project').classList.add('hidden')
  await refreshProjectSelect()
  await loadProject(data.project)
  startSync()
  appendMessage(
    'ai',
    '新建工程完成',
    [
      data.project,
      `器件: ${data.device.device}（${data.device.vendor}）`,
      data.memorySource === 'library' || data.memorySource === 'request'
        ? `内存: ROM ${data.device.iromSize} / RAM ${data.device.iramSize}（取自器件库）`
        : '',
      data.libraryNote ? `⚠ ${data.libraryNote}` : '',
      `生成: ${data.library.join(', ')}`,
      data.startup ? `STARTUP.A51 取自: ${data.startupSource}` : '（本机没找到 STARTUP.A51，未加入工程）',
      '',
      '现在可以直接点"编译"。',
    ]
      .filter(Boolean)
      .join('\n'),
  )
}

/* ---------- multi-project workspace (.uvmpw) ---------- */

/** Fill the workspace dropdown from settings (current + recent). */
async function refreshWorkspaceSelect() {
  const settings = await api('/api/settings').catch(() => null)
  if (settings) state.settings = { ...state.settings, ...settings }
  const select = $('workspace')
  if (!select) return
  const options = [...new Set([state.settings.workspace, ...(state.settings.recentWorkspaces || [])])].filter(Boolean)
  select.textContent = ''
  const none = document.createElement('option')
  none.value = ''
  none.textContent = '（单工程模式）'
  select.appendChild(none)
  for (const workspace of options) {
    const option = document.createElement('option')
    option.value = workspace
    option.textContent = workspace
    select.appendChild(option)
  }
  select.value = state.settings.workspace ?? ''
}

/** Render the workspace's member projects above the file tree. */
async function loadWorkspace() {
  const host = $('workspace-list')
  if (!host) return
  const data = await api(`/api/workspace?file=${encodeURIComponent(state.settings.workspace ?? '')}`).catch(() => null)
  state.workspace = data?.ok && data.workspace ? data : null
  if (!state.workspace) {
    host.classList.add('hidden')
    host.textContent = ''
    return
  }
  host.classList.remove('hidden')
  host.textContent = ''
  for (const member of data.projects) {
    const row = document.createElement('div')
    row.className = `row${member.isCurrent ? ' current' : ''}`
    row.title = [
      member.absPath,
      `器件: ${member.device || '?'}`,
      member.selectedForBatchBuild ? '已参与 µVision 的批量编译' : '未参与 µVision 的批量编译（可用下面的按钮一键打开）',
    ].join('\n')
    const label = document.createElement('span')
    label.className = 'name'
    label.textContent = `${member.active ? '▶' : '·'} ${member.name}${member.exists ? '' : '（文件不存在）'}`
    row.appendChild(label)
    if (!member.exists) {
      const warn = document.createElement('span')
      warn.className = 'bad'
      warn.textContent = '缺失'
      row.appendChild(warn)
    }
    const remove = document.createElement('button')
    remove.className = 'tiny'
    remove.textContent = '移出'
    remove.onclick = async (event) => {
      event.stopPropagation()
      await workspaceRemove(member.absPath)
    }
    row.appendChild(remove)
    row.onclick = async () => {
      await post('/api/settings', { project: member.absPath })
      state.settings.project = member.absPath
      await refreshProjectSelect()
      await loadProject(member.absPath)
      startSync()
      await loadWorkspace()
    }
    host.appendChild(row)
  }
  const actions = document.createElement('div')
  actions.className = 'row'
  const add = document.createElement('button')
  add.className = 'tiny'
  add.textContent = '+ 当前工程'
  add.title = '把当前打开的工程加进这个工作区'
  add.onclick = async () => {
    const added = await post('/api/workspace/add', {
      file: state.settings.workspace,
      project: state.settings.project,
    }).catch((error) => ({ error: error.message }))
    appendMessage(added.error ? 'err' : 'ai', '加入工作区', added.error ?? `已加入${added.backup ? `（工作区文件已备份）` : ''}`)
    await loadWorkspace()
  }
  actions.appendChild(add)
  const allow = document.createElement('button')
  allow.className = 'tiny'
  allow.textContent = '🔧 参与批量编译'
  allow.title = '把每个工程里的 SelectedForBatchBuild 改成 1，这样 µVision 自己的 Batch Build 也会编译它们（改前备份 .uvproj）'
  allow.onclick = async () => {
    const done = await post('/api/workspace/allow-batch', { file: state.settings.workspace }).catch((error) => ({ error: error.message }))
    appendMessage(done.error ? 'err' : 'ai', '批量编译开关', done.error ?? `已修改 ${done.count} 个工程（改过的都在 .backups 里）`)
    await loadWorkspace()
  }
  actions.appendChild(allow)
  host.appendChild(actions)
}

/** Open a `.uvmpw` through the native dialog. */
async function openWorkspace() {
  const data = await post('/api/pick-workspace', {}).catch((error) => ({ error: error.message }))
  if (data.error) {
    appendMessage('err', '打开工作区', data.error)
    return
  }
  if (data.canceled) return
  state.settings.workspace = data.workspace
  state.settings.recentWorkspaces = data.recentWorkspaces ?? state.settings.recentWorkspaces
  await refreshWorkspaceSelect()
  await loadWorkspace()
  appendMessage('ai', '已打开工作区', data.workspace)
}

/** Create a workspace in a chosen folder, with the current project as member #1. */
async function newWorkspace() {
  const dir = await post('/api/pick-folder', {
    title: '选择工作区文件夹',
    defaultPath: state.info?.projectDir ?? '',
  }).catch((error) => ({ error: error.message }))
  if (dir.error) {
    appendMessage('err', '新建工作区', dir.error)
    return
  }
  if (!dir.path) return
  const name = await askText({
    title: '新建工作区',
    label: '工作区名',
    value: 'workspace',
    hint: '会生成 <名字>.uvmpw（µVision 的多工程工作区），并把当前工程作为第一个成员',
  })
  if (!name) return
  const data = await post('/api/workspace/new', {
    dir: dir.path,
    name,
    projects: state.settings.project ? [state.settings.project] : [],
  }).catch((error) => ({ error: error.message }))
  if (data.error) {
    appendMessage('err', '新建工作区失败', data.error)
    return
  }
  state.settings.workspace = data.workspace
  await refreshWorkspaceSelect()
  await loadWorkspace()
  appendMessage('ai', '新建工作区', `${data.workspace}\n成员: ${data.projects} 个`)
}

/** Build every member that is checked for batch build, in order. */
async function buildWorkspace() {
  if (!state.settings.workspace) {
    appendMessage('err', '全部编译', '还没有打开工作区')
    return
  }
  appendMessage('ai', '全部编译', '按顺序编译工作区里的工程…')
  const data = await post('/api/workspace/build', { file: state.settings.workspace }).catch((error) => ({ error: error.message }))
  if (data.error) {
    appendMessage('err', '全部编译失败', data.error)
    return
  }
  const lines = data.results.map((result) =>
    result.skipped
      ? `跳过 ${result.name}: ${result.reason}`
      : `${result.status === 'ok' ? '✔' : '✘'} ${result.name}: ${result.status}，错误 ${result.errors ?? 0}，警告 ${result.warnings ?? 0}${result.hex?.exists ? `，hex ${result.hex.bytes} 字节` : ''}`,
  )
  const ok = data.results.filter((result) => !result.skipped && result.status === 'ok').length
  appendMessage(data.failed ? 'err' : 'ai', `全部编译完成（成功 ${ok} / 失败 ${data.failed}）`, lines.join('\n'))
  await loadProject(state.settings.project, { keepFile: true })
  renderChips()
}

/** Drop one project from the workspace. */
async function workspaceRemove(project) {
  const data = await post('/api/workspace/remove', { file: state.settings.workspace, project }).catch((error) => ({
    error: error.message,
  }))
  appendMessage(data.error ? 'err' : 'ai', '移出工作区', data.error ?? `已移出${data.backup ? '（工作区文件已备份）' : ''}`)
  await loadWorkspace()
}

/* ---------- boot ---------- */

async function boot() {
  await startMonaco()
  const settings = await api('/api/settings')
  state.settings = settings
  state.ai = settings.ai
  applyEditorSettings()
  renderAiChip(settings.ai)
  renderInlineChip()
  const select = $('project')
  await refreshProjectSelect()
  await refreshWorkspaceSelect()
  await loadWorkspace()
  select.onchange = async () => {
    await post('/api/settings', { project: select.value, recent: [...new Set([select.value, ...(state.settings.recent ?? [])])] })
    state.settings.project = select.value
    await loadProject(select.value)
    startSync()
  }

  $('btn-build').onclick = () => build('build')
  $('btn-rebuild').onclick = () => build('rebuild')
  $('btn-send').onclick = send
  $('skill').onchange = renderSkillHint
  // Preset prompts: re-read when the user reaches for the menu (the files are
  // external, so they may have been edited a second ago).
  $('preset').onchange = applyPreset
  $('preset').onfocus = () => loadPresets()
  $('btn-prompts-load').onclick = loadPresetsSource
  $('btn-prompts-save').onclick = savePresetsSource
  $('btn-prompts-ensure').onclick = async () => {
    const data = await post('/api/prompts/ensure', {}).catch((error) => ({ error: error.message }))
    $('settings-status').textContent = data.error ? `失败: ${data.error}` : `${data.created ? '已生成' : '已存在'}: ${data.path}`
    await loadPresetsSource()
    await refreshPresetsAdmin()
    await loadPresets()
  }
  $('btn-prompts-reload').onclick = async () => {
    await refreshPresetsAdmin()
    await loadPresets()
    $('settings-status').textContent = '已重新读取预设'
  }
  $('btn-prompts-reveal').onclick = async () => {
    const which = $('presets-which').value
    const data = await api(
      `/api/prompts/source?which=${encodeURIComponent(which)}&project=${encodeURIComponent(state.settings.project ?? '')}`,
    ).catch(() => null)
    revealPath(data?.path ? data.path.replace(/[\\/][^\\/]*$/, '') : '', '预设文件夹')
  }
  // Poor-man's watcher: DSH invalidates its catalog via chokidar, we simply re-list
  // when the user reaches for the menu, so a newly added skill shows up immediately.
  $('skill').onfocus = () => {
    loadSkills()
  }
  $('btn-apply').onclick = previewOrApply
  $('btn-diff-apply').onclick = applyDiff
  $('btn-diff-close').onclick = closeDiff
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeDiff()
  })
  $('btn-reveal').onclick = async () => {
    // The server reports what it actually opened: the hex may not exist yet, in
    // which case it opens the folder that will contain it.
    const data = await post('/api/reveal', { path: state.hex?.path || state.info?.objectsDir }).catch((error) => ({
      error: error.message,
    }))
    if (data.error) {
      appendMessage('err', '打开文件夹', data.error)
      return
    }
    appendMessage(
      'ai',
      '打开文件夹',
      `${data.kind === 'directory' ? '已打开文件夹' : '已在文件夹里选中'}: ${data.revealed}` +
        (state.hex?.exists ? '' : '\n（hex 还没生成，所以先打开它所在的文件夹）'),
    )
  }
  $('btn-settings').onclick = openSettings
  // File / project commands (the parts of the IDE menus that make sense here).
  $('btn-new-file').onclick = newFile
  $('btn-open-file').onclick = openPickedFile
  $('btn-new-project').onclick = openNewProject
  $('btn-open-project').onclick = openProject
  $('btn-new-project-close').onclick = () => {
    $('new-project').classList.add('hidden')
    $('np-device-menu').classList.add('hidden')
  }
  $('btn-new-project-create').onclick = createNewProject
  $('np-device').addEventListener('input', () => {
    npDevice = null
    if (deviceLibrary) renderDeviceMenu()
    else ensureDeviceLibrary().then(renderDeviceMenu)
  })
  $('np-device').addEventListener('focus', () => {
    if (deviceLibrary) renderDeviceMenu()
    else ensureDeviceLibrary().then(renderDeviceMenu)
  })
  $('np-device').addEventListener('blur', () => {
    // mousedown on an item prevents the default, so this delay only covers focus
    // moving away by keyboard/tab.
    setTimeout(() => $('np-device-menu').classList.add('hidden'), 150)
  })
  $('np-device').addEventListener('keydown', (event) => {
    const menu = $('np-device-menu')
    if (event.key === 'Escape') menu.classList.add('hidden')
    if (event.key === 'Enter' && !menu.classList.contains('hidden')) {
      const first = menu.querySelector('.item[data-name]')
      if (first) {
        event.preventDefault()
        selectDevice(first.dataset.name)
      }
    }
  })
  // The list is fixed-positioned against the input, so it must follow layout changes.
  window.addEventListener('resize', positionDeviceMenu)
  window.addEventListener(
    'scroll',
    () => {
      const menu = $('np-device-menu')
      if (menu && !menu.classList.contains('hidden')) positionDeviceMenu()
    },
    true,
  )
  // Multi-project workspace (`.uvmpw`).
  $('btn-open-workspace').onclick = openWorkspace
  $('btn-new-workspace').onclick = newWorkspace
  $('btn-build-workspace').onclick = buildWorkspace
  $('workspace').onchange = async () => {
    const value = $('workspace').value
    await post('/api/settings', { workspace: value })
    state.settings.workspace = value
    await loadWorkspace()
  }
  $('btn-np-pick-dir').onclick = async () => {
    const result = await post('/api/pick-folder', {
      title: '选择工程文件夹',
      defaultPath: $('np-dir').value.trim() || state.info?.projectDir || '',
    }).catch((error) => ({ ok: false, error: error.message }))
    if (result.ok) $('np-dir').value = result.path
    else $('np-status').textContent = result.error
  }
  $('btn-settings-save').onclick = saveSettings
  $('btn-settings-close').onclick = () => $('settings').classList.add('hidden')
  $('btn-ai-test').onclick = testAi
  $('btn-ai-clear').onclick = clearAiKey
  $('btn-fetch-models').onclick = () => fetchModels()
  // The dropdown only helps pick a name; the text field stays the source of truth.
  $('ai-model-select').onchange = () => {
    const chosen = $('ai-model-select').value
    if (chosen) $('ai-model').value = chosen
  }
  $('btn-pick-backup-dir').onclick = async () => {
    const result = await post('/api/pick-folder', {
      title: '选择备份文件夹',
      defaultPath: $('backup-dir').value.trim() || state.info?.projectDir || '',
    }).catch((error) => ({ ok: false, error: error.message }))
    if (result.ok) {
      $('backup-dir').value = result.path
      $('settings-status').textContent = `备份文件夹已选好：${result.path}（记得点"保存全部设置"）`
    } else {
      $('settings-status').textContent = result.error
    }
  }
  $('btn-open-backup-dir').onclick = () => {
    const fallback = `${(state.info?.projectDir ?? '').replace(/[\\/]+$/, '')}\\.backups`
    revealPath($('backup-dir').value.trim() || fallback, '备份文件夹')
  }
  $('sync-chip').onclick = () => {
    if (!syncState.conflict || !state.current) return
    if (!confirm(`放弃你在这个窗口里的修改，重新读磁盘上的版本？\n\n${state.current.path}`)) return
    syncState.conflict = false
    openFileByPath(state.current.path)
  }
  for (const tab of document.querySelectorAll('.settings-tabs .tab')) {
    tab.onclick = () => showSettingsTab(tab.dataset.tab)
  }
  $('btn-reload-skills').onclick = refreshSkillsAdmin
  $('btn-install-skill').onclick = installSkillFromForm
  $('btn-open-skills-dir').onclick = () => {
    const roots = state.skillRoots ?? []
    const root = roots.find((item) => item.source === 'project-ide') ?? roots.find((item) => item.rank <= 400) ?? roots[0]
    revealPath(root?.dir, '技能目录')
  }
  $('btn-open-settings-file').onclick = () => revealPath($('about-settings-file').value, '设置文件')
  $('btn-copy-doctor').onclick = async () => {
    const text = [$('about-doctor').textContent, $('about-settings-file').value].join('\n')
    await navigator.clipboard?.writeText(text).catch(() => {})
    $('settings-status').textContent = '诊断信息已复制'
  }

  api('/api/doctor')
    .then((doctor) => {
      const chip = $('toolchain-chip')
      chip.textContent = doctor.uv4Path
        ? `编译器: ${doctor.c51Version}（${toolchainSourceNote(doctor.uv4Source)}）`
        : '编译器: 没找到（看"设置 → 诊断"）'
      chip.className = `chip ${doctor.uv4Path ? '' : 'bad'}`
      chip.title = doctor.uv4Path || doctor.tried.join('\n')
    })
    .catch(() => {
      $('toolchain-chip').textContent = '编译器: 检查失败'
    })

  await loadProject(settings.project)
  await refreshTokens()
  await loadPresets()
  startSync()
}

boot().catch((error) => appendMessage('err', '启动失败', error.message))
