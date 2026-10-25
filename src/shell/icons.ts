import type { SectionId } from './routes.ts'

const SVG = 'http://www.w3.org/2000/svg'

interface Shape {
  paths?: string[]
  circles?: [number, number, number][]
  rects?: [number, number, number, number, number][]
}

const SHAPES: Record<SectionId, Shape> = {
  ahora: { circles: [[8, 9, 5.4]], paths: ['M8 6.3V9l1.8 1.1M6.2 1.9h3.6'] },
  agentes: { rects: [[1.8, 2.8, 12.4, 10.4, 1.8]], paths: ['M4.6 6.4 6.8 8.2 4.6 10M8.4 10.4h3'] },
  tiempo: { paths: ['M2.2 13.8h11.6M4.6 11.2V8M8 11.2V3.6M11.4 11.2V6.2'] },
  docs: {
    paths: [
      'M9 1.9H4.3a1.2 1.2 0 0 0-1.2 1.2v9.8a1.2 1.2 0 0 0 1.2 1.2h7.4a1.2 1.2 0 0 0 1.2-1.2V5.9Z',
      'M9 1.9v4h3.9M5.6 8.6h4.8M5.6 11h3.2',
    ],
  },
  pendientes: { paths: ['M2.6 4.2 3.8 5.4 5.8 3.2M2.6 9.4 3.8 10.6 5.8 8.4M8 4.4h5.4M8 9.6h5.4M8 13h3.4'] },
  reuniones: { rects: [[5.5, 1.5, 5, 8, 2.5]], paths: ['M3 7.5a5 5 0 0 0 10 0M8 12.5v2'] },
  cerebro: {
    circles: [
      [3.6, 4.2, 1.6],
      [12.2, 3.4, 1.4],
      [8.4, 8.6, 1.9],
      [3.8, 12.6, 1.4],
      [12.6, 12.4, 1.6],
    ],
    paths: ['M5 5.1l1.9 2.1M10.9 4.3l-1.5 2.6M7.1 10l-2.2 1.6M9.8 9.9l1.7 1.3'],
  },
  ajustes: {
    circles: [[8, 8, 2.4]],
    paths: ['M8 1.7v1.5M8 12.8v1.5M14.3 8h-1.5M3.2 8H1.7M12.4 3.6l-1 1M4.6 11.4l-1 1M12.4 12.4l-1-1M4.6 4.6l-1-1'],
  },
}

function child(tag: string, attributes: Record<string, string | number>): SVGElement {
  const node = document.createElementNS(SVG, tag)
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value))
  return node
}

export function sectionIcon(id: SectionId, size = 18): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.4')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  const shape = SHAPES[id]
  for (const [x, y, width, height, radius] of shape.rects ?? []) {
    svg.append(child('rect', { x, y, width, height, rx: radius }))
  }
  for (const [cx, cy, r] of shape.circles ?? []) svg.append(child('circle', { cx, cy, r }))
  for (const d of shape.paths ?? []) svg.append(child('path', { d }))
  return svg
}
