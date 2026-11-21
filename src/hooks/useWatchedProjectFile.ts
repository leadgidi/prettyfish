import { useEffect, useState } from 'react'
import type { Dispatch } from 'react'

import { normalizeAppState } from '../lib/documentState'
import { watchTabId } from '../lib/watchTab'
import { withRuntimePagesState } from '../types'
import type { AppAction } from '../state/appStore'

export function useWatchedProjectFile(enabled: boolean, dispatch: Dispatch<AppAction>): string | null {
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled) return
    const lifetime = new AbortController()
    const source = new EventSource(`/__prettyfish/watch/events?tab=${watchTabId}`)
    let etag: string | null = null
    let connection = 0
    source.onopen = () => {
      connection++
      etag = null
    }
    let timer: ReturnType<typeof setTimeout>

    // Reconcile against disk even if the connection missed a change event.
    const reconcile = async () => {
      const startedOn = connection
      try {
        const response = await fetch('/__prettyfish/watch/project', {
          headers: etag ? { 'If-None-Match': etag } : {},
          signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(5000)]),
          cache: 'no-store',
        })
        if (response.status !== 304) {
          if (!response.ok) throw new Error(`Could not load the watched map (${response.status}).`)
          const revision = response.headers.get('X-PrettyFish-Doc-Hash')
          const state = normalizeAppState(await response.json())
          if (!revision || !state) throw new Error('Invalid watched map.')
          if (lifetime.signal.aborted) return
          dispatch({
            type: 'watch/apply',
            revision,
            snapshot: { ...state, pages: withRuntimePagesState(state.pages) },
          })
          if (startedOn === connection) etag = response.headers.get('ETag')
        }
        if (!lifetime.signal.aborted) setError(null)
      } catch (cause) {
        if (!lifetime.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (!lifetime.signal.aborted) timer = setTimeout(() => void reconcile(), 750)
      }
    }
    void reconcile()

    return () => {
      lifetime.abort()
      clearTimeout(timer)
      source.close()
    }
  }, [enabled, dispatch])

  return error
}
