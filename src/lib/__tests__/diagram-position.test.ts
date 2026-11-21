import { describe, expect, it } from 'vitest'
import { ARTBOARD_COLS, ARTBOARD_GAP_X, ARTBOARD_GAP_Y, nextDiagramPosition } from '../../types'
import type { Diagram } from '../../types'
import {
  LABEL_CHROME_PX,
  PREVIEW_MIN_HEIGHT_PX,
  cardHeightFor,
  findOverlappingBoxes,
  packCards,
} from '../cardLayout'

function diagram(index: number, overrides: Partial<Diagram> = {}): Diagram {
  return {
    id: `d${index}`,
    name: `Diagram ${index}`,
    code: 'flowchart LR\n  A --> B',
    x: 0,
    y: 0,
    width: 640,
    ...overrides,
  }
}

/** Where the app already put `diagrams`, using the same shelf order as insertion. */
function placedBoxes(diagrams: Diagram[]) {
  const positions = packCards(
    diagrams.map((d) => ({ id: d.id, width: d.width, height: cardHeightFor(d) })),
    { cols: ARTBOARD_COLS, gapX: ARTBOARD_GAP_X, gapY: ARTBOARD_GAP_Y },
  )
  return diagrams.map((d) => {
    const position = positions.find((p) => p.id === d.id)!
    return { id: d.id, x: position.x, y: position.y, width: d.width, height: cardHeightFor(d) }
  })
}

function overlapsWithNext(diagrams: Diagram[], next: { x: number; y: number }) {
  const boxes = [
    ...placedBoxes(diagrams),
    { id: 'next', x: next.x, y: next.y, width: 640, height: cardHeightFor(diagram(99)) },
  ]
  return findOverlappingBoxes(boxes)
}

describe('nextDiagramPosition', () => {
  it('starts an empty page at the origin', () => {
    expect(nextDiagramPosition([])).toEqual({ x: 0, y: 0 })
  })

  it('advances x by each preceding card width plus the gap', () => {
    const diagrams = [diagram(1), diagram(2)]
    expect(nextDiagramPosition(diagrams).x).toBe(2 * (640 + ARTBOARD_GAP_X))
  })

  it('starts a new row at x 0 after a full row', () => {
    const diagrams = Array.from({ length: ARTBOARD_COLS }, (_, i) => diagram(i))
    expect(nextDiagramPosition(diagrams).x).toBe(0)
  })

  it('clears a flat wide card using the card height, not the svg height', () => {
    // 2960x233 renders flat: the card is label chrome plus the minimum preview,
    // while the old code used the 233px intrinsic svg height and overlapped.
    const flat = { ...diagram(0), render: renderState(2960, 233) }
    const diagrams = Array.from({ length: ARTBOARD_COLS }, (_, i) => diagram(i))
    diagrams[0] = flat

    const next = nextDiagramPosition(diagrams)
    expect(cardHeightFor(flat)).toBe(LABEL_CHROME_PX + PREVIEW_MIN_HEIGHT_PX)
    expect(next.y).toBeGreaterThanOrEqual(LABEL_CHROME_PX + PREVIEW_MIN_HEIGHT_PX)
    expect(overlapsWithNext(diagrams, next)).toEqual([])
  })

  it('clears a very tall card without reserving the raw svg height', () => {
    const tall = { ...diagram(1), width: 900, render: renderState(965, 1755) }
    const diagrams = Array.from({ length: ARTBOARD_COLS }, (_, i) => diagram(i))
    diagrams[1] = tall

    const cardHeight = cardHeightFor(tall)
    const next = nextDiagramPosition(diagrams)
    expect(cardHeight).toBeLessThan(1755)
    expect(next.y).toBe(cardHeight + ARTBOARD_GAP_Y)
    expect(overlapsWithNext(diagrams, next)).toEqual([])
  })

  it('never overlaps mixed card shapes', () => {
    const diagrams = [
      { ...diagram(0), width: 900, render: renderState(2960, 233) },
      { ...diagram(1), width: 900, render: renderState(965, 1755) },
      { ...diagram(2), width: 500, render: renderState(600, 500) },
    ]
    expect(overlapsWithNext(diagrams, nextDiagramPosition(diagrams))).toEqual([])
  })
})

function renderState(svgWidth: number, svgHeight: number): Diagram['render'] {
  return {
    status: 'ready',
    svg: '<svg />',
    error: null,
    svgWidth,
    svgHeight,
    inputHash: 'in',
    outputHash: 'out',
  }
}
