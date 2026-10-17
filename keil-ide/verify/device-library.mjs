#!/usr/bin/env node
/**
 * Device library acceptance (module level):
 *   1. the library loads from the user's own Keil install (`UV4\UV4.cdb`)
 *   2. AT89C51 / AT89C52 get the SAME values µVision writes (vendor/cpu/memory)
 *   3. the device header really resolves inside `C51\INC` and exposes SFR names
 *   4. placeholders ("see XXX") are reported as having no memory config
 *   5. prompt mention matching respects word boundaries
 *   6. the second load is served from cache
 *
 * Usage: node verify/device-library.mjs
 */
import { makeNodeRunner } from '../../keil-core.mjs'
import {
  deviceProjectFields,
  findMentionedDevices,
  headerSfrNames,
  loadDeviceLibrary,
  readDeviceHeader,
} from '../../keil-devices.mjs'

let failed = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed += 1
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      got      ${JSON.stringify(actual)}\n      expected ${JSON.stringify(expected)}`}`,
  )
}

const run = makeNodeRunner()
const started = Date.now()
const library = await loadDeviceLibrary(run)
const firstMs = Date.now() - started
const cachedStarted = Date.now()
await loadDeviceLibrary(run)
const cachedMs = Date.now() - cachedStarted

check('library ok', library.ok, true)
check('C51 device count >= 1700', library.devices.length >= 1700, true)
check('vendor count >= 70', library.vendors.length >= 70, true)
check('devices with RAM config >= 1690', library.devices.filter((device) => device.hasMemory).length >= 1690, true)
check('ROM-less parts still count as usable', library.byName.get('AX11001')?.hasMemory === true && library.byName.get('AX11001')?.hasRom === false, true)
check('second load is cached (<50ms)', cachedMs < 50, true)
console.log(`      (first ${firstMs} ms, cached ${cachedMs} ms)`)

const at51 = library.byName.get('AT89C51')
const at52 = library.byName.get('AT89C52')
check('AT89C51 exists', Boolean(at51), true)
check('AT89C51 project fields', at51 && deviceProjectFields(at51), {
  device: 'AT89C51',
  vendor: 'Atmel',
  cpu: 'IRAM(0-0x7F) IROM(0-0xFFF) CLOCK(24000000)',
  deviceId: '',
  registerFile: 'REGX51.H',
  iromSize: '0x1000',
  iramSize: '0x80',
  xramSize: '0x0',
})
check('AT89C52 memory', at52 && { irom: at52.iromSize, iram: at52.iramSize, file: at52.registerFile }, {
  irom: '0x2000',
  iram: '0x100',
  file: 'REGX52.H',
})

const header = at52 ? await readDeviceHeader(run, at52) : { ok: false }
check('AT89C52 header resolves', header.ok, true)
check('header is inside C51\\INC', Boolean(header.path && /C51\\INC\\Atmel\\REGX52\.H$/i.test(header.path)), true)
const sfr = header.ok ? headerSfrNames(header.text) : []
check('header exposes SFRs', sfr.includes('P0') && sfr.includes('TMOD'), true)

const placeholder = library.byName.get('T8051XC3')
check('placeholder has no memory', Boolean(placeholder) && placeholder.hasMemory, false)

check(
  'mention matching respects boundaries',
  findMentionedDevices('AT89C52 和 AT89C51RC2 有什么区别', library.devices).map((device) => device.name),
  ['AT89C52', 'AT89C51RC2'],
)
check(
  'unknown part is not matched',
  findMentionedDevices('STC89C52 有几个定时器', library.devices).map((device) => device.name),
  [],
)

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
process.exit(failed ? 1 : 0)
