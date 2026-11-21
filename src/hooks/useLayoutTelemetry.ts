/**
 * Dev-only layout telemetry for watched projects.
 * Posts per-page diagram x/y/width/cardHeight after Mermaid render completes
 * so agents can detect overlaps from disk logs.
 */
import { useEffect, useState } from 'react'
import { cardHeightFor, findOverlappingBoxes } from '../lib/cardLayout'
import type { Diagram, DiagramPage } from '../types'

const LAYOUT_ENDPOINT = '/__prettyfish/watch/layout'
/** One id per page load: a reload is a new measurement source. */
const TAB_ID =
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`
const DEBOUNCE_MS = 350

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
  /** Stable id for this tab, so several tabs can be told apart. */
  tabId: string
  /** Hash of the watched document these measurements belong to. */
  docHash: string | null
  activePageId: string
  pages: LayoutPageMeasurement[]
  readyDiagrams: number
  totalDiagrams: number
  overlapCount: number
}

declare global {
  interface Window {
    /**
     * Latest measured layout, published for headless tooling
     * (scripts/layout-tidy.mjs). Read-only: never write this yourself.
     */
    __prettyfishLayoutSnapshot?: LayoutSnapshot
  }
}

function findOverlaps(
  diagrams: LayoutDiagramMeasurement[],
): Array<{ a: string; b: string }> {
  return findOverlappingBoxes(
    diagrams.map((diagram) => ({
      id: diagram.id,
      name: diagram.name,
      x: diagram.x,
      y: diagram.y,
      width: diagram.width,
      height: diagram.cardHeight,
    })),
  ).map(([a, b]) => ({ a: a.name, b: b.name }))
}

function measureDiagram(diagram: Diagram): LayoutDiagramMeasurement {
  const svgWidth = diagram.render?.svgWidth ?? null
  const svgHeight = diagram.render?.svgHeight ?? null
  // The canvas may still display the previous revision. Use this revision's
  // rendered SVG dimensions and the shared card layout instead of that DOM.
  const cardHeight = cardHeightFor(diagram)
  return {
    id: diagram.id,
    name: diagram.name,
    x: diagram.x,
    y: diagram.y,
    width: diagram.width,
    svgWidth,
    svgHeight,
    cardHeight,
    domHeight: null,
    right: diagram.x + diagram.width,
    bottom: diagram.y + cardHeight,
    renderStatus: diagram.render?.status ?? null,
  }
}

function buildSnapshot(pages: DiagramPage[], activePageId: string, revision: string): LayoutSnapshot {
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
    tabId: TAB_ID,
    docHash: revision,
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
export function useLayoutTelemetry(pages: DiagramPage[], activePageId: string, revision: string | null) {
  const [measurement, setMeasurement] = useState<LayoutSnapshot | null>(null)

  useEffect(() => {
    if (revision === null) return
    const timer = setTimeout(() => {
      const snapshot = buildSnapshot(pages, activePageId, revision)
      window.__prettyfishLayoutSnapshot = snapshot
      setMeasurement(snapshot)
      const payload = JSON.stringify(snapshot)

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

    return () => clearTimeout(timer)
  }, [pages, activePageId, revision])

  return measurement?.docHash === revision ? measurement : null
}
