/**
 * Token metering for keil-ide, modelled on DeepSeek Harness's "Token 计量"
 * (`@deepseek-ai/dsh-token-meter`).
 *
 * The shape kept from that spec:
 *   - `surfaceTokens`       route-priced total of the CURRENT surface (the
 *                           messages that would be sent right now), summed over
 *                           positional nodes;
 *   - `nodes[]`             per-position `{ seq, tokens, heuristicTokens }`, where
 *                           `tokens` is the route price and `heuristicTokens` the
 *                           route-independent estimate;
 *   - `totalTokens`         request + response pressure (non-negative);
 *   - `surfaceDeltaTokens`  SIGNED repricing of the current surface against the
 *                           last reusable anchor (grows and shrinks both show);
 *   - `baseline.kind`       'usage' when a successful provider call's canonical
 *                           request envelope matches and its reported total covers
 *                           the anchor, 'estimated' otherwise;
 *   - `logRevision`         how many observations produced this measurement.
 *
 * Stated plainly: DSH replays a durable event log and needs an O(1) projection
 * fold plus a shadow-price protocol. Our "log" is this IDE's HTTP call history,
 * so this is a faithful-in-semantics but simpler fold. Route pricing is a small
 * editable table (per 1M tokens) rather than adapter metadata, and image pricing
 * is not implemented because this IDE never sends images.
 *
 * @module keil-tokens
 */
import { estimateTokens } from './keil-completion.mjs'

/** Per-1M-token prices, matched by longest model-id prefix. Edit to match reality. */
export const DEFAULT_PRICING = [
  { prefix: 'deepseek-chat', input: 2, output: 8, currency: 'CNY' },
  { prefix: 'deepseek-reasoner', input: 4, output: 16, currency: 'CNY' },
  { prefix: 'mock-', input: 0, output: 0, currency: 'CNY' },
  { prefix: '', input: 0, output: 0, currency: 'CNY' },
]

/** Role framing overhead (rough): every message costs a few tokens of envelope. */
export const ROLE_FRAMING_TOKENS = 4

/** Heuristic price of one model-visible message, independent of any route. */
export function estimateMessageTokens(message, framing = ROLE_FRAMING_TOKENS) {
  const content = typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content ?? '')
  return estimateTokens(content) + framing
}

/** Longest-prefix route lookup; the empty prefix is the fallback. */
export function pricingFor(model, pricing = DEFAULT_PRICING) {
  const wanted = String(model ?? '')
  let best = null
  for (const entry of pricing) {
    if (wanted.startsWith(entry.prefix) && (!best || entry.prefix.length > best.prefix.length)) best = entry
  }
  return best ?? { prefix: '', input: 0, output: 0, currency: 'CNY' }
}

/** Cost of a token count under a route price (per 1M). */
export function costOf(tokens, perMillion) {
  return (Number(tokens) || 0) * (Number(perMillion) || 0) / 1_000_000
}

/**
 * Canonical identity of a request ENVELOPE — the header, not the messages.
 *
 * This distinction is the whole point of `surfaceDeltaTokens`: the anchor stays
 * reusable while the route (model / endpoint / sampling params) is unchanged, so
 * the measurement can report how the SURFACE grew or shrank against a real usage
 * number. Folding the messages in here made every surface change invalidate the
 * anchor and pinned the delta at 0 (a bug the unit tests caught).
 */
export function canonicalEnvelope(header = {}) {
  const parts = [
    `model=${header.model ?? ''}`,
    `route=${header.baseURL ?? ''}`,
    `temp=${header.temperature ?? ''}`,
    `max=${header.maxTokens ?? ''}`,
  ]
  return parts.join('|')
}

/**
 * Replay-free token meter: observe requests, observe provider usage, read a
 * detached measurement at any time.
 */
export class TokenMeter {
  constructor({ pricing = DEFAULT_PRICING, maxObservations = 500 } = {}) {
    this.pricing = pricing
    this.maxObservations = maxObservations
    this.logRevision = 0
    this.nodes = []
    this.header = {}
    this.envelope = ''
    this.anchor = null
    this.observations = []
  }

  #bump() {
    this.logRevision += 1
    if (this.observations.length >= this.maxObservations) this.observations.shift()
  }

  /** Price the surface that is about to be sent (or that just was). */
  observeSurface(header, messages) {
    const route = pricingFor(header?.model, this.pricing)
    const baseSeq = this.logRevision
    this.nodes = messages.map((message, index) => {
      const heuristicTokens = estimateMessageTokens(message)
      return {
        seq: baseSeq + index + 1,
        role: message?.role ?? '?',
        tokens: Math.max(1, Math.round(heuristicTokens * (route.multiplier ?? 1))),
        heuristicTokens,
      }
    })
    this.header = {
      model: header?.model ?? '',
      baseURL: header?.baseURL ?? '',
      temperature: header?.temperature ?? '',
      maxTokens: header?.maxTokens ?? '',
    }
    this.envelope = canonicalEnvelope(this.header)
    this.#bump()
    return this.measure()
  }

  /** Record one successful provider call: usage numbers plus the envelope used. */
  observeUsage(usage, { header = this.header } = {}) {
    const prompt = Number(usage?.prompt_tokens ?? usage?.promptTokens ?? 0)
    const completion = Number(usage?.completion_tokens ?? usage?.completionTokens ?? 0)
    const total = Number(usage?.total_tokens ?? usage?.totalTokens ?? prompt + completion)
    if (!total && !prompt && !completion) return this.measure()
    this.anchor = {
      envelope: canonicalEnvelope(header),
      promptTokens: prompt,
      completionTokens: completion,
      totalTokens: total,
      surfaceTokens: this.surfaceTokens(),
      at: new Date().toISOString(),
    }
    this.#bump()
    return this.measure()
  }

  /** Current route-priced surface total. */
  surfaceTokens() {
    return this.nodes.reduce((sum, node) => sum + node.tokens, 0)
  }

  /** A detached measurement (nodes are cloned, like the spec requires). */
  measure() {
    const route = pricingFor(this.header.model, this.pricing)
    const surfaceTokens = this.surfaceTokens()
    // Reusable when the envelope (header) still matches AND the reported total is
    // not lower than the route-priced anchor — a provider that billed less than
    // the surface price cannot anchor a repricing.
    const envelopeMatches = Boolean(this.anchor) && this.anchor.envelope === canonicalEnvelope(this.header)
    const coversAnchor = Boolean(this.anchor) && this.anchor.totalTokens >= this.anchor.surfaceTokens
    const reusable = envelopeMatches && coversAnchor
    const surfaceDeltaTokens = reusable ? surfaceTokens - this.anchor.surfaceTokens : 0
    const baseline = reusable
      ? {
          kind: 'usage',
          promptTokens: this.anchor.promptTokens,
          completionTokens: this.anchor.completionTokens,
          at: this.anchor.at,
        }
      : { kind: 'estimated' }
    // Pressure: the anchor's real total plus any surface growth; without an anchor
    // the surface itself is the only honest estimate.
    const totalTokens = reusable
      ? Math.max(0, this.anchor.totalTokens + Math.max(0, surfaceDeltaTokens))
      : surfaceTokens
    return {
      logRevision: this.logRevision,
      baseline,
      surfaceDeltaTokens,
      totalTokens,
      surfaceTokens,
      nodes: this.nodes.map((node) => ({ ...node })),
      // IDE extension (not part of the DSH shape): a cost estimate under the route.
      route: { model: this.header.model, input: route.input, output: route.output, currency: route.currency },
      cost: {
        surface: costOf(surfaceTokens, route.input),
        lastCall: reusable
          ? costOf(this.anchor.promptTokens, route.input) + costOf(this.anchor.completionTokens, route.output)
          : 0,
        currency: route.currency,
      },
    }
  }

  /** Per-role totals, handy for a settings panel. */
  breakdown() {
    const byRole = {}
    for (const node of this.nodes) {
      byRole[node.role] = (byRole[node.role] ?? 0) + node.tokens
    }
    return byRole
  }

  reset() {
    this.nodes = []
    this.anchor = null
    this.observations = []
    this.logRevision = 0
  }
}
