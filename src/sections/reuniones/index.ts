import { openNotes } from '../../bita.ts'
import { placeholderSection } from '../placeholder.ts'

export const { mount, update, unmount } = placeholderSection({
  title: 'Reuniones',
  note: 'La reunión en curso y las pasadas se mudan a esta sección. Mientras, las minutas viven en la ventana de notas.',
  action: { label: 'Abrir las reuniones', run: () => openNotes(null) },
})
