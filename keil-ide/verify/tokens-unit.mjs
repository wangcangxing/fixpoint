#!/usr/bin/env node
/**
 * Unit tests for ../../keil-tokens.mjs (DSH "Token 计量" semantics).
 * Usage: node verify/tokens-unit.mjs
 */
import {
  DEFAULT_PRICING,
  TokenMeter,
  canonicalEnvelope,
  costOf,
  estimateMessageTokens,
  pricingFor,
} from '../../keil-tokens.mjs'

let failed = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      got      ${JSON.stringify(actual)}\n      expected ${JSON.stringify(expected)}`}`)
}

// --- heuristics & route pricing ---
check('消息估价 = 内容/4 + 角色框架', estimateMessageTokens({ role: 'user', content: 'abcdefgh' }), 6)
check('最长前缀胜出', pricingFor('deepseek-chat').prefix, 'deepseek-chat')
check('未知模型走兜底', pricingFor('something-else').prefix, '')
check('每百万成本', costOf(1_000_000, 2), 2)
check('成本按半价', costOf(500_000, 2), 1)

const surfaceA = [
  { role: 'system', content: 'x'.repeat(400) },
  { role: 'user', content: 'y'.repeat(400) },
]
const surfaceB = [...surfaceA, { role: 'assistant', content: 'z'.repeat(400) }]
const header = { model: 'deepseek-chat', baseURL: 'http://x' }
check('envelope 只看请求头（不看消息）', canonicalEnvelope(header), canonicalEnvelope({ ...header }))
check('不同模型 → 不同 envelope', canonicalEnvelope({ model: 'm1' }) === canonicalEnvelope({ model: 'm2' }), false)
check('不同端点 → 不同 envelope', canonicalEnvelope({ baseURL: 'a' }) === canonicalEnvelope({ baseURL: 'b' }), false)

// --- meter: surface, nodes, revisions ---
const meter = new TokenMeter({ pricing: DEFAULT_PRICING })
const first = meter.observeSurface({ model: 'deepseek-chat', baseURL: 'http://x' }, surfaceA)
check('无锚点时按估算', first.baseline.kind, 'estimated')
check('surfaceTokens = 各节点之和', first.surfaceTokens, first.nodes.reduce((sum, node) => sum + node.tokens, 0))
check('节点带序号与启发式价格', first.nodes.length === 2 && first.nodes[0].seq === 1 && first.nodes[0].heuristicTokens > 0, true)
check('无锚点时不报增量', first.surfaceDeltaTokens, 0)
check('无锚点时压力 = 表层', first.totalTokens, first.surfaceTokens)

// --- meter: a real usage becomes a reusable anchor ---
meter.observeUsage({ prompt_tokens: 210, completion_tokens: 40, total_tokens: 250 })
const anchored = meter.measure()
check('匹配 envelope 的 usage → 锚点', anchored.baseline.kind, 'usage')
check('锚点用量透出', [anchored.baseline.promptTokens, anchored.baseline.completionTokens], [210, 40])
check('锚点下增量归零', anchored.surfaceDeltaTokens, 0)
check('压力沿用真实总量', anchored.totalTokens, 250)

// --- a provider that billed less than the priced surface cannot anchor ---
const cheap = new TokenMeter({ pricing: DEFAULT_PRICING })
cheap.observeSurface({ model: 'deepseek-chat' }, surfaceA)
cheap.observeUsage({ prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 })
check('总量低于路由定价 → 不锚定', cheap.measure().baseline.kind, 'estimated')

// --- meter: growth and shrink are both visible (signed) ---
const grown = meter.observeSurface({ model: 'deepseek-chat', baseURL: 'http://x' }, surfaceB)
check('表层变大 → 正的增量', grown.surfaceDeltaTokens > 0, true)
check('压力随增量上升', grown.totalTokens, 250 + grown.surfaceDeltaTokens)
const shrunk = meter.observeSurface({ model: 'deepseek-chat', baseURL: 'http://x' }, surfaceA)
check('表层缩回 → 增量归零（不叠加）', shrunk.surfaceDeltaTokens, 0)
check('负增量不被压力吞掉（压力不为负）', shrunk.totalTokens >= 0, true)

// --- envelope mismatch drops the anchor ---
const other = meter.observeSurface({ model: 'deepseek-chat', baseURL: 'http://y' }, surfaceB)
check('envelope 不匹配 → 退回估算', other.baseline.kind, 'estimated')

// --- detach + breakdown + cost ---
const snapshot = meter.measure()
snapshot.nodes[0].tokens = -999
check('返回的节点是克隆（改它不影响计量）', meter.measure().nodes[0].tokens !== -999, true)
const meter2 = new TokenMeter({ pricing: DEFAULT_PRICING })
meter2.observeSurface({ model: 'deepseek-chat' }, surfaceA)
check('按角色汇总', Object.keys(meter2.breakdown()).sort(), ['system', 'user'])
check('成本字段按路由价格', meter2.measure().cost.surface > 0, true)
meter2.reset()
check('reset 清空', [meter2.surfaceTokens(), meter2.measure().baseline.kind], [0, 'estimated'])

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
