#!/usr/bin/env node
/**
 * Pack a .prettyfish.json project so page cards never overlap.
 *
 * A diagram persists x/y/width only; its height comes from the rendered
 * Mermaid SVG. Guessing that height is what produces overlaps, so this script
 * does not guess: it drives the real app in headless Chromium, reads the
 * measured card footprint from window.__prettyfishLayoutSnapshot, and re-packs
 * every page with the same code the canvas uses (src/lib/cardLayout.ts).
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
 *   --check              measure and report only; exit 1 on overlap or oversize
 *   --dry-run            print the new positions without writing
 *   --max-card-height N  fail --check when a card is taller (default 1400, 0 disables)
 *   --base URL           use a specific Pretty Fish server instead of starting one
 *   --port N             port for a server this script starts (default 5199)
 *   --timeout MS         render/startup budget (default 90000)
 *   --verbose            inherit the dev server output
 *
 * Exit codes: 0 clean, 1 layout problem (--check), 2 setup or render failure.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import {
  DEFAULT_PACK_COLS,
  DEFAULT_PACK_GAP_X,
  DEFAULT_PACK_GAP_Y,
  findOverlappingBoxes,
  packCards,
  packedPageHeight,
} from '../src/lib/cardLayout.ts'

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REUSE_PORTS = [5174, 5173, 5199]
const DEFAULT_OVERSIZE_PX = 1400
/**
 * A running dev server can serve a stale module graph, so a reused server only
 * gets a short budget: if it does not publish a snapshot quickly, this script
 * starts its own server from current source instead.
 */
const REUSE_PROBE_MS = 10_000

function printUsage(exitCode = 2) {
  console.error(`Usage:
  node --experimental-strip-types scripts/layout-tidy.mjs <project.prettyfish.json> [flags]

Flags:
  --cols N  --gap-x N  --gap-y N  --check  --dry-run
  --max-card-height N  --base URL  --port N  --timeout MS  --verbose
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
    port: 5199,
    timeout: 90_000,
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
    else if (arg === '--port') options.port = Number(next())
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
  for (const key of ['cols', 'gapX', 'gapY', 'maxCardHeight', 'port', 'timeout']) {
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

async function readJsonFile(file) {
  const raw = await fs.readFile(file, 'utf8')
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error.message}`)
  }
}

async function fetchStatus(base) {
  try {
    const res = await fetch(`${base}/__prettyfish/watch/status`, {
      signal: AbortSignal.timeout(1500),
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

async function retargetServer(base, docPath) {
  const res = await fetch(`${base}/__prettyfish/watch/file`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: docPath }),
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) throw new Error(`Failed to watch ${docPath} on ${base}: ${await res.text()}`)
}

async function waitForStatus(base, docPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const status = await fetchStatus(base)
    if (status?.enabled && status.path === docPath) return status
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for ${base} to watch ${docPath}`)
}

function expectedDiagramCount(project) {
  return (project.pages ?? []).reduce((total, page) => total + (page.diagrams?.length ?? 0), 0)
}

/** Measure the project by reading the layout the app publishes for itself. */
async function snapshotFrom(browser, base, project, timeoutMs, fileLabel) {
  const expectedCount = expectedDiagramCount(project)
  if (expectedCount === 0) throw new Error('Project has no diagrams to measure')

  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } })
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
    await page.waitForFunction(
      (count) => {
        const snapshot = window.__prettyfishLayoutSnapshot
        return Boolean(snapshot) && snapshot.totalDiagrams === count && snapshot.readyDiagrams === count
      },
      expectedCount,
      { timeout: timeoutMs },
    )
    await page.evaluate(() => document.fonts?.ready)
    const snapshot = await page.evaluate(() => window.__prettyfishLayoutSnapshot)
    const expectedPageIds = (project.pages ?? []).map((projectPage) => projectPage.id).sort()
    const pageIds = snapshot.pages.map((snapshotPage) => snapshotPage.pageId).sort()
    if (pageIds.join() !== expectedPageIds.join()) {
      throw new Error(
        `rendered a different project: expected pages ${expectedPageIds.join(', ')}, got ${pageIds.join(', ')}`,
      )
    }

    const failed = snapshot.pages.flatMap((snapshotPage) =>
      snapshotPage.diagrams
        .filter((diagram) => diagram.renderStatus === 'error')
        .map((diagram) => `${snapshotPage.pageName} / ${diagram.name}`),
    )
    if (failed.length > 0) {
      throw new Error(
        `diagrams failed to render:\n  ${failed.join('\n  ')}\n` +
          `run npm run validate:project -- ${fileLabel} to see the Mermaid errors`,
      )
    }

    return snapshot
  } finally {
    await page.close()
  }
}

async function startOwnServer(options, docPath) {
  const base = `http://127.0.0.1:${options.port}`
  const existing = await fetchStatus(base)
  if (existing) {
    throw new Error(
      `port ${options.port} already serves a Pretty Fish server (watching ${existing.path ?? 'unknown'}); pass --port or --base`,
    )
  }

  const child = spawn(
    process.execPath,
    ['scripts/dev-watch.mjs', docPath, '--port', String(options.port)],
    {
      cwd: PROJECT_ROOT,
      // detached so the whole group (node, npx, vite) can be stopped as one unit
      detached: true,
      stdio: options.verbose ? 'inherit' : 'ignore',
      env: { ...process.env, PRETTYFISH_WATCH_FILE: docPath },
    },
  )
  child.unref?.()

  const stop = () => {
    if (!child.pid) return
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      // already gone
    }
  }

  try {
    await waitForStatus(base, docPath, options.timeout)
  } catch (error) {
    stop()
    throw new Error(`${error.message}. Port ${options.port} may be busy; pass --port, --base, or --verbose.`)
  }
  return { base, stop }
}

/**
 * Measure through a server that is definitely running current source: reuse a
 * healthy watch server when it answers immediately, otherwise start our own.
 */
async function resolveSnapshot(options, project, docPath) {
  const browser = await chromium.launch({ headless: true })
  const problems = []
  let owned = null

  try {
    if (options.base) {
      const status = await fetchStatus(options.base)
      if (!status?.enabled) throw new Error(`${options.base} is not a Pretty Fish watch server`)
      if (status.path !== docPath) await retargetServer(options.base, docPath)
      return {
        base: options.base,
        snapshot: await snapshotFrom(browser, options.base, project, options.timeout, options.file),
        owned: null,
      }
    }

    for (const port of REUSE_PORTS) {
      const base = `http://127.0.0.1:${port}`
      const status = await fetchStatus(base)
      if (!status?.enabled || status.path !== docPath) continue
      try {
        return {
          base,
          snapshot: await snapshotFrom(browser, base, project, REUSE_PROBE_MS, options.file),
          owned: null,
        }
      } catch (error) {
        problems.push(`${base}: ${error.message}`)
        if (options.verbose) console.error(`[layout-tidy] not reusing ${base}: ${error.message}`)
      }
    }

    const started = await startOwnServer(options, docPath)
    owned = started
    return {
      base: started.base,
      snapshot: await snapshotFrom(browser, started.base, project, options.timeout, options.file),
      owned,
    }
  } catch (error) {
    owned?.stop()
    const details = problems.length > 0 ? `\n  ${problems.join('\n  ')}` : ''
    throw new Error(`${error.message}${details}`)
  } finally {
    await browser.close()
  }
}

function layoutProblems(project, snapshot, options) {
  const problems = []
  const oversize = []

  for (const page of project.pages ?? []) {
    const snapshotPage = snapshot.pages.find((candidate) => candidate.pageId === page.id)
    const measuredById = new Map((snapshotPage?.diagrams ?? []).map((diagram) => [diagram.id, diagram]))
    const boxes = (page.diagrams ?? []).map((diagram) => {
      const measured = measuredById.get(diagram.id)
      return {
        id: diagram.id,
        name: measured?.name ?? diagram.name ?? diagram.id,
        x: diagram.x,
        y: diagram.y,
        width: diagram.width,
        height: measured?.cardHeight ?? 0,
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

function packProject(project, snapshot, options) {
  const updates = []
  const summary = []

  for (const page of project.pages ?? []) {
    const snapshotPage = snapshot.pages.find((candidate) => candidate.pageId === page.id)
    if (!snapshotPage) throw new Error(`No measurements for page "${page.name}"`)

    const measuredById = new Map(snapshotPage.diagrams.map((diagram) => [diagram.id, diagram]))
    const cards = (page.diagrams ?? []).map((diagram) => {
      const measured = measuredById.get(diagram.id)
      if (!measured) {
        throw new Error(`No measurement for diagram "${diagram.name ?? diagram.id}" on page "${page.name}"`)
      }
      return { id: diagram.id, width: diagram.width, height: measured.cardHeight }
    })

    const positions = packCards(cards, { cols: options.cols, gapX: options.gapX, gapY: options.gapY })
    const positionById = new Map(positions.map((position) => [position.id, position]))

    let moved = 0
    for (const diagram of page.diagrams ?? []) {
      const position = positionById.get(diagram.id)
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

    const packedBoxes = cards.map((card) => {
      const position = positionById.get(card.id)
      return { ...card, x: position.x, y: position.y }
    })
    const remaining = findOverlappingBoxes(packedBoxes)
    if (remaining.length > 0) {
      throw new Error(`Packing left ${remaining.length} overlap(s) on page "${page.name}"; packCards is broken`)
    }

    summary.push({
      page: page.name,
      cards: cards.length,
      height: packedPageHeight(cards, positions),
      moved,
    })
  }

  return { updates, summary }
}

function printSummary(summary, updates, oversize, maxCardHeight) {
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
  if (oversize.length > 0) {
    console.warn(`\nTall cards (over ${maxCardHeight}px is a doc smell, split the diagram):`)
    for (const line of oversize) console.warn(`  ${line}`)
  }
}

const options = parseArgs(process.argv.slice(2))
const docPath = path.resolve(process.cwd(), options.file)
const project = await readJsonFile(docPath)

try {
  const { snapshot, owned } = await resolveSnapshot(options, project, docPath)
  try {
    const { problems, oversize } = layoutProblems(project, snapshot, options)

    if (options.check) {
      const clean = problems.length === 0 && oversize.length === 0
      if (clean) {
        console.log(`layout:check clean - ${expectedDiagramCount(project)} diagrams, no overlaps`)
      } else {
        for (const line of problems) console.error(line)
        for (const line of oversize) console.error(`oversize: ${line}`)
        console.error(`\nlayout:check failed - run npm run layout:tidy -- ${options.file}`)
      }
      // --check never writes. Set the code instead of exiting, so the finally
      // below still stops a server we started.
      process.exitCode = clean ? 0 : 1
    } else {
      const { updates, summary } = packProject(project, snapshot, options)
      printSummary(summary, updates, oversize, options.maxCardHeight)

      if (updates.length === 0) {
        console.log('\nno position changes needed')
      } else if (options.dryRun) {
        console.log(`\ndry run: ${updates.length} position change(s) not written`)
      } else {
        await fs.writeFile(docPath, `${JSON.stringify(project, null, 2)}\n`)
        console.log(`\nwrote ${options.file} (${updates.length} position change(s))`)
      }
    }
  } finally {
    owned?.stop()
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 2
}
