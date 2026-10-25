import { openBrain } from '../../bita.ts'
import { placeholderSection } from '../placeholder.ts'

export const { mount, update, unmount } = placeholderSection({
  title: 'Cerebro',
  note: 'El grafo del proyecto se muda a esta sección. Mientras, vive en su propia ventana.',
  action: { label: 'Abrir el cerebro', run: openBrain },
})

export const keepAlive = false
