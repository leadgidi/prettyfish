import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Plugin, ViteDevServer } from 'vite'

type WatchClient = {
  id: number
  res: import('node:http').ServerResponse
}

type WatchSession = {
  absPath: string
  lastMtimeMs: number | null
  closeWatcher: () => void
}

/** Phase reported by GET /__prettyfish/watch/state — the only supported contract. */
type WatchMeasurePhase = 'no-tab' | 'rendering' | 'stale-app' | 'error' | 'ready'

type MeasureSnapshot = {
  tabId?: string
  docHash?: string
  readyDiagrams?: number
  totalDiagrams?: number
  pages?: Array<{ diagrams?: Array<{ renderStatus?: string | null }> }>
  [key: string]: unknown
}

const DOC_HASH_HEADER = 'X-PrettyFish-Doc-Hash'
const LOCAL_RUN_DIR = path.resolve(process.cwd(), '.local-run')
const LAYOUT_JSON = path.join(LOCAL_RUN_DIR, 'diagram-layout.json')
const LAYOUT_JSONL = path.join(LOCAL_RUN_DIR, 'diagram-layout.jsonl')

/**
 * Dev-only: serve + SSE-watch a .prettyfish.json on disk.
 * Set PRETTYFISH_WATCH_FILE to an absolute or cwd-relative path at start.
 * Switch the watched file at runtime with PUT /__prettyfish/watch/file
 * (see scripts/watch-ctl.mjs).
 *
 * Layout telemetry (browser → disk):
 *   POST /__prettyfish/watch/layout  — snapshot of page/diagram sizes after render
 *   GET  /__prettyfish/watch/layout  — latest snapshot
 * Writes `.local-run/diagram-layout.json` (+ append-only `.jsonl`).
 */
export function watchProjectFilePlugin(): Plugin {
  const initial = process.env.PRETTYFISH_WATCH_FILE?.trim()

  return {
    name: 'prettyfish-watch-project',
    configureServer(server) {
      if (!initial) {
        server.middlewares.use('/__prettyfish/watch/status', (_req, res) => {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ enabled: false }))
        })
        return
      }

      const clients = new Map<number, WatchClient>()
      let nextClientId = 1
      let session: WatchSession | null = null
      // One entry per tab. Several tabs can be connected and an old one can
      // keep posting, so tabs are never merged: each reports its own document
      // hash and its own render state, and the answer is chosen by hash.
      const measures = new Map<string, { snapshot: MeasureSnapshot; receivedAt: number }>()
      const MAX_REMEMBERED_TABS = 16

      const rememberMeasure = (snapshot: MeasureSnapshot) => {
        const tabId = typeof snapshot.tabId === 'string' ? snapshot.tabId : 'unknown-tab'
        measures.delete(tabId)
        measures.set(tabId, { snapshot, receivedAt: Date.now() })
        while (measures.size > MAX_REMEMBERED_TABS) {
          const oldest = measures.keys().next().value
          if (oldest === undefined) break
          measures.delete(oldest)
        }
      }

      const broadcast = (event: string, data: unknown) => {
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
        for (const client of clients.values()) {
          client.res.write(payload)
        }
      }

      const statusPayload = () => {
        if (!session) {
          return {
            enabled: true,
            path: null,
            exists: false,
            mtimeMs: null,
            layoutLog: LAYOUT_JSON,
          }
        }
        return {
          enabled: true,
          path: session.absPath,
          exists: fs.existsSync(session.absPath),
          mtimeMs: safeMtime(session.absPath),
          layoutLog: LAYOUT_JSON,
        }
      }

      const notifyChange = () => {
        if (!session) return
        const mtimeMs = safeMtime(session.absPath)
        if (mtimeMs == null) {
          broadcast('error', { message: `Watched file missing: ${session.absPath}` })
          return
        }
        if (mtimeMs === session.lastMtimeMs) return
        session.lastMtimeMs = mtimeMs
        broadcast('change', { path: session.absPath, mtimeMs })
      }

      const setWatchedFile = (nextPath: string) => {
        const absPath = path.resolve(nextPath)
        if (!fs.existsSync(absPath)) {
          throw new Error(`File not found: ${absPath}`)
        }
        const raw = fs.readFileSync(absPath, 'utf8')
        JSON.parse(raw)

        session?.closeWatcher()
        const closeWatcher = attachWatcher(absPath, server, notifyChange)
        session = {
          absPath,
          lastMtimeMs: safeMtime(absPath),
          closeWatcher,
        }
        server.config.logger.info(`[prettyfish-watch] watching ${absPath}`, { timestamp: true })
        broadcast('change', { path: absPath, mtimeMs: session.lastMtimeMs })
        return statusPayload()
      }

      setWatchedFile(initial)

      server.middlewares.use('/__prettyfish/watch/status', (_req, res) => {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(statusPayload()))
      })

      server.middlewares.use('/__prettyfish/watch/file', (req, res) => {
        if (req.method !== 'PUT' && req.method !== 'POST') {
          res.statusCode = 405
          res.setHeader('Allow', 'PUT, POST')
          res.end(JSON.stringify({ error: 'Method not allowed' }))
          return
        }

        const chunks: Buffer[] = []
        req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        req.on('end', () => {
          try {
            const body = Buffer.concat(chunks).toString('utf8')
            const parsed = JSON.parse(body || '{}') as { path?: unknown }
            if (typeof parsed.path !== 'string' || !parsed.path.trim()) {
              res.statusCode = 400
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ error: 'Body must be JSON: { "path": "/abs/file.prettyfish.json" }' }))
              return
            }
            const status = setWatchedFile(parsed.path.trim())
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(status))
          } catch (error) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json')
            res.end(
              JSON.stringify({
                error: error instanceof Error ? error.message : 'Failed to set watched file',
              }),
            )
          }
        })
      })

      server.middlewares.use('/__prettyfish/watch/layout', (req, res) => {
        if (req.method === 'GET') {
          try {
            if (!fs.existsSync(LAYOUT_JSON)) {
              res.statusCode = 404
              res.setHeader('Content-Type', 'application/json')
              res.end(
                JSON.stringify({
                  error: 'No layout snapshot yet — open the app and wait for Mermaid render',
                }),
              )
              return
            }
            res.setHeader('Content-Type', 'application/json')
            res.setHeader('Cache-Control', 'no-store')
            res.end(fs.readFileSync(LAYOUT_JSON, 'utf8'))
          } catch (error) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json')
            res.end(
              JSON.stringify({
                error: error instanceof Error ? error.message : 'Failed to read layout log',
              }),
            )
          }
          return
        }

        if (req.method !== 'POST' && req.method !== 'PUT') {
          res.statusCode = 405
          res.setHeader('Allow', 'GET, PUT, POST')
          res.end(JSON.stringify({ error: 'Method not allowed' }))
          return
        }

        const chunks: Buffer[] = []
        req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        req.on('end', () => {
          try {
            const body = Buffer.concat(chunks).toString('utf8')
            const snapshot = JSON.parse(body || '{}') as MeasureSnapshot
            rememberMeasure(snapshot)
            fs.mkdirSync(LOCAL_RUN_DIR, { recursive: true })
            const enriched: Record<string, unknown> = {
              ...snapshot,
              projectPath: session?.absPath ?? null,
              receivedAt: new Date().toISOString(),
            }
            const text = `${JSON.stringify(enriched, null, 2)}\n`
            fs.writeFileSync(LAYOUT_JSON, text)
            fs.appendFileSync(LAYOUT_JSONL, `${JSON.stringify(enriched)}\n`)

            const overlapCount =
              typeof enriched.overlapCount === 'number'
                ? enriched.overlapCount
                : Array.isArray(enriched.pages)
                  ? (enriched.pages as Array<{ overlaps?: unknown[] }>).reduce(
                      (n, p) => n + (Array.isArray(p.overlaps) ? p.overlaps.length : 0),
                      0,
                    )
                  : 0
            const ready =
              typeof enriched.readyDiagrams === 'number' ? enriched.readyDiagrams : '?'
            const total =
              typeof enriched.totalDiagrams === 'number' ? enriched.totalDiagrams : '?'
            server.config.logger.info(
              `[prettyfish-layout] wrote ${LAYOUT_JSON} ready=${ready}/${total} overlaps=${overlapCount}`,
              { timestamp: true },
            )

            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ ok: true, path: LAYOUT_JSON, overlapCount }))
          } catch (error) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json')
            res.end(
              JSON.stringify({
                error: error instanceof Error ? error.message : 'Failed to store layout snapshot',
              }),
            )
          }
        })
      })

      server.middlewares.use('/__prettyfish/watch/project', (_req, res) => {
        try {
          if (!session || !fs.existsSync(session.absPath)) {
            res.statusCode = 404
            res.setHeader('Content-Type', 'application/json')
            res.end(
              JSON.stringify({
                error: `File not found: ${session?.absPath ?? '(none)'}`,
              }),
            )
            return
          }
          const raw = fs.readFileSync(session.absPath, 'utf8')
          JSON.parse(raw)
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Cache-Control', 'no-store')
          // The app echoes this back in its measurements, so the tool can tell a
          // stale tab from a current one.
          res.setHeader(DOC_HASH_HEADER, createHash('sha256').update(raw).digest('hex'))
          res.end(raw)
        } catch (error) {
          res.statusCode = 400
          res.setHeader('Content-Type', 'application/json')
          res.end(
            JSON.stringify({
              error: error instanceof Error ? error.message : 'Failed to read project file',
            }),
          )
        }
      })

      /**
       * The measurement contract for tools: ask what the open tab currently
       * knows about the file on disk. 200 with a phase; never guesses.
       */
      server.middlewares.use('/__prettyfish/watch/state', (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const requestedHash = url.searchParams.get('hash')
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Cache-Control', 'no-store')

        if (!session) {
          res.end(JSON.stringify({ phase: 'no-tab', reason: 'no watched file', watchingTabs: 0 }))
          return
        }

        const raw = fs.readFileSync(session.absPath, 'utf8')
        const docHash = createHash('sha256').update(raw).digest('hex')
        const tabs = [...measures.entries()]
          .map(([tabId, entry]) => ({
            tabId,
            docHash: typeof entry.snapshot.docHash === 'string' ? entry.snapshot.docHash : null,
            readyDiagrams: Number(entry.snapshot.readyDiagrams ?? 0),
            totalDiagrams: Number(entry.snapshot.totalDiagrams ?? 0),
            overlapCount: Number(entry.snapshot.overlapCount ?? 0),
            current: entry.snapshot.docHash === docHash,
            receivedAt: entry.receivedAt,
          }))
          .sort((a, b) => b.receivedAt - a.receivedAt)
        const matched = tabs.find((tab) => tab.current)
          ? { snapshot: measures.get(tabs.find((tab) => tab.current)!.tabId)!.snapshot,
              receivedAt: tabs.find((tab) => tab.current)!.receivedAt }
          : null
        const snapshot = matched?.snapshot ?? null
        const staleTabs = tabs.filter((tab) => !tab.current).length
        const watchingTabs = clients.size
        const measuredHash = snapshot ? docHash : null
        const readyDiagrams = Number(snapshot?.readyDiagrams ?? 0)
        const totalDiagrams = Number(snapshot?.totalDiagrams ?? 0)
        const failed = (snapshot?.pages ?? []).flatMap((page) =>
          (page.diagrams ?? [])
            .filter((diagram) => diagram.renderStatus === 'error')
            .map(() => true),
        )

        let phase: WatchMeasurePhase = 'ready'
        let reason = ''
        if (watchingTabs === 0) {
          phase = 'no-tab'
          reason = 'no browser tab is connected to the watch server'
        } else if (!snapshot && measures.size === 0) {
          phase = 'rendering'
          reason = 'the connected tab has not reported measurements yet'
        } else if (!snapshot) {
          phase = 'stale-app'
          reason =
            staleTabs > 0
              ? `${staleTabs} tab(s) show another version of the file; none has this one. Reload the tab.`
              : 'no connected tab has applied this version of the file yet'
        } else if (totalDiagrams === 0 || readyDiagrams !== totalDiagrams) {
          phase = 'rendering'
          reason = `rendered ${readyDiagrams}/${totalDiagrams} diagrams`
        } else if (failed.length > 0) {
          phase = 'error'
          reason = `${failed.length} diagram(s) failed to render`
        }

        res.end(
          JSON.stringify({
            phase,
            reason,
            docHash,
            requestedHash,
            appliedHash: measuredHash,
            watchingTabs,
            readyDiagrams,
            totalDiagrams,
            receivedAt: matched?.receivedAt ?? null,
            documentsReporting: new Set(tabs.map((tab) => tab.docHash)).size,
            tabs,
            pages: snapshot?.pages ?? [],
            overlapCount: snapshot?.overlapCount ?? 0,
          }),
        )
      })

      server.middlewares.use('/__prettyfish/watch/events', (req, res) => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        })
        res.write(
          `event: hello\ndata: ${JSON.stringify({
            path: session?.absPath ?? null,
            mtimeMs: session?.lastMtimeMs ?? null,
          })}\n\n`,
        )

        const id = nextClientId++
        clients.set(id, { id, res })
        req.on('close', () => {
          clients.delete(id)
        })
      })
    },
  }
}

function safeMtime(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs
  } catch {
    return null
  }
}

function attachWatcher(
  absPath: string,
  server: ViteDevServer,
  onChange: () => void,
): () => void {
  const dir = path.dirname(absPath)
  const base = path.basename(absPath)

  // Watch the directory so atomic renames (editor save) are detected.
  try {
    const watcher = fs.watch(dir, { persistent: true }, (_event, filename) => {
      if (!filename || filename === base || filename.toString() === base) {
        setTimeout(onChange, 50)
      }
    })
    const close = () => watcher.close()
    server.httpServer?.once('close', close)
    return close
  } catch (error) {
    server.config.logger.error(
      `[prettyfish-watch] failed to watch ${absPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    return () => {}
  }
}
