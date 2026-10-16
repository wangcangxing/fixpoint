/**
 * Skill registry for keil-ide, modelled on DeepSeek Harness's skill subsystem
 * (`packages/skill/*`): the parts worth having without a plugin framework.
 *
 * Faithful to that design:
 *   - a skill name is kebab-case (`^[a-z0-9]+(?:-[a-z0-9]+)*$`);
 *   - two shapes are accepted: a bundle `<dir>/<name>/SKILL.md`, or a flat
 *     `<dir>/<name>.md` / `<name>.prompt`. There is NO recursive `**\/SKILL.md`
 *     discovery — one level only, so a stray vendor tree cannot inject skills;
 *   - roots are ranked; a lower rank wins a duplicate name outright, and rank
 *     only arbitrates inside the merged list (the `source` label itself is
 *     prompt-visible metadata, not precedence);
 *   - every skill carries an invocation policy normalised to two positive
 *     booleans from the frontmatter keys `disable-model-invocation` and
 *     `user-invocable` (missing = true). Consumers apply the policy at their own
 *     boundary: the UI picker is the human surface, auto-selection is the model
 *     surface;
 *   - summaries only carry `name` + `description` (+ optional `whenToUse`); the
 *     body is read fresh on every load, never cached, so editing a skill takes
 *     effect on the next use;
 *   - discovery reports `complete`: a read error makes the observation transient,
 *     and callers should keep their last good catalog instead of blanking out.
 *
 * @module keil-skills
 */

/** Skill names are kebab-case, exactly as the DSH registry requires. */
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Description budget for catalogs (DSH default is 500). */
export const DEFAULT_DESCRIPTION_MAX_LENGTH = 500

/** Ranks of the roots this IDE scans. Lower wins a duplicate name. */
export const SKILL_ROOT_RANKS = {
  'project-ide': 100, // <project>/.keil-ide/skills   — this IDE's own location
  'project-dsh': 150, // <project>/.dsh/skills        — shared with the DSH agent
  'project-agents': 200, // <project>/.agents/skills   — shared agent conventions
  custom: 300, // configured extra directories
  'user-ide': 400, // ~/.keil-ai/skills
  'user-dsh': 450, // <dshHome>/skills             — shared user level
  bundled: 600, // <app>/skills                    — shipped with the IDE
}

/**
 * Parse one skill file: frontmatter (`name`, `description`, `when-to-use`/
 * `whenToUse`, `disable-model-invocation`, `user-invocable`) plus a markdown body
 * that may contain a `<system>…</system>` section, the same shape Continue's
 * `parsePromptFile.ts` accepts.
 */
export function parseSkill(text, options = {}) {
  const {
    fileName = 'skill.md',
    rank = SKILL_ROOT_RANKS['user-ide'],
    source = 'user-ide',
    provider = 'filesystem',
    path = '',
    descriptionMaxLength = DEFAULT_DESCRIPTION_MAX_LENGTH,
  } = options

  const raw = String(text ?? '')
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
  const frontRaw = match ? match[1] : ''
  let body = (match ? match[2] : raw).trim()

  const meta = {}
  for (const line of frontRaw.split(/\r?\n/)) {
    const entry = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (entry) meta[entry[1].toLowerCase()] = entry[2].trim().replace(/^["']|["']$/g, '')
  }

  let system = ''
  const systemMatch = /<system>([\s\S]*?)<\/system>/.exec(body)
  if (systemMatch) {
    system = systemMatch[1].trim()
    body = body.replace(systemMatch[0], '').trim()
  }

  const fallback = fileName.replace(/\.(md|prompt)$/i, '')
  const name = (meta.name || fallback).trim()
  const description = (meta.description || meta.name || fallback).trim().slice(0, descriptionMaxLength)

  return {
    name,
    description,
    whenToUse: (meta['when-to-use'] || meta.whentouse || meta.whenToUse || '').trim(),
    // Two positive booleans, so callers never have to read frontmatter themselves.
    invocation: {
      modelInvocable: meta['disable-model-invocation'] !== 'true',
      userInvocable: meta['user-invocable'] !== 'false',
    },
    system,
    content: body,
    rank,
    source,
    provider,
    path,
    bytes: Buffer.byteLength(raw),
  }
}

/** Is this a skill this caller may use? */
export function isModelInvocable(skill) {
  return Boolean(skill?.invocation?.modelInvocable)
}

export function isUserInvocable(skill) {
  return Boolean(skill?.invocation?.userInvocable)
}

/** Keep only the fields a catalog is allowed to expose (no body, no system). */
export function toSummary(skill) {
  const { name, description, whenToUse, rank, source, provider, path, bytes, invocation } = skill
  return { name, description, whenToUse, rank, source, provider, path, bytes, invocation }
}

/** Walk up from `start` to the nearest ancestor holding `.git` (DSH's project root). */
export async function findProjectRoot(start, maxWalk = 8) {
  const { stat } = await import('node:fs/promises')
  const { dirname, join, resolve } = await import('node:path')
  let current = resolve(start)
  for (let depth = 0; depth <= maxWalk; depth += 1) {
    const marker = await stat(join(current, '.git')).catch(() => undefined)
    if (marker) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return resolve(start)
}

/**
 * Discover skills from every root, in rank order, first match winning a name.
 * @returns {Promise<{skills: object[], complete: boolean, problems: string[], roots: {dir: string, rank: number, source: string}[]}>}
 */
export async function listSkills(options = {}) {
  const { readdir, readFile } = await import('node:fs/promises')
  const { homedir } = await import('node:os')
  const { basename, join } = await import('node:path')
  const {
    projectRoot = '',
    // Exact directory of the shipped skills, like DSH's `bundledSkillDir`
    // (NOT an app root that we would append "/skills" to).
    bundledDir = '',
    home = homedir(),
    dshHome = join(homedir(), '.dsh'),
    customDirs = [],
    descriptionMaxLength = DEFAULT_DESCRIPTION_MAX_LENGTH,
    // OPT-IN sharing with other agents. Default OFF: this IDE keeps its own skill
    // table, and skills arrive through an explicit install step
    // (see keil-skill-install.mjs) rather than by scanning `.dsh`/`.agents`.
    includeSharedRoots = false,
  } = options

  const roots = []
  const addRoot = (dir, source) => {
    if (dir && !roots.some((root) => root.dir === dir)) roots.push({ dir, source, rank: SKILL_ROOT_RANKS[source] ?? 999 })
  }
  if (projectRoot) {
    addRoot(join(projectRoot, '.keil-ide', 'skills'), 'project-ide')
    if (includeSharedRoots) addRoot(join(projectRoot, '.dsh', 'skills'), 'project-dsh')
    if (includeSharedRoots) addRoot(join(projectRoot, '.agents', 'skills'), 'project-agents')
  }
  for (const dir of customDirs) addRoot(dir, 'custom')
  addRoot(join(home, '.keil-ai', 'skills'), 'user-ide')
  if (includeSharedRoots) addRoot(join(dshHome, 'skills'), 'user-dsh')
  addRoot(bundledDir, 'bundled')
  roots.sort((left, right) => left.rank - right.rank)

  const found = new Map()
  const problems = []
  let complete = true

  /** A missing root is normal; a real read failure makes the observation transient. */
  const readDirSafe = async (dir) => {
    try {
      return await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (error.code !== 'ENOENT') {
        problems.push(`${dir}: 读取目录失败 ${error.message}`)
        complete = false
      }
      return []
    }
  }

  for (const root of roots) {
    const entries = await readDirSafe(root.dir)
    for (const entry of entries) {
      let file = ''
      let fileName = ''
      if (entry.isDirectory()) {
        // Bundle form: <dir>/<name>/SKILL.md — exactly one level, no recursion.
        if (entry.name.startsWith('.')) continue
        file = join(root.dir, entry.name, 'SKILL.md')
        fileName = 'SKILL.md'
        const exists = await readFile(file, 'utf8').then(() => true).catch(() => false)
        if (!exists) continue
      } else if (entry.isFile() && /\.(md|prompt)$/i.test(entry.name)) {
        file = join(root.dir, entry.name)
        fileName = entry.name
      } else {
        continue
      }

      const text = await readFile(file, 'utf8').catch((error) => {
        problems.push(`${basename(file)}: 读取失败 ${error.message}`)
        complete = false // transient: callers should keep their last good catalog
        return ''
      })
      if (!text) continue

      const skill = parseSkill(text, {
        fileName: entry.isDirectory() ? `${entry.name}.md` : fileName,
        rank: root.rank,
        source: root.source,
        path: file,
        descriptionMaxLength,
      })
      if (!SKILL_NAME_RE.test(skill.name)) {
        problems.push(`${basename(file)}: 技能名 "${skill.name}" 不是 kebab-case（^[a-z0-9]+(-[a-z0-9]+)*$），已跳过`)
        continue
      }
      const key = skill.name.toLowerCase()
      if (found.has(key)) continue // a lower rank already won this name
      found.set(key, skill)
    }
  }

  const skills = [...found.values()].sort((left, right) => left.name.localeCompare(right.name))
  return { skills, complete, problems, roots }
}

/**
 * Load one skill's body fresh (never cached).
 *
 * Two shapes, mirroring DSH's `get(candidate)`:
 *   - `{ candidate }` — a summary from an earlier `listSkills()`. Its locator is
 *     used directly, so a body renamed since that discovery is reported as 409
 *     instead of silently loading the wrong thing.
 *   - name only — discovery runs again, so a renamed skill simply disappears (404).
 */
export async function loadSkill(name, options = {}) {
  const { readFile } = await import('node:fs/promises')
  const wanted = String(name ?? '').trim().toLowerCase()
  let summary = options.candidate
  if (!summary) {
    const { skills } = await listSkills(options)
    summary = skills.find((skill) => skill.name.toLowerCase() === wanted)
    if (!summary) return { error: `找不到技能: ${name}`, code: 404 }
  }
  const text = await readFile(summary.path, 'utf8').catch((error) => ({ error: error.message }))
  if (typeof text !== 'string') return { error: `读取技能失败: ${text.error}`, code: 500 }
  const fresh = parseSkill(text, {
    fileName: summary.path.split(/[\\/]/).pop() || 'skill.md',
    rank: summary.rank,
    source: summary.source,
    path: summary.path,
    descriptionMaxLength: options.descriptionMaxLength,
  })
  // The body may have been renamed or rewritten while the catalog was held.
  if (fresh.name.toLowerCase() !== wanted) {
    return { error: `技能 ${name} 已变更（当前文件里的 name 是 "${fresh.name}"），请刷新技能列表`, code: 409 }
  }
  return { skill: fresh }
}

/**
 * Render the block injected into a chat request: the body plus, at load time only,
 * where the skill lives so relative resources can be resolved (`resourceBase`).
 */
export function renderSkillBlock(skill) {
  const escape = (value) => String(value ?? '').replace(/[<>&]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[char])
  const dir = skill.path ? skill.path.replace(/[\\/][^\\/]*$/, '') : ''
  return [
    `<skill_content name="${escape(skill.name)}">`,
    escape(skill.description),
    skill.whenToUse ? `适用场景: ${escape(skill.whenToUse)}` : '',
    skill.system,
    skill.content,
    '</skill_content>',
    dir ? `<skill_resources>${dir}</skill_resources>` : '',
  ]
    .filter(Boolean)
    .join('\n')
}
