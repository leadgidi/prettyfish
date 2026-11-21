#!/usr/bin/env node
/**
 * Validate a .prettyfish.json project: document shape + Mermaid parse of every diagram.
 *
 * Usage:
 *   node --experimental-strip-types scripts/validate-project.mjs <file.prettyfish.json>
 *   node --experimental-strip-types scripts/validate-project.mjs --from-watch [--base http://127.0.0.1:5173]
 *   npm run validate:project -- ./map.prettyfish.json
 *   npm run watch:validate
 */
import fs from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'

function printUsage(exitCode = 1) {
  console.error(`Usage:
  node --experimental-strip-types scripts/validate-project.mjs <file.prettyfish.json>
  node --experimental-strip-types scripts/validate-project.mjs --from-watch [--base http://127.0.0.1:5173]
`)
  process.exit(exitCode)
}

function parseArgs(argv) {
  let file = ''
  let fromWatch = false
  let base = process.env.PRETTYFISH_WATCH_BASE?.trim() || 'http://127.0.0.1:5173'

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') printUsage(0)
    if (arg === '--from-watch') {
      fromWatch = true
      continue
    }
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

  return { file, fromWatch, base: base.replace(/\/$/, '') }
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Strict project shape checks. Soft normalizeAppState recovers bad files;
 * this validator fails them instead.
 */
function validateDocumentShape(raw) {
  const issues = []

  if (!isObject(raw)) {
    return [{ path: '', message: 'Root must be a JSON object' }]
  }

  if (raw.version !== 1) {
    issues.push({ path: 'version', message: `Expected version 1, got ${JSON.stringify(raw.version)}` })
  }

  if (!Array.isArray(raw.pages) || raw.pages.length === 0) {
    issues.push({ path: 'pages', message: 'pages must be a non-empty array' })
    return issues
  }

  if (typeof raw.activePageId !== 'string' || !raw.activePageId) {
    issues.push({ path: 'activePageId', message: 'activePageId must be a non-empty string' })
  } else if (!raw.pages.some((page) => isObject(page) && page.id === raw.activePageId)) {
    issues.push({ path: 'activePageId', message: `activePageId ${JSON.stringify(raw.activePageId)} not found in pages` })
  }

  if (raw.mode !== undefined && raw.mode !== 'light' && raw.mode !== 'dark') {
    issues.push({ path: 'mode', message: `mode must be "light" or "dark", got ${JSON.stringify(raw.mode)}` })
  }

  const pageIds = new Set()
  const diagramIds = new Set()

  raw.pages.forEach((page, pageIndex) => {
    const pagePath = `pages[${pageIndex}]`
    if (!isObject(page)) {
      issues.push({ path: pagePath, message: 'page must be an object' })
      return
    }

    if (typeof page.id !== 'string' || !page.id) {
      issues.push({ path: `${pagePath}.id`, message: 'page.id must be a non-empty string' })
    } else if (pageIds.has(page.id)) {
      issues.push({ path: `${pagePath}.id`, message: `duplicate page id ${JSON.stringify(page.id)}` })
    } else {
      pageIds.add(page.id)
    }

    if (typeof page.name !== 'string' || !page.name.trim()) {
      issues.push({ path: `${pagePath}.name`, message: 'page.name must be a non-empty string' })
    }

    if (!Array.isArray(page.diagrams) || page.diagrams.length === 0) {
      issues.push({ path: `${pagePath}.diagrams`, message: 'page.diagrams must be a non-empty array' })
      return
    }

    if (typeof page.activeDiagramId !== 'string' || !page.activeDiagramId) {
      issues.push({
        path: `${pagePath}.activeDiagramId`,
        message: 'activeDiagramId must be a non-empty string',
      })
    } else if (!page.diagrams.some((diagram) => isObject(diagram) && diagram.id === page.activeDiagramId)) {
      issues.push({
        path: `${pagePath}.activeDiagramId`,
        message: `activeDiagramId ${JSON.stringify(page.activeDiagramId)} not found on this page`,
      })
    }

    page.diagrams.forEach((diagram, diagramIndex) => {
      const diagramPath = `${pagePath}.diagrams[${diagramIndex}]`
      if (!isObject(diagram)) {
        issues.push({ path: diagramPath, message: 'diagram must be an object' })
        return
      }

      if (typeof diagram.id !== 'string' || !diagram.id) {
        issues.push({ path: `${diagramPath}.id`, message: 'diagram.id must be a non-empty string' })
      } else if (diagramIds.has(diagram.id)) {
        issues.push({ path: `${diagramPath}.id`, message: `duplicate diagram id ${JSON.stringify(diagram.id)}` })
      } else {
        diagramIds.add(diagram.id)
      }

      if (typeof diagram.name !== 'string' || !diagram.name.trim()) {
        issues.push({ path: `${diagramPath}.name`, message: 'diagram.name must be a non-empty string' })
      }

      if (typeof diagram.code !== 'string' || !diagram.code.trim()) {
        issues.push({ path: `${diagramPath}.code`, message: 'diagram.code must be a non-empty string' })
      }

      for (const numKey of ['x', 'y', 'width']) {
        if (typeof diagram[numKey] !== 'number' || !Number.isFinite(diagram[numKey])) {
          issues.push({
            path: `${diagramPath}.${numKey}`,
            message: `${numKey} must be a finite number`,
          })
        }
      }

      if (diagram.width !== undefined && typeof diagram.width === 'number' && diagram.width <= 0) {
        issues.push({ path: `${diagramPath}.width`, message: 'width must be > 0' })
      }
    })
  })

  return issues
}

function collectDiagrams(raw) {
  const diagrams = []
  if (!Array.isArray(raw?.pages)) return diagrams

  raw.pages.forEach((page, pageIndex) => {
    if (!isObject(page) || !Array.isArray(page.diagrams)) return
    page.diagrams.forEach((diagram, diagramIndex) => {
      if (!isObject(diagram) || typeof diagram.code !== 'string') return
      diagrams.push({
        pageIndex,
        diagramIndex,
        pageName: typeof page.name === 'string' ? page.name : `pages[${pageIndex}]`,
        diagramName: typeof diagram.name === 'string' ? diagram.name : `diagrams[${diagramIndex}]`,
        code: diagram.code,
      })
    })
  })

  return diagrams
}

function installDomGlobals() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://127.0.0.1/',
  })
  const { window } = dom

  for (const key of [
    'window',
    'document',
    'DOMParser',
    'HTMLElement',
    'SVGElement',
    'Element',
    'Node',
    'DocumentFragment',
    'XMLSerializer',
  ]) {
    Object.defineProperty(globalThis, key, {
      value: key === 'window' ? window : window[key],
      configurable: true,
    })
  }
  Object.defineProperty(globalThis, 'navigator', {
    value: window.navigator,
    configurable: true,
  })
  Object.defineProperty(globalThis, 'self', {
    value: globalThis,
    configurable: true,
  })
}

async function validateMermaid(diagrams) {
  installDomGlobals()
  const mermaid = (await import('mermaid')).default
  mermaid.initialize({ startOnLoad: false, securityLevel: 'loose' })

  const failures = []
  let passed = 0

  for (const diagram of diagrams) {
    try {
      await mermaid.parse(diagram.code)
      passed++
    } catch (error) {
      failures.push({
        ...diagram,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return { passed, failures }
}

async function loadProject({ file, fromWatch, base }) {
  if (fromWatch) {
    const statusRes = await fetch(`${base}/__prettyfish/watch/status`)
    if (!statusRes.ok) {
      throw new Error(`Watch status HTTP ${statusRes.status}`)
    }
    const status = await statusRes.json()
    if (!status.enabled) {
      throw new Error('Watch mode is not enabled on that server')
    }

    const projectRes = await fetch(`${base}/__prettyfish/watch/project`, { cache: 'no-store' })
    if (!projectRes.ok) {
      const body = await projectRes.text()
      throw new Error(`Watch project HTTP ${projectRes.status}: ${body}`)
    }
    const text = await projectRes.text()
    return {
      source: status.path ?? `${base}/__prettyfish/watch/project`,
      raw: JSON.parse(text),
    }
  }

  if (!file) printUsage()
  const absFile = path.resolve(process.cwd(), file)
  if (!fs.existsSync(absFile)) {
    throw new Error(`File not found: ${absFile}`)
  }
  const text = fs.readFileSync(absFile, 'utf8')
  return { source: absFile, raw: JSON.parse(text) }
}

const args = parseArgs(process.argv.slice(2))
if (!args.fromWatch && !args.file) printUsage()

let loaded
try {
  loaded = await loadProject(args)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}

const { source, raw } = loaded
console.log(`Validating ${source}\n`)

const shapeIssues = validateDocumentShape(raw)
const diagrams = collectDiagrams(raw)
const mermaidResult = await validateMermaid(diagrams)

for (const issue of shapeIssues) {
  console.error(`  shape  ${issue.path || '(root)'}: ${issue.message}`)
}

for (const failure of mermaidResult.failures) {
  console.error(
    `  mermaid  [${failure.pageName}] "${failure.diagramName}" (pages[${failure.pageIndex}].diagrams[${failure.diagramIndex}])`,
  )
  for (const line of failure.message.split('\n').slice(0, 8)) console.error(`           ${line}`)
  const lineNumber = Number(failure.message.match(/on line (\d+)/)?.[1])
  if (lineNumber > 0) {
    const lines = failure.code.split('\n')
    for (let i = Math.max(0, lineNumber - 2); i < Math.min(lines.length, lineNumber + 1); i++) {
      console.error(`           ${i + 1}: ${lines[i]}`)
    }
  }
}

console.log('─'.repeat(60))
console.log(
  `Shape: ${shapeIssues.length === 0 ? 'ok' : `${shapeIssues.length} issue(s)`}; Mermaid: ${mermaidResult.passed} passed, ${mermaidResult.failures.length} failed (${diagrams.length} diagrams)`,
)

if (shapeIssues.length > 0 || mermaidResult.failures.length > 0) {
  process.exit(1)
}

console.log('Project OK')
process.exit(0)
