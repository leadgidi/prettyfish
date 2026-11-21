#!/usr/bin/env node
/**
 * Pack a .prettyfish.json project so page cards never overlap.
 *
 * A diagram persists x/y/width only; its height exists only after Mermaid
 * renders, which needs a real layout engine. So this tool does not measure —
 * it asks the app that already has the file open, through
 * GET /__prettyfish/watch/state, which reports the card heights and overlaps
 * it measured for the exact document hash on disk.
 *
 * Requirement: the watch server must be running for this file AND a browser tab
 * must have the page open. There is no headless fallback: without a rendered
 * tab there is no measurement.
 *
 * Usage:
 *   node --experimental-strip-types scripts/layout-tidy.mjs <project.prettyfish.json> [flags]
 *   npm run layout:tidy -- /path/to/project.prettyfish.json
 *   npm run layout:check -- /path/to/project.prettyfish.json
 *
 * Flags:
 *   --cols N             cards per row (default 2)
 *   --gap-x N            horizontal gap in px (default 100)
 *   --gap-y N            vertical gap in px (default 120)
 *   --check              report only; exit 1 on overlap or an oversize card
 *   --dry-run            print the new positions without writing
 *   --max-card-height N  fail --check when a card is taller (default 1400, 0 disables)
 *   --base URL           watch server base (default: first live one watching this file)
 *   --timeout MS         how long to wait for the tab to report (default 30000)
 *   --verbose            print every state poll
 *
 * Exit codes: 0 clean, 1 layout problem (--check), 2 no measurement or bad setup.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  DEFAULT_PACK_COLS,
  DEFAULT_PACK_GAP_X,
  DEFAULT_PACK_GAP_Y,
  findOverlappingBoxes,
  packCards,
  packedPageHeight,
} from '../src/lib/cardLayout.ts'

const CANDIDATE_PORTS = [5174, 5173, 5199]
const DEFAULT_OVERSIZE_PX = 1400
const POLL_MS = 400

function printUsage(exitCode = 2) {
  console.error(`Usage:
  node --experimental-strip-types scripts/layout-tidy.mjs <project.prettyfish.json> [flags]

Flags:
  --cols N  --gap-x N  --gap-y N  --check  --dry-run
  --max-card-height N  --base URL  --timeout MS  --verbose

The watch server must be running for that file and a browser tab must have it
open: measurements come from the rendered app, not from a headless browser.
`)
  process.exit(exitCode)
}

function parseArgs(argv) {
  const options = {
    file: '',
    cols: DEFAULT_PACK_COLS,
    gapX: DEFAULT_PACK_GAP_X,
    gapY: DEFAULT_PACK_GAP_Y,
    check: false,
    dryRun: false,
    maxCardHeight: DEFAULT_OVERSIZE_PX,
    base: process.env.PRETTYFISH_WATCH_BASE?.trim().replace(/\/$/, '') ?? '',
    timeout: 30_000,
    verbose: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      const value = argv[++i]
      if (value === undefined) printUsage()
      return value
    }
    if (arg === '--help' || arg === '-h') printUsage(0)
    else if (arg === '--cols') options.cols = Number(next())
    else if (arg === '--gap-x') options.gapX = Number(next())
    else if (arg === '--gap-y') options.gapY = Number(next())
    else if (arg === '--max-card-height') options.maxCardHeight = Number(next())
    else if (arg === '--base') options.base = next().replace(/\/$/, '')
    else if (arg === '--timeout') options.timeout = Number(next())
    else if (arg === '--check') options.check = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--verbose') options.verbose = true
    else if (arg.startsWith('-')) {
      console.error(`Unknown flag: ${arg}`)
      printUsage()
    } else if (!options.file) options.file = arg
    else {
      console.error(`Unexpected argument: ${arg}`)
      printUsage()
    }
  }

  if (!options.file) printUsage()
  for (const key of ['cols', 'gapX', 'gapY', 'maxCardHeight', 'timeout']) {
    if (!Number.isFinite(options[key]) || options[key] < 0) {
      console.error(`Invalid value for --${key}`)
      printUsage()
    }
  }
  if (options.cols < 1) {
    console.error('--cols must be at least 1')
    printUsage()
  }
  return options
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function hashProject(raw) {
  return createHash('sha256').update(raw).digest('hex')
}

async function getJson(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

/**
 * Find the watch server for this exact file. A server watching another file is
 * an error, not something to silently retarget: measurements would be wrong.
 */
async function resolveBase(options, docPath) {
  const candidates = options.base ? [options.base] : CANDIDATE_PORTS.map((port) => `http://127.0.0.1:${port}`)
  const seen = []
  for (const base of candidates) {
    const status = await getJson(`${base}/__prettyfish/watch/status`)
    if (!status?.enabled) {
      seen.push(`${base}: not a watch server`)
      continue
    }
    if (status.path !== docPath) {
      seen.push(`${base}: watching ${status.path ?? '(none)'}`)
      continue
    }
    return base
  }
  throw new Error(
    `No prettyfish watch server is serving this file.\n  tried:\n  ${seen.join('\n  ') || '(none)'}\n` +
      `Start one with pf watch start, then open the map.`,
  )
}

function phaseRemedy(phase, base) {
  if (phase === 'no-tab') return `No browser tab has ${base} open. Open it, then re-run.`
  if (phase === 'stale-app') return `The open tab is showing an older version of the file; it reloads on save. Wait a moment, then re-run.`
  if (phase === 'rendering') return `The open tab is still rendering. Wait a moment, then re-run.`
  return ''
}

/** Wait until the app reports measurements for exactly this document content. */
async function waitForMeasurement(base, docHash, timeoutMs, verbose, tabId) {
  const query = new URLSearchParams({ hash: docHash })
  if (tabId) query.set('tab', tabId)
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    const state = await getJson(`${base}/__prettyfish/watch/state?${query}`)
    last = state
    if (verbose && state) console.error(`[layout-tidy] phase=${state.phase} ${state.reason ?? ''}`)
    if (state?.phase === 'ready' && state.docHash === docHash) return state
    if (state?.phase === 'error') {
      const failed = (state.pages ?? []).flatMap((page) =>
        (page.diagrams ?? [])
          .filter((diagram) => diagram.renderStatus === 'error')
          .map((diagram) => `${page.pageName} / ${diagram.name}`),
      )
      throw new Error(failed.length ? `Diagrams failed to render:\n  ${failed.join('\n  ')}` : state.reason)
    }
    await sleep(POLL_MS)
  }
  const phase = last?.phase ?? 'unreachable'
  throw new Error(
    `The app never reported measurements for this file (phase=${phase}${last?.reason ? `, ${last.reason}` : ''}).\n` +
      `${phaseRemedy(phase, base)}`.trimEnd(),
  )
}

function cardsFor(project, state) {
  const pages = []
  for (const page of project.pages ?? []) {
    const measured = (state.pages ?? []).find((candidate) => candidate.pageId === page.id)
    if (!measured) throw new Error(`The app reported no measurements for page "${page.name}"`)
    const byId = new Map((measured.diagrams ?? []).map((diagram) => [diagram.id, diagram]))
    const cards = (page.diagrams ?? []).map((diagram) => {
      const live = byId.get(diagram.id)
      if (!live) throw new Error(`The app reported no measurement for "${diagram.name}" on page "${page.name}"`)
      return { id: diagram.id, width: diagram.width, height: live.cardHeight }
    })
    pages.push({ page, measured, cards })
  }
  return pages
}

function report(project, state, options) {
  const problems = []
  const oversize = []
  for (const page of project.pages ?? []) {
    const measured = (state.pages ?? []).find((candidate) => candidate.pageId === page.id)
    const byId = new Map((measured?.diagrams ?? []).map((diagram) => [diagram.id, diagram]))
    const boxes = (page.diagrams ?? []).map((diagram) => {
      const live = byId.get(diagram.id)
      return {
        id: diagram.id,
        name: live?.name ?? diagram.name ?? diagram.id,
        x: diagram.x,
        y: diagram.y,
        width: diagram.width,
        height: live?.cardHeight ?? 0,
      }
    })
    for (const [a, b] of findOverlappingBoxes(boxes)) {
      problems.push(`${page.name}: "${a.name}" overlaps "${b.name}"`)
    }
    for (const box of boxes) {
      if (options.maxCardHeight > 0 && box.height > options.maxCardHeight) {
        oversize.push(`${page.name}: "${box.name}" is ${Math.round(box.height)}px tall`)
      }
    }
  }
  return { problems, oversize }
}

function pack(project, state, options) {
  const updates = []
  const summary = []
  for (const { page, cards } of cardsFor(project, state)) {
    const positions = packCards(cards, { cols: options.cols, gapX: options.gapX, gapY: options.gapY })
    const byId = new Map(positions.map((position) => [position.id, position]))
    let moved = 0
    for (const diagram of page.diagrams ?? []) {
      const position = byId.get(diagram.id)
      if (diagram.x !== position.x || diagram.y !== position.y) {
        updates.push({
          page: page.name,
          diagram: diagram.name,
          from: [diagram.x, diagram.y],
          to: [position.x, position.y],
        })
        diagram.x = position.x
        diagram.y = position.y
        moved += 1
      }
    }
    summary.push({ page: page.name, cards: cards.length, height: packedPageHeight(cards, positions), moved })
  }
  return { updates, summary }
}

function printSummary(summary, updates, oversize, options) {
  console.log('page'.padEnd(42), 'cards', 'pageHeight', 'moved')
  for (const row of summary) {
    console.log(
      row.page.slice(0, 41).padEnd(42),
      String(row.cards).padStart(5),
      String(Math.round(row.height)).padStart(10),
      String(row.moved).padStart(6),
    )
  }
  for (const update of updates) {
    console.log(`  ${update.page}: "${update.diagram}" (${update.from.join(',')}) -> (${update.to.join(',')})`)
  }
  if (oversize.length > 0 && options.check) {
    for (const line of oversize) console.error(`oversize: ${line}`)
  } else if (oversize.length > 0) {
    console.warn(`\nTall cards (over ${options.maxCardHeight}px: split the diagram):`)
    for (const line of oversize) console.warn(`  ${line}`)
  }
}

const options = parseArgs(process.argv.slice(2))
const docPath = path.resolve(process.cwd(), options.file)

try {
  const raw = await fs.readFile(docPath, 'utf8')
  const project = JSON.parse(raw)
  const revision = hashProject(raw)
  const base = await resolveBase(options, docPath)
  const state = await waitForMeasurement(base, revision, options.timeout, options.verbose)

  if (options.check) {
    const { problems, oversize } = report(project, state, options)
    printSummary([], [], oversize, options)
    if (problems.length === 0 && oversize.length === 0) {
      console.log(`layout:check clean - ${state.totalDiagrams} diagrams, no overlaps (measured by ${base})`)
    } else {
      for (const line of problems) console.error(line)
      console.error(`\nlayout:check failed - run npm run layout:tidy -- ${options.file}`)
      process.exitCode = 1
    }
  } else {
    const { problems, oversize } = report(project, state, options)
    const { updates, summary } = pack(project, state, options)
    printSummary(summary, updates, oversize, options)

    if (updates.length === 0) {
      console.log('\nno position changes needed')
    } else if (options.dryRun) {
      console.log(`\ndry run: ${updates.length} position change(s) not written`)
    } else {
      const packed = `${JSON.stringify(project, null, 2)}\n`
      const temp = await fs.mkdtemp(path.join(path.dirname(docPath), '.prettyfish-'))
      try {
        const staged = path.join(temp, 'project.json')
        await fs.writeFile(staged, packed, { mode: (await fs.stat(docPath)).mode })
        if (await fs.readFile(docPath, 'utf8') !== raw) throw new Error('The map changed during packing. Run tidy again.')
        await fs.rename(staged, docPath)
      } finally {
        await fs.rm(temp, { recursive: true, force: true })
      }
      console.log('Wrote positions. Waiting for the measuring tab to apply them.')
      const after = await waitForMeasurement(base, hashProject(packed), options.timeout, options.verbose, state.tabId)
      const verification = report(project, after, options)
      if (verification.problems.length > 0) {
        for (const line of verification.problems) console.error(line)
        console.error('\nthe app still reports overlaps after packing')
        process.exitCode = 2
      } else {
        console.log(
          `\nwrote ${options.file} (${updates.length} position change(s))` +
            `${problems.length > 0 ? `, cleared ${problems.length} overlap(s)` : ''} - app reports no overlaps`,
        )
      }
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 2
}
