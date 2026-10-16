#!/usr/bin/env node
/**
 * Unit tests for ../../keil-skills.mjs — real temp directories, no network.
 * Usage: node verify/skills-unit.mjs
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SKILL_NAME_RE,
  isModelInvocable,
  isUserInvocable,
  listSkills,
  loadSkill,
  parseSkill,
  renderSkillBlock,
} from '../../keil-skills.mjs'

let failed = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      got      ${JSON.stringify(actual)}\n      expected ${JSON.stringify(expected)}`}`)
}

// --- name shape (DSH: kebab-case) ---
check('kebab-case 合法', SKILL_NAME_RE.test('8051-timer'), true)
check('大写不合法', SKILL_NAME_RE.test('Timer'), false)
check('下划线不合法', SKILL_NAME_RE.test('my_skill'), false)
check('中文不合法', SKILL_NAME_RE.test('定时器'), false)
check('结尾连字符不合法', SKILL_NAME_RE.test('timer-'), false)

// --- parsing ---
const parsed = parseSkill(
  ['---', 'name: 8051-timer', 'description: 配置定时器与中断', 'when-to-use: 用户提到定时/中断时', 'disable-model-invocation: true', '---', '<system>先算初值</system>', '# 正文', 'TMOD 规则'].join('\n'),
  { fileName: 'x.md', path: join(tmpdir(), 'skills', '8051-timer.md') },
)
check('name 解析', parsed.name, '8051-timer')
check('whenToUse 解析', parsed.whenToUse, '用户提到定时/中断时')
check('调用策略：模型不可调用', parsed.invocation, { modelInvocable: false, userInvocable: true })
check('system 段抽出', parsed.system, '先算初值')
check('正文不含 system 段', parsed.content.includes('<system>'), false)
check('缺省策略为双真', parseSkill('---\nname: a-b\n---\n正文', { fileName: 'a-b.md' }).invocation, { modelInvocable: true, userInvocable: true })
check('user-invocable: false 生效', parseSkill('---\nname: a-b\nuser-invocable: false\n---\nx', { fileName: 'a-b.md' }).invocation.userInvocable, false)
check('无 frontmatter 时用文件名', parseSkill('就一段正文', { fileName: 'led-pwm.md' }).name, 'led-pwm')
check('description 截断到上限', parseSkill(`---\nname: a-b\ndescription: ${'x'.repeat(600)}\n---\ny`, { fileName: 'a-b.md' }).description.length, 500)
check('isModelInvocable / isUserInvocable', [isModelInvocable(parsed), isUserInvocable(parsed)], [false, true])

// --- render (model-facing block) ---
const block = renderSkillBlock(parsed)
check('注入块含 skill_content 与 name', block.includes('<skill_content name="8051-timer">'), true)
check('注入块含 resourceBase（skill_resources）', block.includes('<skill_resources>'), true)
check('注入块转义尖括号', renderSkillBlock({ ...parsed, description: '<b>x</b>' }).includes('&lt;b&gt;'), true)

// --- discovery over real directories ---
const base = await mkdtemp(join(tmpdir(), 'keil-skills-'))
const project = join(base, 'project')
const userIde = join(base, 'home', '.keil-ai', 'skills')
const bundled = join(base, 'app', 'skills')
const custom = join(base, 'custom-skills')

await mkdir(join(project, '.keil-ide', 'skills', 'bundle-skill'), { recursive: true })
await mkdir(join(project, '.dsh', 'skills'), { recursive: true })
await mkdir(userIde, { recursive: true })
await mkdir(bundled, { recursive: true })
await mkdir(custom, { recursive: true })

// bundle form + project root beats the bundled copy of the same name
await writeFile(join(project, '.keil-ide', 'skills', 'bundle-skill', 'SKILL.md'), '---\nname: bundle-skill\ndescription: 来自工程（目录包）\n---\n工程正文\n')
await writeFile(join(bundled, 'bundle-skill.md'), '---\nname: bundle-skill\ndescription: 来自内置（应被工程覆盖）\n---\n内置正文\n')
await writeFile(join(bundled, 'only-bundled.md'), '---\nname: only-bundled\ndescription: 只在内置\n---\n内置正文\n')
await writeFile(join(project, '.dsh', 'skills', 'shared-dsh.md'), '---\nname: shared-dsh\ndescription: 与 DSH 共享位置\n---\n正文\n')
await writeFile(join(userIde, 'user-only.md'), '---\nname: user-only\ndescription: 用户级\n---\n正文\n')
await writeFile(join(custom, 'custom-one.md'), '---\nname: custom-one\ndescription: 自定义目录\n---\n正文\n')
await writeFile(join(bundled, 'Bad_Name.md'), '---\nname: Bad_Name\ndescription: 非法名\n---\n正文\n')
// no recursive discovery: a nested SKILL.md must be ignored
await mkdir(join(project, '.keil-ide', 'skills', 'nested', 'deep'), { recursive: true })
await writeFile(join(project, '.keil-ide', 'skills', 'nested', 'deep', 'SKILL.md'), '---\nname: deep-skill\ndescription: 深层（不应被发现）\n---\n正文\n')

const listing = await listSkills({ projectRoot: project, bundledDir: bundled, home: join(base, 'home'), dshHome: join(base, 'home', '.dsh'), customDirs: [custom] })
const names = listing.skills.map((skill) => skill.name)
// Default = ISOLATED: this IDE scans only its own roots, never `.dsh`/`.agents`,
// so another agent's skill table cannot leak in.
check('默认隔离：不扫 .dsh/.agents', names, ['bundle-skill', 'custom-one', 'only-bundled', 'user-only'])
check('默认 roots 只含 IDE 自己的来源', listing.roots.map((root) => root.source), ['project-ide', 'custom', 'user-ide', 'bundled'])
const shared = await listSkills({
  projectRoot: project,
  bundledDir: bundled,
  home: join(base, 'home'),
  dshHome: join(base, 'home', '.dsh'),
  customDirs: [custom],
  includeSharedRoots: true,
})
check('显式开启共享后才扫 .dsh（opt-in）', shared.skills.some((skill) => skill.name === 'shared-dsh'), true)
check('开启共享后 roots 变 7 个（含 agents）', shared.roots.length, 7)
check('rank 胜出：工程目录包覆盖内置', listing.skills.find((skill) => skill.name === 'bundle-skill').description, '来自工程（目录包）')
check('rank 值随来源', listing.skills.find((skill) => skill.name === 'bundle-skill').rank, 100)
check('非法名被跳过并记录', listing.problems.some((line) => line.includes('Bad_Name')), true)
check('不做递归发现（深层被忽略）', names.includes('deep-skill'), false)
check('读取无错时 complete=true', listing.complete, true)
check('roots 按 rank 排序', listing.roots.map((root) => root.rank), [...listing.roots.map((root) => root.rank)].sort((a, b) => a - b))

// --- load: fresh body + name validation ---
const loaded = await loadSkill('only-bundled', { projectRoot: project, bundledDir: bundled, home: join(base, 'home'), dshHome: join(base, 'home', '.dsh') })
check('loadSkill 拿到正文', loaded.skill?.content, '内置正文')
check('loadSkill 未知名字 → 404', (await loadSkill('nope', { projectRoot: project, bundledDir: bundled })).code, 404)
// A candidate discovered earlier, then renamed on disk: the locator is stale → 409.
const staleCandidate = (await listSkills({ projectRoot: project, bundledDir: bundled })).skills.find((skill) => skill.name === 'only-bundled')
await writeFile(join(bundled, 'only-bundled.md'), '---\nname: renamed-elsewhere\ndescription: 改了名\n---\n新正文\n')
check('名字消失后再按名字找 → 404', (await loadSkill('only-bundled', { projectRoot: project, bundledDir: bundled })).code, 404)
check(
  '按旧候选项加载（正文改名）→ 409',
  (await loadSkill('only-bundled', { projectRoot: project, bundledDir: bundled, candidate: staleCandidate })).code,
  409,
)

await rm(base, { recursive: true, force: true })

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
