/**
 * Silent skill injection for Fixpoint's chat surface.
 *
 * The rule this module exists for: a skill is chosen for the user's message and
 * prepended to what the MODEL receives — the composer must only ever hold the
 * user's own words. So the two jobs live here, away from HTTP and the DOM:
 *
 *   pickAutoSkill() / scoreSkill()   which skill (if any) fits this message
 *   composeUserContent()             where the block goes (head of the user turn)
 *
 * Matching is deliberately conservative. A skill's own author names the words a
 * user would say (quoted terms in the description), and those weigh most; name
 * parts next; code-ish tokens (`TMOD`, `C202`, `reg51.h`) next; Chinese bigrams
 * least. A tie or a score under the floor injects NOTHING — a wrong skill is
 * worse than no skill, and the picker is always available for a manual override.
 *
 * @module keil-skill-inject
 */

/** Below this score nothing is injected. Two weak bigram hits are not a match. */
export const AUTO_INJECT_MIN_SCORE = 3

const ASCII_TOKEN_RE = /[a-z_][a-z0-9_+.#]{1,}/g
const CJK_RUN_RE = /[\u4e00-\u9fff]{2,}/g
/** Straight and CJK quotes: a skill author's way of naming user trigger words. */
const QUOTED_RE = /["“”「『]([^"“”」』\n]{1,16})["“”」』]/g

/** Where each kind of evidence sits in the budget. */
export const KEYWORD_WEIGHTS = {
  name: 6, // the whole skill name, e.g. `8051-timer`
  quoted: 5, // "定时" — the author's own trigger word
  namePart: 4, // `timer`
  token: 3, // TMOD / C202 / reg51.h
  run: 2, // a whole short Chinese phrase ("初值计算")
  bigram: 1, // "定时" inside "的定时器与中断"
}

/**
 * English words that carry no topic. Chinese needs none: bigrams are already weak.
 * Kept small on purpose — the weight table, not this list, does the filtering.
 */
const ASCII_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'do', 'does', 'for', 'from',
  'in', 'into', 'is', 'it', 'its', 'not', 'of', 'on', 'or', 'so', 'than', 'that',
  'the', 'then', 'this', 'to', 'use', 'using', 'was', 'when', 'which', 'with',
])

/**
 * Every term a skill can be recognised by, deduplicated, highest weight winning.
 * @returns {{term: string, weight: number}[]}
 */
export function skillKeywords(skill) {
  const table = new Map()
  const add = (raw, weight) => {
    const term = String(raw ?? '').trim().toLowerCase()
    if (term.length < 2) return
    if (weight > (table.get(term) ?? 0)) table.set(term, weight)
  }

  const name = String(skill?.name ?? '').toLowerCase()
  if (name) {
    add(name, KEYWORD_WEIGHTS.name)
    for (const part of name.split(/[-_./]/)) add(part, KEYWORD_WEIGHTS.namePart)
  }

  const prose = [skill?.description, skill?.whenToUse].filter(Boolean).join('\n')
  for (const match of prose.matchAll(QUOTED_RE)) add(match[1], KEYWORD_WEIGHTS.quoted)
  for (const token of prose.toLowerCase().match(ASCII_TOKEN_RE) ?? []) {
    if (ASCII_STOPWORDS.has(token)) continue
    add(token, KEYWORD_WEIGHTS.token)
  }
  for (const run of prose.match(CJK_RUN_RE) ?? []) {
    if (run.length <= 4) add(run, KEYWORD_WEIGHTS.run)
    // Bigrams catch 定时 inside 的定时器与中断 without shipping a word segmenter.
    for (let index = 0; index + 2 <= run.length; index += 1) add(run.slice(index, index + 2), KEYWORD_WEIGHTS.bigram)
  }

  return [...table].map(([term, weight]) => ({ term, weight }))
}

/**
 * How well one skill fits a message.
 * @returns {{score: number, hits: string[]}} `hits` is for tests and diagnostics.
 */
export function scoreSkill(skill, text) {
  const haystack = String(text ?? '').toLowerCase()
  if (!haystack.trim()) return { score: 0, hits: [] }
  let score = 0
  const hits = []
  for (const { term, weight } of skillKeywords(skill)) {
    if (!haystack.includes(term)) continue
    score += weight
    hits.push(term)
  }
  return { score, hits }
}

/**
 * Pick the single best skill for a message.
 *
 * Only skills whose invocation policy allows model-side selection are eligible
 * (a human-picked one is handled by the caller). A tie at the top means the text
 * fitted several skills equally well — inject none rather than guess.
 *
 * @returns {{skill: object, score: number, hits: string[]} | null}
 */
export function pickAutoSkill(skills, text, options = {}) {
  const {
    minScore = AUTO_INJECT_MIN_SCORE,
    isEligible = (skill) => skill?.invocation?.modelInvocable !== false,
  } = options
  const list = Array.isArray(skills) ? skills : []
  let best = { skill: null, score: 0, hits: [] }
  let runnerUp = 0
  for (const skill of list) {
    if (!isEligible(skill)) continue
    const { score, hits } = scoreSkill(skill, text)
    if (score > best.score) {
      runnerUp = best.score
      best = { skill, score, hits }
    } else if (score > runnerUp) {
      runnerUp = score
    }
  }
  if (!best.skill || best.score < minScore || best.score === runnerUp) return null
  return best
}

/**
 * Assemble the user turn: the skill block FIRST (the model reads it before the
 * request it qualifies), then the injected project/device context, then the
 * user's own words verbatim. Empty parts never leave blank gaps.
 */
export function composeUserContent({ skillBlock = '', context = '', prompt = '' } = {}) {
  return [skillBlock, context, prompt]
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
    .join('\n\n')
}
