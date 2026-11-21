import { useEffect, useRef } from 'react'
import type { Dispatch } from 'react'

import { normalizeAppState } from '../lib/documentState'
import { setWatchedDocHash } from '../lib/watchDocHash'
import { withRuntimePagesState } from '../types'
import type { AppAction } from '../state/appStore'

interface WatchStatus {
  enabled: boolean
  path?: string
  exists?: boolean
  mtimeMs?: number | null
}

/**
 * When the Vite dev server is started with PRETTYFISH_WATCH_FILE, load that
 * project and hot-reload it whenever the file changes on disk.
 */
export function useWatchedProjectFile(dispatch: Dispatch<AppAction>): void {
  const lastPayloadRef = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let source: EventSource | null = null

    const applyProject = async () => {
      const response = await fetch('/__prettyfish/watch/project', { cache: 'no-store' })
      if (!response.ok) {
        const body = await response.text()
        console.warn('[prettyfish-watch] failed to load project', response.status, body)
        return
      }
      setWatchedDocHash(response.headers.get('X-PrettyFish-Doc-Hash'))
      const rawText = await response.text()
      if (rawText === lastPayloadRef.current) return

      const parsed = JSON.parse(rawText) as unknown
      const state = normalizeAppState(parsed)
      if (!state) {
        console.warn('[prettyfish-watch] project JSON failed schema normalization')
        return
      }
      if (cancelled) return

      lastPayloadRef.current = rawText
      dispatch({
        type: 'document/restore',
        snapshot: {
          pages: withRuntimePagesState(state.pages),
          activePageId: state.activePageId,
          mode: state.mode,
          editorLigatures: state.editorLigatures,
          autoFormat: state.autoFormat,
        },
      })
      console.info('[prettyfish-watch] loaded project from disk')
    }

    const start = async () => {
      try {
        const statusRes = await fetch('/__prettyfish/watch/status', { cache: 'no-store' })
        if (!statusRes.ok) return
        const status = (await statusRes.json()) as WatchStatus
        if (!status.enabled) return
        if (cancelled) return

        console.info('[prettyfish-watch] enabled', status.path)
        await applyProject()
        if (cancelled) return

        source = new EventSource('/__prettyfish/watch/events')
        source.addEventListener('change', () => {
          void applyProject()
        })
        source.addEventListener('error', (event) => {
          // EventSource also fires 'error' on connection drops; keep quiet unless data.
          if ('data' in event && typeof (event as MessageEvent).data === 'string') {
            console.warn('[prettyfish-watch]', (event as MessageEvent).data)
          }
        })
      } catch (error) {
        console.warn('[prettyfish-watch] unavailable', error)
      }
    }

    void start()

    return () => {
      cancelled = true
      source?.close()
    }
  }, [dispatch])
}
