import type { Attributes } from 'graphology-types'
import type Sigma from 'sigma'

interface GestureLike extends UIEvent {
  scale: number
  clientX: number
  clientY: number
}

const PINCH_SPEED = 0.01
const WHEEL_STEP = 1.25

function isMouseWheel(event: WheelEvent): boolean {
  if (event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) return true
  const legacy = (event as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY
  return event.deltaX === 0 && typeof legacy === 'number' && legacy !== 0 && legacy % 120 === 0
}

export function bindTrackpad<N extends Attributes, E extends Attributes>(
  stage: HTMLElement,
  renderer: Sigma<N, E>,
  signal: AbortSignal,
): void {
  const camera = renderer.getCamera()

  const local = (clientX: number, clientY: number) => {
    const box = stage.getBoundingClientRect()
    return { x: clientX - box.left, y: clientY - box.top }
  }

  const zoomAt = (clientX: number, clientY: number, factor: number) => {
    const state = camera.getState()
    const ratio = camera.getBoundedRatio(state.ratio * factor)
    if (ratio === state.ratio) return
    const point = renderer.viewportToFramedGraph(local(clientX, clientY))
    const scale = ratio / state.ratio
    camera.setState({ ratio, x: point.x + (state.x - point.x) * scale, y: point.y + (state.y - point.y) * scale })
  }

  const panBy = (dx: number, dy: number) => {
    const origin = renderer.viewportToFramedGraph({ x: 0, y: 0 })
    const moved = renderer.viewportToFramedGraph({ x: dx, y: dy })
    const state = camera.getState()
    camera.setState({ x: state.x + moved.x - origin.x, y: state.y + moved.y - origin.y })
  }

  stage.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault()
      event.stopPropagation()
      camera.cancelAnimation()
      if (event.ctrlKey) zoomAt(event.clientX, event.clientY, Math.exp(event.deltaY * PINCH_SPEED))
      else if (isMouseWheel(event)) zoomAt(event.clientX, event.clientY, event.deltaY > 0 ? WHEEL_STEP : 1 / WHEEL_STEP)
      else panBy(event.deltaX, event.deltaY)
    },
    { capture: true, passive: false, signal },
  )

  let lastScale = 1
  stage.addEventListener(
    'gesturestart',
    (event) => {
      event.preventDefault()
      lastScale = 1
    },
    { signal },
  )
  stage.addEventListener(
    'gesturechange',
    (event) => {
      event.preventDefault()
      const gesture = event as GestureLike
      if (gesture.scale <= 0) return
      zoomAt(gesture.clientX, gesture.clientY, lastScale / gesture.scale)
      lastScale = gesture.scale
    },
    { signal },
  )
  stage.addEventListener('gestureend', (event) => event.preventDefault(), { signal })
}
