/**
 * Dev-only layout telemetry for watched projects.
 * Posts per-page diagram x/y/width/cardHeight after Mermaid render completes
 * so agents can detect overlaps from disk logs.
 */
import { useEffect, useRef } from 'react'
import type { Diagram, DiagramPage } from '../types'

const LAYOUT_ENDPOINT = '/__prettyfish/watch/layout'
const DEBOUNCE_MS = 350
const LABEL_CHROME_PX = 72

export type LayoutDiagramMeasurement = {
  id: string
  name: string
  x: number
  y: number
  width: number
  svgWidth: number | null
  svgHeight: number | null
  cardHeight: number
  domHeight: number | null
  right: number
  bottom: number
  renderStatus: string | null
}

export type LayoutPageMeasurement = {
  pageId: string
  pageName: string
  diagrams: LayoutDiagramMeasurement[]
  overlaps: Array<{ a: string; b: string }>
}

export type LayoutSnapshot = {
  ts: string
  activePageId: string
  pages: LayoutPageMeasurement[]
  readyDiagrams: number
  totalDiagrams: number
  overlapCount: number
}

/** Same sizing rules as DiagramNode preview (scale never > 1). */
export function estimateCardHeight(
  width: number,
  svgWidth: number | null,
  svgHeight: number | null,
): number {
  if (svgWidth == null || svgHeight == null || svgWidth <= 0 || svgHeight <= 0) {
    return 300
  }
  const scale = Math.min(1, Math.max(0, (width - 32) / svgWidth))
  const preview = Math.max(240, Math.ceil(svgHeight * scale) + 8)
  return Math.max(300, LABEL_CHROME_PX + preview)
}

function findOverlaps(
  diagrams: LayoutDiagramMeasurement[],
): Array<{ a: string; b: string }> {
  const overlaps: Array<{ a: string; b: string }> = []
  for (let i = 0; i < diagrams.length; i++) {
    for (let j = i + 1; j < diagrams.length; j++) {
      const a = diagrams[i]!
      const b = diagrams[j]!
      if (a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y) {
        overlaps.push({ a: a.name, b: b.name })
      }
    }
  }
  return overlaps
}

function measureDiagram(diagram: Diagram): LayoutDiagramMeasurement {
  const svgWidth = diagram.render?.svgWidth ?? null
  const svgHeight = diagram.render?.svgHeight ?? null
  let domHeight: number | null = null
  if (typeof document !== 'undefined') {
    const el = document.querySelector(
      `[data-diagram-id="${CSS.escape(diagram.id)}"]`,
    ) as HTMLElement | null
    if (el?.offsetHeight) domHeight = el.offsetHeight
  }
  const estimated = estimateCardHeight(diagram.width, svgWidth, svgHeight)
  const cardHeight = Math.max(estimated, domHeight ?? 0)
  return {
    id: diagram.id,
    name: diagram.name,
    x: diagram.x,
    y: diagram.y,
    width: diagram.width,
    svgWidth,
    svgHeight,
    cardHeight,
    domHeight,
    right: diagram.x + diagram.width,
    bottom: diagram.y + cardHeight,
    renderStatus: diagram.render?.status ?? null,
  }
}

function buildSnapshot(pages: DiagramPage[], activePageId: string): LayoutSnapshot {
  let readyDiagrams = 0
  let totalDiagrams = 0
  const pageMeasurements: LayoutPageMeasurement[] = pages.map((page) => {
    const diagrams = page.diagrams.map((diagram) => {
      totalDiagrams += 1
      if (diagram.render?.status === 'ready' && diagram.render.svgWidth && diagram.render.svgHeight) {
        readyDiagrams += 1
      }
      return measureDiagram(diagram)
    })
    return {
      pageId: page.id,
      pageName: page.name,
      diagrams,
      overlaps: findOverlaps(diagrams),
    }
  })
  return {
    ts: new Date().toISOString(),
    activePageId,
    pages: pageMeasurements,
    readyDiagrams,
    totalDiagrams,
    overlapCount: pageMeasurements.reduce((n, p) => n + p.overlaps.length, 0),
  }
}

/**
 * When watch mode is on, debounce-post layout snapshots after renders settle.
 */
export function useLayoutTelemetry(pages: DiagramPage[], activePageId: string): void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastPayloadRef = useRef<string>('')

  useEffect(() => {
    if (typeof window === 'undefined') return
    // Only in Vite watch / local app — endpoint 404s otherwise (ignored).
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      const snapshot = buildSnapshot(pages, activePageId)
      // Prefer logging once we have at least one ready diagram.
      if (snapshot.readyDiagrams === 0) return
      const payload = JSON.stringify(snapshot)
      if (payload === lastPayloadRef.current) return
      lastPayloadRef.current = payload

      for (const page of snapshot.pages) {
        for (const d of page.diagrams) {
          // Structured line for Vite / browser consoles and agent grepping.
          console.info(
            `[prettyfish-layout] page=${JSON.stringify(page.pageName)} diagram=${JSON.stringify(d.name)} ` +
              `x=${d.x} y=${d.y} w=${d.width} h=${d.cardHeight} svg=${d.svgWidth ?? '-'}x${d.svgHeight ?? '-'} ` +
              `status=${d.renderStatus ?? '-'}`,
          )
        }
        if (page.overlaps.length > 0) {
          console.warn(
            `[prettyfish-layout] overlaps on ${JSON.stringify(page.pageName)}: ` +
              page.overlaps.map((o) => `${o.a} x ${o.b}`).join(', '),
          )
        }
      }

      void fetch(LAYOUT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true,
      }).catch(() => {
        // Watch server may be absent outside dev:watch — ignore.
      })
    }, DEBOUNCE_MS)

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [pages, activePageId])
}
