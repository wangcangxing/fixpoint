#!/usr/bin/env node
/**
 * Stage a self-contained copy of 8051 Studio for packaging.
 *
 * Why staging is needed at all: `server.mjs` imports the shared engine modules as
 * `../keil-*.mjs`, which live ONE LEVEL ABOVE the app folder. A packager only
 * bundles the app folder, so a naive package would start and immediately die with
 * ERR_MODULE_NOT_FOUND. The staging step flattens those modules in and rewrites
 * the import specifiers in the COPY — the working dev layout is never touched.
 *
 * Usage: node tools/package.mjs
 */
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appDir = join(root, 'keil-ide')
const stage = join(root, 'build', 'app')

const ENGINES = [
  'keil-core.mjs',
  'keil-devices.mjs',
  'keil-symbols.mjs',
  'keil-completion.mjs',
  'keil-skills.mjs',
  'keil-tokens.mjs',
  'keil-skill-install.mjs',
  'keil-project.mjs',
]

await rm(stage, { recursive: true, force: true })
await mkdir(stage, { recursive: true })

for (const entry of ['electron-main.mjs', 'server.mjs', 'public', 'skills', 'prompts.json']) {
  await cp(join(appDir, entry), join(stage, entry), { recursive: true })
}
for (const name of ENGINES) {
  await cp(join(root, name), join(stage, name))
}

// Rewrite `../keil-x.mjs` → `./keil-x.mjs` in the staged copy only.
const serverPath = join(stage, 'server.mjs')
const before = await readFile(serverPath, 'utf8')
const after = before.replace(/from '\.\.\/(keil-[\w-]+\.mjs)'/g, "from './$1'")
const rewrites = (before.match(/from '\.\.\/keil-[\w-]+\.mjs'/g) ?? []).length
await writeFile(serverPath, after, 'utf8')
if (rewrites === 0) {
  console.error('no ../keil-*.mjs imports were rewritten — check the import style')
  process.exit(1)
}

// Monaco is served from node_modules at runtime, so only `min` needs to travel.
const monacoSource = join(appDir, 'node_modules', 'monaco-editor', 'min')
if (!(await stat(monacoSource).catch(() => null))) {
  console.error(`missing ${monacoSource}`)
  process.exit(1)
}
await mkdir(join(stage, 'node_modules', 'monaco-editor'), { recursive: true })
await cp(monacoSource, join(stage, 'node_modules', 'monaco-editor', 'min'), { recursive: true })

// The manifest the packager reads: no scripts, no devDependencies.
const pkg = JSON.parse(await readFile(join(appDir, 'package.json'), 'utf8'))
delete pkg.scripts
delete pkg.devDependencies
delete pkg.private
pkg.main = 'electron-main.mjs'
await writeFile(join(stage, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')

console.log(
  JSON.stringify(
    { stage, rewroteImports: rewrites, engines: ENGINES.length, productName: pkg.productName ?? pkg.name },
    null,
    2,
  ),
)
