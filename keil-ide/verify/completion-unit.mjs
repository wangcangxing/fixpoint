#!/usr/bin/env node
/**
 * Unit tests for ../../keil-completion.mjs — no browser, no endpoint needed.
 * Usage: node verify/completion-unit.mjs
 */
import {
  CompletionLruCache,
  decideMultiline,
  estimateTokens,
  isExtremeRepetition,
  levenshtein,
  lineIsRepeated,
  postprocessCompletion,
  rewritesLineAbove,
  stripFences,
  stripThinkTags,
  truncateByTokens,
} from '../../keil-completion.mjs'

let failed = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      got      ${JSON.stringify(actual)}\n      expected ${JSON.stringify(expected)}`}`)
}

// --- multiline policy ---
check('auto + 行尾空 → 多行', decideMultiline('auto', { lineBefore: '    P1 = 0;', lineAfter: '' }), true)
check('auto + 行中代码 → 单行', decideMultiline('auto', { lineBefore: '    t', lineAfter: ' + 1;' }), false)
check('auto + 单行注释 → 单行', decideMultiline('auto', { lineBefore: '    // 呼吸灯', lineAfter: '' }), false)
check('never → 单行', decideMultiline('never', { lineAfter: '' }), false)
check('always → 多行', decideMultiline('always', { lineBefore: '// x', lineAfter: 'x' }), true)

// --- token helpers ---
check('token 估算', estimateTokens('abcd'), 1)
check('从尾部按预算截断', truncateByTokens('abcdefghij', 1, true), { text: 'ghij', truncated: true })

// --- fuzzy line comparison (ported from Continue) ---
check('Levenshtein', levenshtein('kitten', 'sitting'), 3)
check('短行不判重复', lineIsRepeated('P1=0', 'P1=1'), false)
check('相似长行判重复', lineIsRepeated('    delay(1000);', '    delay(100);'), true)
check('差异超过 10% 不算重复', lineIsRepeated('    delay(100);', '    led_on();'), false)
check('复写上一行被识别', rewritesLineAbove('    delay(100);\n    P1 = 0;', '    delay(100);\n'), true)

// --- repetition / fences / think ---
check('8 行重复被识别', isExtremeRepetition(Array.from({ length: 9 }, () => '    delay(100);').join('\n')), true)
check('正常多行不算重复', isExtremeRepetition('    P1 = 0xFE;\n    delay(100);\n    P1 = 0xFF;\n    delay(200);\n    return;\n}'), false)
check('剥掉代码围栏', stripFences('```c\nP1 = 0;\n```'), 'P1 = 0;')
check('剥掉 think 标签', stripThinkTags('<think>嗯</think>P1 = 0;'), 'P1 = 0;')

// --- post-processing ---
check('单行模式截到行尾', postprocessCompletion('tick++;\nmore();\n', { multiline: false }).text, 'tick++;')
check('复写上一行 → 丢弃', postprocessCompletion('    delay(100);\n    P1 = 0;', { prefix: '    delay(100);\n' }).text, '')
check('复读循环 → 丢弃', postprocessCompletion(Array.from({ length: 9 }, () => '    delay(100);').join('\n'), {}).text, '')
check('围栏 + think 一起剥', postprocessCompletion('<think>x</think>```c\nP1 = 0;\n```', {}).text, 'P1 = 0;')
check('与光标后重叠的右括号被裁掉', postprocessCompletion('tick++;\n}', { suffix: '}\n' }), {
  text: 'tick++;',
  notes: ['与光标后代码重叠 1 字符', '去掉尾部空行'],
})
check('复读前缀被去掉（缩进保留）', postprocessCompletion('    ti    tick++;', { prefix: '    ti' }).text, '    tick++;')
check('前缀末尾空格与补全开头空格去重', postprocessCompletion(' P1 = 0;', { prefix: '    return; ' }).text, 'P1 = 0;')
check('纯空白结果被丢弃', postprocessCompletion('   \n  ', {}).text, '')
check('CRLF 归一化', postprocessCompletion('a;\r\nb;\r\n', {}).text, 'a;\nb;')
check('正常多行结果保持不动', postprocessCompletion('    P1 = 0xFE;\n    delay(100);', {}).text, '    P1 = 0xFE;\n    delay(100);')

// --- prefix-keyed cache with progress reuse (ported from Continue) ---
const cache = new CompletionLruCache({ capacity: 3, keyLength: 200 })
cache.put('void main(void)\n{\n    t', 'ick++; /* 每秒自增 */')
check('精确命中', cache.get('void main(void)\n{\n    t').text, 'ick++; /* 每秒自增 */')
check('多打了 1 个字符仍可复用（shift=1）', cache.get('void main(void)\n{\n    ti'), { text: 'ck++; /* 每秒自增 */', shift: 1, exact: false, alignment: 'typed' })
check('多打了 2 个字符仍可复用（shift=2）', cache.get('void main(void)\n{\n    tic'), { text: 'k++; /* 每秒自增 */', shift: 2, exact: false, alignment: 'typed' })

// The "model re-emitted the whole indented line" shape (very common in C):
// cached answer is `    tick++;`, the user has since typed `i` of `ti`.
const indented = new CompletionLruCache({ capacity: 5, keyLength: 200 })
indented.put('void f(void)\n{\n    t', '    tick++;')
check(
  '带缩进的回复：按整行前缀对齐后复用',
  indented.get('void f(void)\n{\n    ti'),
  { text: 'ck++;', shift: 6, exact: false, alignment: 'line' },
)
check('带缩进的回复：精确命中不受影响', indented.get('void f(void)\n{\n    t').text, '    tick++;')
check('打错字符则不复用', cache.get('void main(void)\n{\n    tX'), undefined)
check('无关内容不复用', cache.get('sbit LED = P1^0;'), undefined)
cache.put('a', '1')
cache.put('b', '2')
cache.put('c', '3')
check('容量上限生效', cache.size <= 3, true)
check('缓存统计含 reuse 计数', cache.stats.reuses >= 2, true)

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
