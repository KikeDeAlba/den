import { describe, expect, it } from 'vitest'
import { NO_MODULES, type LiveTimer, type Modules, type PendingMeeting, type ToolsStatus } from '../bita.ts'
import { SECTIONS } from './routes.ts'
import { railMarks, visibleSections } from './visibility.ts'

function status(modules: Partial<Modules>): ToolsStatus {
  return { registryDir: '', tools: [], invalid: [], modules: { ...NO_MODULES, ...modules }, inkwellMigrated: null }
}

function timer(id: number, kind: string | null = null): LiveTimer {
  return {
    id,
    title: 'x',
    docRelPath: null,
    sectionsWritten: null,
    sectionsTotal: null,
    touchedSinceNote: null,
    projectName: null,
    projectId: null,
    startedAt: '2026-10-24T10:00:00Z',
    startLocal: '2026-10-24 04:00',
    elapsedSeconds: 60,
    draft: false,
    kind,
  }
}

function meeting(count: number): PendingMeeting {
  return { proposals: Array.from({ length: count }, () => ({})) } as unknown as PendingMeeting
}

describe('visibleSections', () => {
  it('shows every section while the tools are unknown', () => {
    expect([...visibleSections(null, false)]).toEqual(SECTIONS.map((section) => section.id))
  })

  it('keeps only Ahora and Ajustes when nothing is installed', () => {
    expect([...visibleSections(status({}), false)]).toEqual(['ahora', 'ajustes'])
  })

  it('maps each section to the module that feeds it', () => {
    const visible = visibleSections(status({ timers: true, notes: true, meetings: true }), false)
    expect([...visible]).toEqual(['ahora', 'agentes', 'tiempo', 'docs', 'pendientes', 'reuniones', 'ajustes'])
    expect(visibleSections(status({ backlog: true }), false).has('pendientes')).toBe(true)
    expect(visibleSections(status({ graph: true }), false).has('cerebro')).toBe(true)
  })

  it('shows Cerebro with the gaze fixture even without gaze', () => {
    expect(visibleSections(status({}), true).has('cerebro')).toBe(true)
  })
})

describe('railMarks', () => {
  it('marks nothing when idle', () => {
    expect(railMarks({ running: [], todaySeconds: 0, problem: null }, [])).toEqual({
      ahora: null,
      docs: null,
      reuniones: null,
    })
  })

  it('counts pending proposals across meetings for Documentación', () => {
    const marks = railMarks({ running: [], todaySeconds: 0, problem: null }, [meeting(2), meeting(1)])
    expect(marks.docs).toBe('3 cambios propuestos')
    expect(railMarks({ running: [], todaySeconds: 0, problem: null }, [meeting(1)]).docs).toBe('1 cambio propuesto')
  })

  it('marks Ahora while timers run and Reuniones during a meeting', () => {
    const marks = railMarks({ running: [timer(1), timer(2, 'remote-meeting')], todaySeconds: 0, problem: null }, [])
    expect(marks.ahora).toBe('2 cronómetros corriendo')
    expect(marks.reuniones).toBe('reunión en curso')
    expect(railMarks({ running: [timer(1)], todaySeconds: 0, problem: null }, []).reuniones).toBeNull()
  })
})
