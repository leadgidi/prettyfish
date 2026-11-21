#!/usr/bin/env node
/**
 * Control a running Pretty Fish watch server from the command line.
 *
 * Usage:
 *   node scripts/watch-ctl.mjs status [--base http://127.0.0.1:5173]
 *   node scripts/watch-ctl.mjs set <file.prettyfish.json> [--base http://127.0.0.1:5173]
 *   node scripts/watch-ctl.mjs validate [--base http://127.0.0.1:5173]
 *   node scripts/watch-ctl.mjs layout [--base http://127.0.0.1:5173]
 *   npm run watch:status
 *   npm run watch:set -- /path/to/other.prettyfish.json
 *   npm run watch:validate
 *   npm run watch:layout
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function printUsage(exitCode = 1) {
  console.error(`Usage:
  node scripts/watch-ctl.mjs status [--base http://127.0.0.1:5173]
  node scripts/watch-ctl.mjs set <file.prettyfish.json> [--base http://127.0.0.1:5173]
  node scripts/watch-ctl.mjs validate [--base http://127.0.0.1:5173]
  node scripts/watch-ctl.mjs layout [--base http://127.0.0.1:5173]
`)
  process.exit(exitCode)
}

function parseArgs(argv) {
  const command = argv[0]
  let file = ''
  let base = process.env.PRETTYFISH_WATCH_BASE?.trim() || 'http://127.0.0.1:5173'

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') printUsage(0)
    if (arg === '--base') {
      base = argv[++i] ?? printUsage()
      continue
    }
    if (arg.startsWith('-')) {
      console.error(`Unknown flag: ${arg}`)
      printUsage()
    }
    file = arg
  }

  return { command, file, base: base.replace(/\/$/, '') }
}

const { command, file, base } = parseArgs(process.argv.slice(2))
if (
  command !== 'status' &&
  command !== 'set' &&
  command !== 'validate' &&
  command !== 'layout'
) {
  printUsage()
}

if (command === 'status') {
  const res = await fetch(`${base}/__prettyfish/watch/status`)
  const body = await res.text()
  if (!res.ok) {
    console.error(body || `HTTP ${res.status}`)
    process.exit(1)
  }
  console.log(body)
  process.exit(0)
}

if (command === 'layout') {
  const res = await fetch(`${base}/__prettyfish/watch/layout`)
  const body = await res.text()
  if (!res.ok) {
    console.error(body || `HTTP ${res.status}`)
    process.exit(1)
  }
  console.log(body)
  process.exit(0)
}

if (command === 'validate') {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url))
  const validator = path.join(scriptDir, 'validate-project.mjs')
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', validator, '--from-watch', '--base', base],
    { stdio: 'inherit' },
  )
  process.exit(result.status ?? 1)
}

if (!file) {
  console.error('Missing project file path.')
  printUsage()
}

const absFile = path.resolve(process.cwd(), file)
if (!fs.existsSync(absFile)) {
  console.error(`File not found: ${absFile}`)
  process.exit(1)
}

const res = await fetch(`${base}/__prettyfish/watch/file`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ path: absFile }),
})
const body = await res.text()
if (!res.ok) {
  console.error(body || `HTTP ${res.status}`)
  process.exit(1)
}
console.log(body)
