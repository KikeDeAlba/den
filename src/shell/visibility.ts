import { isMeetingKind, type Modules, type PendingMeeting, type Snapshot, type ToolsStatus } from '../bita.ts'
import { SECTIONS, type SectionId } from './routes.ts'

const NEEDS: Partial<Record<SectionId, (modules: Modules, gazeFixture: boolean) => boolean>> = {
  agentes: (modules) => modules.timers,
  tiempo: (modules) => modules.timers,
  docs: (modules) => modules.notes,
  pendientes: (modules) => modules.backlog || modules.notes,
  reuniones: (modules) => modules.meetings,
  cerebro: (modules, gazeFixture) => modules.graph || gazeFixture,
}

export function visibleSections(tools: ToolsStatus | null, gazeFixture: boolean): Set<SectionId> {
  const visible = new Set<SectionId>()
  for (const section of SECTIONS) {
    const needs = NEEDS[section.id]
    if (tools === null || needs === undefined || needs(tools.modules, gazeFixture)) visible.add(section.id)
  }
  return visible
}

export interface RailMarks {
  ahora: string | null
  docs: string | null
  reuniones: string | null
}

export function railMarks(snapshot: Snapshot, proposals: PendingMeeting[]): RailMarks {
  const running = snapshot.running.length
  const changes = proposals.reduce((total, meeting) => total + meeting.proposals.length, 0)
  return {
    ahora: running === 0 ? null : running === 1 ? '1 cronómetro corriendo' : `${running} cronómetros corriendo`,
    docs: changes === 0 ? null : changes === 1 ? '1 cambio propuesto' : `${changes} cambios propuestos`,
    reuniones: snapshot.running.some((timer) => isMeetingKind(timer.kind)) ? 'reunión en curso' : null,
  }
}
