import { openReports } from '../../bita.ts'
import { placeholderSection } from '../placeholder.ts'

export const { mount, update, unmount } = placeholderSection({
  title: 'Tiempo',
  note: 'Hoy, la semana, el mes y los reportes se mudan a esta sección. Mientras, viven en su propia ventana.',
  action: { label: 'Abrir los reportes', run: openReports },
})
