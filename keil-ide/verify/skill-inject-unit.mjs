#!/usr/bin/env node
/**
 * Unit tests for ../../keil-skill-inject.mjs — the silent-injection matcher and
 * the user-turn assembler. No network, no server: it reads the TWO bundled skills
 * from disk, so the scoring is checked against the real descriptions users see.
 *
 * Usage: node verify/skill-inject-unit.mjs
 */
import { readFile } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AUTO_INJECT_MIN_SCORE, composeUserContent, pickAutoSkill, scoreSkill, skillKeywords } from '../../keil-skill-inject.mjs'
import { parseSkill, renderSkillBlock } from '../../keil-skills.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const skillsDir = join(here, '..', 'skills')

let failed = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed += 1
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      got      ${JSON.stringify(actual)}\n      expected ${JSON.stringify(expected)}`}`,
  )
}
const truthy = (name, value) => check(name, Boolean(value), true)

const load = async (file) =>
  parseSkill(await readFile(join(skillsDir, file), 'utf8'), { fileName: file, path: join(skillsDir, file) })

const timer = await load('8051-timer.md')
const triage = await load('8051-error-triage.md')

console.log('--- 1) 关键词表 ---')
const keywords = skillKeywords(timer)
const weightOf = (term) => keywords.find((entry) => entry.term === term)?.weight ?? 0
check('作者写下的触发词权重最高档（引号内）', weightOf('定时'), 5)
check('技能名整串权重更高', weightOf('8051-timer'), 6)
check('名字分段可用（timer）', weightOf('timer'), 4)
truthy('代码型 token 进入关键词表（tmod）', keywords.some((entry) => entry.term === 'tmod'))
check('同名 term 只保留最高权重', keywords.filter((entry) => entry.term === '8051').length, 1)

console.log('--- 2) 打分 ---')
const timerScore = scoreSkill(timer, '定时器中断进不去，EA 和 ET0 都设了但没有反应')
truthy('定时器问题命中多个关键词', timerScore.score >= 10)
truthy('命中里含作者写的"定时"', timerScore.hits.includes('定时'))
const triageScore = scoreSkill(triage, "main.c(14): error C202: 'LED': undefined identifier")
truthy('报错日志命中错误码 token', triageScore.hits.includes('c202'))
check('空问题得 0 分', scoreSkill(timer, '   ').score, 0)

console.log('--- 3) 自动挑选 ---')
check('定时器问题 → 8051-timer', pickAutoSkill([timer, triage], '定时器中断进不去，EA 和 ET0 都设了')?.skill.name, '8051-timer')
check('编译报错 → 8051-error-triage', pickAutoSkill([timer, triage], "main.c(14): error C202: 'LED': undefined identifier")?.skill.name, '8051-error-triage')
check('无关问题 → 不注入', pickAutoSkill([timer, triage], '这个呼吸灯看不出渐变，帮我改成分段亮度'), null)
check('门槛可调：调高后同问题不注入', pickAutoSkill([timer, triage], "C202 undefined identifier", { minScore: 99 }), null)
check('默认门槛是 3', AUTO_INJECT_MIN_SCORE, 3)

console.log('--- 4) 平手与策略 ---')
const twinA = { name: '8051-alpha', description: '甲', whenToUse: '' }
const twinB = { name: '8051-beta', description: '乙', whenToUse: '' }
check('两个技能同分 → 不猜，直接不注入', pickAutoSkill([twinA, twinB], '8051 这个型号怎么用'), null)
const modelOnly = { ...timer, name: '8051-model-only', invocation: { modelInvocable: false, userInvocable: true } }
check('声明 modelInvocable:false 的技能不参与自动挑选', pickAutoSkill([modelOnly], '定时器中断怎么配'), null)
check('人工点名的技能不经过自动挑选（调用方负责）', pickAutoSkill([], '定时器中断怎么配'), null)

console.log('--- 5) 注入位置 ---')
const block = renderSkillBlock(timer)
const content = composeUserContent({ skillBlock: block, context: '[工程]\n器件: AT89C52', prompt: '定时器中断进不去' })
truthy('技能块在最前面', content.startsWith('<skill_content name="8051-timer">'))
truthy('技能块在用户原话之前', content.indexOf('</skill_content>') < content.indexOf('定时器中断进不去'))
truthy('工程上下文在中间', content.indexOf('[工程]') > content.indexOf('</skill_content>'))
truthy('用户原话逐字保留在末尾', content.endsWith('定时器中断进不去'))
check('没有上下文时也不留空行', composeUserContent({ skillBlock: block, prompt: '你好' }).includes('\n\n\n'), false)
check('什么都没有时为不含技能', composeUserContent({ prompt: '你好' }), '你好')
check('全空 → 空串', composeUserContent({}), '')

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
process.exit(failed ? 1 : 0)
