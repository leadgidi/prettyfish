#!/usr/bin/env node
/**
 * Start Pretty Fish (LOCAL_APP_ONLY) watching a .prettyfish.json on disk.
 *
 * Usage:
 *   node scripts/dev-watch.mjs <file.prettyfish.json> [--host 127.0.0.1] [--port 5173]
 *   PRETTYFISH_WATCH_FILE=/path/to/file.json node scripts/dev-watch.mjs
 *   npm run dev:watch -- /path/to/file.prettyfish.json
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')

function printUsage(exitCode = 1) {
  console.error(`Usage:
  node scripts/dev-watch.mjs <file.prettyfish.json> [--host 127.0.0.1] [--port 5173]
  PRETTYFISH_WATCH_FILE=/abs/path.json node scripts/dev-watch.mjs

Examples:
  npm run dev:watch -- /Users/me/map.prettyfish.json
  npm run watch:set -- /Users/me/other.prettyfish.json   # switch file on a running server
`)
  process.exit(exitCode)
}

function parseArgs(argv) {
  let file = process.env.PRETTYFISH_WATCH_FILE?.trim() || ''
  let host = '127.0.0.1'
  let port = '5173'

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') printUsage(0)
    if (arg === '--host') {
      host = argv[++i] ?? printUsage()
      continue
    }
    if (arg === '--port') {
      port = argv[++i] ?? printUsage()
      continue
    }
    if (arg.startsWith('-')) {
      console.error(`Unknown flag: ${arg}`)
      printUsage()
    }
    // Explicit CLI path wins over PRETTYFISH_WATCH_FILE.
    file = arg
  }

  return { file, host, port }
}

const { file, host, port } = parseArgs(process.argv.slice(2))
if (!file) {
  console.error('Missing project file path.')
  printUsage()
}

const absFile = path.resolve(process.cwd(), file)
if (!fs.existsSync(absFile)) {
  console.error(`File not found: ${absFile}`)
  process.exit(1)
}

const child = spawn(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['vite', '--host', host, '--port', port],
  {
    cwd: projectRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      LOCAL_APP_ONLY: 'true',
      PRETTYFISH_WATCH_FILE: absFile,
    },
  },
)

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  process.exit(code ?? 1)
})
