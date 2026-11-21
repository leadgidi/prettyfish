// Run with Node and an existing Google Chrome installation.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const exec = promisify(execFile)
const dir = await mkdtemp(join(tmpdir(), 'prettyfish-layout-'))
const oldFile = join(dir, 'old.prettyfish.json')
const newFile = join(dir, 'new.prettyfish.json')

function project(id, positions) {
  const diagrams = positions.map((x, index) => ({
    id: `${id}-${index}`,
    name: `${id} card ${index}`,
    code: 'flowchart TD\n  A --> B',
    x, y: 0, width: 900,
    mermaidTheme: 'blueprint',
    configOverrides: {},
  }))
  return { version: 1, activePageId: id, pages: [{ id, name: id, diagrams, activeDiagramId: diagrams[0].id }] }
}

let server
let browser
try {
  await writeFile(oldFile, JSON.stringify(project('old', [0, 1000, 2000])))
  await writeFile(newFile, JSON.stringify(project('new', [0, 0])))
  process.env.LOCAL_APP_ONLY = 'true'
  process.env.PRETTYFISH_WATCH_FILE = oldFile
  server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
  await server.listen()
  const base = new URL(server.resolvedUrls.local[0]).origin
  const stateUrl = `${base}/__prettyfish/watch/state`
  const state = () => fetch(stateUrl, { signal: AbortSignal.timeout(2000) }).then(response => response.json())
  const options = { timeout: 15_000 }

  async function waitForState(predicate) {
    const end = Date.now() + options.timeout
    let observed
    while (Date.now() < end) {
      observed = await state()
      if (predicate(observed)) return observed
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error(`Unexpected watch state: ${JSON.stringify(observed)}`)
  }

  browser = await chromium.launch({ channel: 'chrome' })
  const context = await browser.newContext()
  const previous = await context.newPage()
  await previous.goto(base, options)
  const before = await waitForState(s => s.phase === 'ready' && s.totalDiagrams === 3)

  await exec('node', ['scripts/watch-ctl.mjs', 'set', newFile, '--base', base], options)
  const tab = await context.newPage()
  await tab.goto(base, options)
  await tab.getByText('Preparing layout…').waitFor({ state: 'visible', ...options })
  const draft = await waitForState(s => s.phase === 'ready' && s.totalDiagrams === 2 && s.watchingTabs === 2)
  assert.equal(draft.overlapCount, 1)
  for (const page of [previous, tab]) assert.equal(await page.getByTestId('app-root').isVisible(), false)

  const wrongLayout = await fetch(`${base}/__prettyfish/watch/layout`, {
    method: 'POST',
    body: JSON.stringify({ ...before, tabId: 'wrong-layout', docHash: draft.docHash }),
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(2000),
  })
  assert.ok(wrongLayout.ok)
  assert.equal((await state()).totalDiagrams, 2)

  const args = ['--experimental-strip-types', 'scripts/layout-tidy.mjs', newFile, '--base', base, '--timeout', '10000']
  await exec('node', args, options)
  for (const page of [previous, tab]) await page.getByTestId('app-root').waitFor({ state: 'visible', ...options })
  const checked = await waitForState(s => s.phase === 'ready' && s.overlapCount === 0 && s.tabs.filter(t => t.current).length === 2)
  assert.notEqual(checked.docHash, draft.docHash)
  assert.ok(checked.tabs.some(t => t.tabId === before.tabId && t.current))
  assert.equal(context.pages().length, 2)
  const { stdout } = await exec('node', [...args, '--check'], options)
  assert.match(stdout, /layout:check clean - 2 diagrams, no overlaps/)
  console.log('The same tabs applied the packed revision; no draft canvas or overlaps.')
} finally {
  await browser?.close()
  await server?.close()
  await rm(dir, { recursive: true, force: true })
}
