import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PACK_GAP_X,
  DEFAULT_PACK_GAP_Y,
  LABEL_CHROME_PX,
  MIN_CARD_HEIGHT,
  PREVIEW_MIN_HEIGHT_PX,
  cardHeightFor,
  estimateCardHeight,
  findOverlappingBoxes,
  packCards,
  packedPageHeight,
  previewMinHeight,
} from '../cardLayout'
import type { Diagram } from '../../types'

function diagram(overrides: Partial<Diagram> = {}): Diagram {
  return {
    id: 'd1',
    name: 'Diagram',
    code: 'flowchart LR\n  A --> B',
    x: 0,
    y: 0,
    width: 900,
    ...overrides,
  }
}

describe('previewMinHeight', () => {
  it('falls back to the minimum before a diagram renders', () => {
    expect(previewMinHeight(900, null, null)).toBe(PREVIEW_MIN_HEIGHT_PX)
    expect(previewMinHeight(900, 0, 0)).toBe(PREVIEW_MIN_HEIGHT_PX)
  })

  it('scales a wide SVG down and clamps to the minimum preview', () => {
    // 2960x233 at card width 900 scales to ~0.29, so the preview stays flattened.
    expect(previewMinHeight(900, 2960, 233)).toBe(PREVIEW_MIN_HEIGHT_PX)
  })

  it('never scales a narrow SVG up past 1', () => {
    expect(previewMinHeight(900, 600, 500)).toBe(500 + 8)
  })

  it('scales a tall SVG by the horizontal fit', () => {
    // (900 - 32) / 965 ≈ 0.9
    expect(previewMinHeight(900, 965, 1755)).toBe(Math.ceil(1755 * (868 / 965)) + 8)
  })

  it('grows with the card width', () => {
    const narrow = previewMinHeight(600, 965, 1755)
    const wide = previewMinHeight(1200, 965, 1755)
    expect(wide).toBeGreaterThan(narrow)
  })
})

describe('estimateCardHeight', () => {
  it('keeps a placeholder card at the minimum card height', () => {
    expect(estimateCardHeight(900, null, null)).toBe(Math.max(MIN_CARD_HEIGHT, LABEL_CHROME_PX + PREVIEW_MIN_HEIGHT_PX))
  })

  it('adds label chrome on top of the preview', () => {
    expect(estimateCardHeight(900, 600, 500)).toBe(LABEL_CHROME_PX + 500 + 8)
  })

  it('never returns less than the label chrome plus the minimum preview', () => {
    expect(estimateCardHeight(320, 4000, 10)).toBe(LABEL_CHROME_PX + PREVIEW_MIN_HEIGHT_PX)
  })
})

describe('cardHeightFor', () => {
  it('uses the intrinsic SVG size, not just the raw svg height', () => {
    const flat = diagram({ render: renderState(2960, 233) })
    // Raw svgHeight is 233; the card is label chrome plus the minimum preview.
    expect(cardHeightFor(flat)).toBe(LABEL_CHROME_PX + PREVIEW_MIN_HEIGHT_PX)
  })

  it('prefers a taller measured DOM height', () => {
    const card = diagram({ render: renderState(600, 500) })
    expect(cardHeightFor(card, 900)).toBe(900)
    expect(cardHeightFor(card, 100)).toBe(LABEL_CHROME_PX + 508)
  })
})

describe('packCards', () => {
  const cards = [
    { id: 'a', width: 900, height: 466 },
    { id: 'b', width: 900, height: 596 },
    { id: 'c', width: 900, height: 478 },
  ]

  it('fills rows in input order', () => {
    expect(packCards(cards)).toEqual([
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 900 + DEFAULT_PACK_GAP_X, y: 0 },
      { id: 'c', x: 0, y: 596 + DEFAULT_PACK_GAP_Y },
    ])
  })

  it('uses the tallest card of a row as the row height', () => {
    const positions = packCards(cards)
    const third = positions.find((p) => p.id === 'c')!
    expect(third.y).toBeGreaterThanOrEqual(596)
  })

  it('respects variable card widths', () => {
    const positions = packCards([
      { id: 'narrow', width: 400, height: 300 },
      { id: 'wide', width: 1200, height: 300 },
    ])
    expect(positions[1]).toEqual({ id: 'wide', x: 400 + DEFAULT_PACK_GAP_X, y: 0 })
  })

  it('honours cols and gaps', () => {
    const positions = packCards(cards, { cols: 1, gapX: 10, gapY: 20 })
    expect(positions.map((p) => p.y)).toEqual([0, 466 + 20, 466 + 20 + 596 + 20])
  })

  it('never produces an overlap', () => {
    const mixed = [
      { id: 'flat', width: 900, height: MIN_CARD_HEIGHT },
      { id: 'tall', width: 900, height: 1658 },
      { id: 'mid', width: 900, height: 629 },
      { id: 'small', width: 500, height: 312 },
      { id: 'wide', width: 1600, height: 400 },
    ]
    for (const cols of [1, 2, 3]) {
      const positions = packCards(mixed, { cols })
      const boxes = mixed.map((card) => {
        const position = positions.find((p) => p.id === card.id)!
        return { ...card, x: position.x, y: position.y }
      })
      expect(findOverlappingBoxes(boxes)).toEqual([])
    }
  })

  it('reports the page height from the last row', () => {
    const positions = packCards(cards)
    expect(packedPageHeight(cards, positions)).toBe(596 + DEFAULT_PACK_GAP_Y + 478)
  })
})

describe('findOverlappingBoxes', () => {
  it('returns intersecting pairs only', () => {
    const boxes = [
      { id: 'a', x: 0, y: 0, width: 100, height: 100 },
      { id: 'b', x: 50, y: 50, width: 100, height: 100 },
      { id: 'c', x: 500, y: 0, width: 100, height: 100 },
    ]
    expect(findOverlappingBoxes(boxes).map(([a, b]) => [a.id, b.id])).toEqual([['a', 'b']])
  })

  it('treats touching edges as separate', () => {
    const boxes = [
      { id: 'a', x: 0, y: 0, width: 100, height: 100 },
      { id: 'b', x: 0, y: 100, width: 100, height: 100 },
    ]
    expect(findOverlappingBoxes(boxes)).toEqual([])
  })
})

describe('regression: row height from svgHeight overlaps', () => {
  it('shows why the card estimator is required', () => {
    const flat = diagram({ render: renderState(2960, 233) })
    // The old in-app placement used raw svgHeight (233) plus the 50px artboard gap.
    const legacyRowHeight = 233
    const cardHeight = cardHeightFor(flat)
    expect(cardHeight).toBeGreaterThan(legacyRowHeight)

    const legacyBoxes = [
      { ...flat, x: 0, y: 0, width: flat.width, height: cardHeight },
      { ...diagram({ id: 'next' }), x: 0, y: legacyRowHeight + 50, width: 900, height: cardHeight },
    ]
    expect(findOverlappingBoxes(legacyBoxes).map(([a, b]) => [a.id, b.id])).toEqual([['d1', 'next']])
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
