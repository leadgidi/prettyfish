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
            const snapshot = JSON.parse(body || '{}') as Record<string, unknown>
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
