/**
 * Card geometry and page packing for the infinite canvas.
 *
 * A diagram persists only x/y/width. Its height comes from the rendered Mermaid
 * SVG, so every consumer that needs a card's footprint — the canvas node, layout
 * telemetry, the headless layout tooling — must derive it with the same formula.
 * When two of them disagree, cards overlap.
 */
import type { Diagram } from '../types'

/** Label header above the preview: name input plus description input. */
export const LABEL_CHROME_PX = 72
/** Smallest card the canvas ever draws (DiagramNode minHeight). */
export const MIN_CARD_HEIGHT = 300
/** Horizontal padding inside the preview area, 16px on each side. */
export const PREVIEW_HORIZONTAL_PADDING_PX = 32
/** Vertical padding added around the scaled SVG. */
export const PREVIEW_VERTICAL_PAD_PX = 8
/** Smallest preview area (the preview div's own minHeight). */
export const PREVIEW_MIN_HEIGHT_PX = 240

export interface DiagramCard {
  id: string
  width: number
  height: number
}

export interface CardPosition {
  id: string
  x: number
  y: number
}

export interface Box {
  id: string
  x: number
  y: number
  width: number
  height: number
}

export interface PackOptions {
  cols?: number
  gapX?: number
  gapY?: number
}

export const DEFAULT_PACK_COLS = 2
export const DEFAULT_PACK_GAP_X = 100
export const DEFAULT_PACK_GAP_Y = 120

/**
 * Height of the preview area for a card of `width`. The SVG is scaled down to
 * fit horizontally and never scaled up past 1.
 */
export function previewMinHeight(
  width: number,
  svgWidth: number | null,
  svgHeight: number | null,
): number {
  if (svgWidth == null || svgHeight == null || svgWidth <= 0 || svgHeight <= 0) {
    return PREVIEW_MIN_HEIGHT_PX
  }
  const availableWidth = Math.max(0, width - PREVIEW_HORIZONTAL_PADDING_PX)
  const scale = Math.min(1, availableWidth / svgWidth)
  return Math.max(PREVIEW_MIN_HEIGHT_PX, Math.ceil(svgHeight * scale) + PREVIEW_VERTICAL_PAD_PX)
}

/** Full card height for a width plus intrinsic SVG size. */
export function estimateCardHeight(
  width: number,
  svgWidth: number | null,
  svgHeight: number | null,
): number {
  return Math.max(MIN_CARD_HEIGHT, LABEL_CHROME_PX + previewMinHeight(width, svgWidth, svgHeight))
}

/**
 * Card height for a diagram. Prefer this over reading `render.svgHeight`, which
 * is the SVG's intrinsic height before the preview scales it down.
 */
export function cardHeightFor(diagram: Diagram, domHeight: number | null = null): number {
  const estimated = estimateCardHeight(
    diagram.width,
    diagram.render?.svgWidth ?? null,
    diagram.render?.svgHeight ?? null,
  )
  return Math.max(estimated, domHeight ?? 0)
}

/**
 * Row-major shelf packing: cards fill `cols` per row in input order, each row is
 * as tall as its tallest card. Order is the reading order, so a page's narrative
 * lives in the array, never in hand-written coordinates.
 */
export function packCards(cards: DiagramCard[], options: PackOptions = {}): CardPosition[] {
  const cols = Math.max(1, Math.floor(options.cols ?? DEFAULT_PACK_COLS))
  const gapX = options.gapX ?? DEFAULT_PACK_GAP_X
  const gapY = options.gapY ?? DEFAULT_PACK_GAP_Y
  const positions: CardPosition[] = []

  let y = 0
  for (let start = 0; start < cards.length; start += cols) {
    const row = cards.slice(start, start + cols)
    const rowHeight = Math.max(...row.map((card) => card.height))
    let x = 0
    for (const card of row) {
      positions.push({ id: card.id, x, y })
      x += card.width + gapX
    }
    y += rowHeight + gapY
  }

  return positions
}

/** Bottom edge of a packed page, including the trailing gap. */
export function packedPageHeight(cards: DiagramCard[], positions: CardPosition[]): number {
  const heightById = new Map(cards.map((card) => [card.id, card.height]))
  return positions.reduce(
    (bottom, position) => Math.max(bottom, position.y + (heightById.get(position.id) ?? 0)),
    0,
  )
}

/** Every pair of boxes whose rectangles intersect. */
export function findOverlappingBoxes<T extends Box>(boxes: T[]): Array<[T, T]> {
  const overlaps: Array<[T, T]> = []
  for (let i = 0; i < boxes.length; i += 1) {
    const a = boxes[i]!
    for (let j = i + 1; j < boxes.length; j += 1) {
      const b = boxes[j]!
      if (a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y) {
        overlaps.push([a, b])
      }
    }
  }
  return overlaps
}
