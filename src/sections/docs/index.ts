import { openNotes } from '../../bita.ts'
import { placeholderSection } from '../placeholder.ts'

export const { mount, update, unmount } = placeholderSection({
  title: 'Documentación',
  note: 'Los espacios y sus páginas se mudan a esta sección. Mientras, viven en la ventana de notas.',
  action: { label: 'Abrir la documentación', run: () => openNotes(null) },
})
