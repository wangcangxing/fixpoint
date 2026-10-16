/**
 * Completion shaping for inline (ghost text) suggestions.
 *
 * Kept separate from the HTTP host so it can be unit-tested without a browser,
 * and so other hosts (the MCP server, the DSH plugin) can reuse it.
 *
 * The rules below were ported from Continue's real implementation
 * (`E:\continue-main\core\autocomplete\…`, `@continuedev/core` 1.1.0, Apache-2.0),
 * which is where the hard-won details live:
 *
 *   filtering/streamTransforms/lineStream.ts  `lineIsRepeated` (fuzzy, Levenshtein)
 *   postprocessing/index.ts                   rejections + model quirks + fences
 *   classification/shouldCompleteMultiline.ts comment lines never go multi-line
 *   templating/getStopTokens.ts               commonStops (incl. ``` fences)
 *   util/AutocompleteLruCache.ts              prefix-keyed cache, longest match
 *
 * A raw FIM answer is never inserted verbatim:
 *   1. blank / whitespace-only / looping / "rewrites the line above" → reject,
 *   2. reasoning tags (`<think>`) and markdown fences are stripped,
 *   3. a single-line request must not smuggle in extra lines,
 *   4. the answer usually overlaps the code AFTER the cursor (`}` would double),
 *   5. trailing blank lines look like a broken edit.
 *
 * @module keil-completion
 */

/** Stop sequences shipped as defaults (Continue's `commonStops` + our blank line). */
export const DEFAULT_STOPS = ['\n\n', '```', '/src/', '#- coding: utf-8']

/**
 * `auto` = multi-line only where it is safe:
 *   - a single-line comment gets one line (Continue does the same for C's `//`),
 *   - otherwise the cursor must be at the end of the line, so a mid-line cursor
 *     never has a whole block stuffed into it.
 * (Continue additionally allows multi-line mid-line — their `isMidlineCompletion`
 *  check is commented out in `shouldCompleteMultiline.ts`. We stay stricter.)
 */
export function decideMultiline(mode, lines = {}) {
  if (mode === 'always') return true
  if (mode === 'never') return false
  const { lineBefore = '', lineAfter = '' } = lines
  if (/^[ \t]*\/\//.test(String(lineBefore))) return false
  return /^[ \t]*$/.test(String(lineAfter))
}

/** Rough token estimate: code averages ~4 characters per token. */
export function estimateTokens(text) {
  return Math.ceil(String(text ?? '').length / 4)
}

/** Keep the part of `text` nearest the cursor within a token budget. */
export function truncateByTokens(text, budgetTokens, fromEnd) {
  const source = String(text ?? '')
  const maxChars = Math.max(0, Math.floor(budgetTokens * 4))
  if (source.length <= maxChars) return { text: source, truncated: false }
  return { text: fromEnd ? source.slice(-maxChars) : source.slice(0, maxChars), truncated: true }
}

/** Levenshtein distance (rolling row), enough for the fuzzy line check. */
export function levenshtein(a, b) {
  const left = String(a ?? '')
  const right = String(b ?? '')
  if (!left.length) return right.length
  if (!right.length) return left.length
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
    }
    previous = current
  }
  return previous[right.length]
}

/** Continue's `lineIsRepeated`: fuzzy match, lines of 5+ characters only. */
export function lineIsRepeated(a, b) {
  if (String(a).length <= 4 || String(b).length <= 4) return false
  const left = String(a).trim()
  const right = String(b).trim()
  if (!right.length) return false
  return levenshtein(left, right) / right.length < 0.1
}

/** Does the completion just rewrite the last non-empty line of the prefix? */
export function rewritesLineAbove(completion, prefix) {
  const lineAbove = String(prefix ?? '')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .slice(-1)[0]
  if (!lineAbove) return false
  const firstLine = String(completion ?? '')
    .split('\n')
    .find((line) => line.trim().length > 0)
  if (!firstLine) return false
  return lineIsRepeated(lineAbove, firstLine)
}

/**
 * Longest common subsequence of two short strings — returns the STRING, because
 * Continue's `isExtremeRepetition` uses both `lcs.length` and `lines[i].includes(lcs)`.
 */
export function longestCommonSubsequence(a, b) {
  const left = String(a)
  const right = String(b)
  const table = Array.from({ length: left.length + 1 }, () => new Array(right.length + 1).fill(0))
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      table[i][j] = left[i - 1] === right[j - 1] ? table[i - 1][j - 1] + 1 : Math.max(table[i - 1][j], table[i][j - 1])
    }
  }
  let i = left.length
  let j = right.length
  let out = ''
  while (i > 0 && j > 0) {
    if (left[i - 1] === right[j - 1]) {
      out = left[i - 1] + out
      i -= 1
      j -= 1
    } else if (table[i - 1][j] >= table[i][j - 1]) {
      i -= 1
    } else {
      j -= 1
    }
  }
  return out
}

/** Continue's `isExtremeRepetition`: is the model looping over the same lines? */
export function isExtremeRepetition(completion, maxFrequencyToCheck = 3) {
  const lines = String(completion ?? '').split('\n')
  if (lines.length < 6) return false
  for (let frequency = 1; frequency < maxFrequencyToCheck; frequency += 1) {
    const lcs = longestCommonSubsequence(lines[0], lines[frequency] ?? '')
    if (!lcs.length) continue
    if (lcs.length > 5 || lcs.length > lines[0].length * 0.5) {
      let matchCount = 0
      for (let i = 0; i < lines.length; i += frequency) {
        if (lines[i].includes(lcs)) matchCount += 1
      }
      if (matchCount * frequency > 8 || (matchCount * frequency) / lines.length > 0.8) return true
    }
  }
  return false
}

/** Strip markdown code fences (Continue's `removeBackticks`). */
export function stripFences(completion) {
  const lines = String(completion ?? '').split('\n')
  if (!lines.length) return completion
  let start = 0
  let end = lines.length
  if (lines[0].trim().startsWith('```')) start = 1
  if (lines.length > start) {
    const last = lines[lines.length - 1].trim()
    if (last.length > 0 && /^`+$/.test(last)) end = lines.length - 1
  }
  return start > 0 || end < lines.length ? lines.slice(start, end).join('\n') : completion
}

/** Drop reasoning-model chatter so the ghost text does not start with it. */
export function stripThinkTags(completion) {
  return String(completion ?? '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<\/think>/g, '')
    .replace(/^\n+|\n+$/g, '')
}

/**
 * Turn a raw FIM answer into insertable text.
 * @param {string} raw - the model's answer.
 * @param {{prefix?: string, suffix?: string, multiline?: boolean}} options
 * @returns {{text: string, notes: string[]}} the cleaned text and what was changed.
 */
export function postprocessCompletion(raw, options = {}) {
  const { prefix = '', suffix = '', multiline = true } = options
  const notes = []
  let text = String(raw ?? '').replace(/\r\n?/g, '\n')

  // --- rejections first (on the raw answer, like Continue) ---
  if (!text.trim()) return { text: '', notes: ['结果为空：丢弃'] }
  if (/^\s+$/.test(text)) return { text: '', notes: ['只有空白：丢弃'] }
  if (rewritesLineAbove(text, prefix)) return { text: '', notes: ['复写了上一行：丢弃'] }
  if (isExtremeRepetition(text)) return { text: '', notes: ['模型在复读循环：丢弃'] }

  // --- clean-ups ---
  const withoutThink = stripThinkTags(text)
  if (withoutThink !== text) {
    text = withoutThink
    notes.push('剥掉 <think> 标签')
  }
  const unfenced = stripFences(text)
  if (unfenced !== text) {
    text = unfenced
    notes.push('剥掉 markdown 代码围栏')
  }

  if (!multiline) {
    const cut = text.indexOf('\n')
    if (cut !== -1) {
      text = text.slice(0, cut)
      notes.push('单行模式：截到行尾')
    }
  }

  // a verbatim echo of the prefix tail is not a completion
  const tail = prefix.slice(-Math.min(60, prefix.length))
  if (tail.length >= 4 && text.startsWith(tail)) {
    text = text.slice(tail.length)
    notes.push('去掉复读的前缀')
  }

  // "prefix ends with a space and so does the completion" -> one space is enough
  if (prefix.endsWith(' ') && text.startsWith(' ')) {
    text = text.slice(1)
    notes.push('去掉重复空格')
  }

  // trim the overlap with what already follows the cursor
  if (suffix) {
    const max = Math.min(text.length, suffix.length, 80)
    for (let length = max; length > 0; length -= 1) {
      if (text.endsWith(suffix.slice(0, length))) {
        text = text.slice(0, text.length - length)
        notes.push(`与光标后代码重叠 ${length} 字符`)
        break
      }
    }
  }

  const cleaned = text.replace(/[ \t]+$/gm, '').replace(/\n+$/, '')
  if (cleaned !== text) notes.push('去掉尾部空行')
  text = cleaned

  if (!text.trim()) {
    notes.push('结果为空：丢弃')
    return { text: '', notes }
  }
  return { text, notes }
}

/**
 * Prefix-keyed LRU cache, ported from Continue's `AutocompleteLruCache`.
 *
 * Its trick: the key is the code before the cursor, so a later query that merely
 * typed MORE characters can reuse the stored answer — strip the characters the
 * user typed and validate that the cached answer starts with them. That turns
 * "one request per keystroke" into "one request per completion".
 *
 * The sliding window (`keyLength`) means the stored key is not a literal prefix
 * of the new query, so the check is expressed as a shift instead.
 */
export class CompletionLruCache {
  constructor({ capacity = 500, keyLength = 400, ttlMs = 0 } = {}) {
    this.capacity = capacity
    this.keyLength = keyLength
    this.ttlMs = ttlMs
    this.entries = new Map()
    this.hits = 0
    this.misses = 0
    this.reuses = 0
  }

  get size() {
    return this.entries.size
  }

  #touch(key, entry) {
    entry.at = Date.now()
    this.entries.delete(key)
    this.entries.set(key, entry)
  }

  put(prefix, completion) {
    const key = String(prefix ?? '').slice(-this.keyLength)
    if (!key) return
    this.entries.delete(key)
    this.entries.set(key, { completion: String(completion ?? ''), at: Date.now() })
    while (this.entries.size > this.capacity) {
      this.entries.delete(this.entries.keys().next().value)
    }
  }

  /**
   * @param {string} prefix - the code before the cursor now.
   * @param {{maxShift?: number, now?: number}} options
   * @returns {{text: string, shift: number, exact: boolean} | undefined}
   */
  get(prefix, options = {}) {
    const { maxShift = 8, now = Date.now() } = options
    const query = String(prefix ?? '').slice(-this.keyLength)
    if (!query) return undefined

    const exact = this.entries.get(query)
    if (exact && (!this.ttlMs || now - exact.at < this.ttlMs)) {
      this.hits += 1
      this.#touch(query, exact)
      return { text: exact.completion, shift: 0, exact: true }
    }

    // The user typed more since the cached request. Find the stored entry and
    // work out HOW MUCH of the cached answer is now already in the buffer:
    //   1. "typed"  — the model continued the characters just typed (the usual
    //                 mid-identifier case, which is Continue's rule),
    //   2. "line"   — the model re-emitted the whole current line including its
    //                 indentation (very common in C), so the line prefix counts
    //                 as consumed too.
    // Consuming the longer match is the more specific answer.
    const linePrefix = query.slice(query.lastIndexOf('\n') + 1)
    const candidates = []
    for (const [key, entry] of this.entries) {
      if (this.ttlMs && now - entry.at >= this.ttlMs) continue
      let typed = ''
      if (query.length > key.length && query.startsWith(key)) {
        typed = query.slice(key.length) // the window never filled
      } else if (key.length === query.length) {
        for (let shift = 1; shift <= maxShift && shift < key.length; shift += 1) {
          if (key.slice(shift) === query.slice(0, query.length - shift)) {
            typed = query.slice(query.length - shift) // the window slid
            break
          }
        }
      }
      if (!typed || typed.length > 64) continue
      const completion = entry.completion
      if (completion.startsWith(typed)) {
        candidates.push({ key, entry, consumed: typed.length, alignment: 'typed' })
      } else if (linePrefix.length > typed.length && completion.startsWith(linePrefix)) {
        candidates.push({ key, entry, consumed: linePrefix.length, alignment: 'line' })
      }
    }
    if (!candidates.length) {
      this.misses += 1
      return undefined
    }
    candidates.sort((left, right) => right.consumed - left.consumed || right.key.length - left.key.length)
    const best = candidates[0]
    this.hits += 1
    this.reuses += 1
    this.#touch(best.key, best.entry)
    return {
      text: best.entry.completion.slice(best.consumed),
      shift: best.consumed,
      exact: false,
      alignment: best.alignment,
    }
  }

  get stats() {
    return { size: this.entries.size, capacity: this.capacity, hits: this.hits, misses: this.misses, reuses: this.reuses }
  }

  clear() {
    this.entries.clear()
  }
}
