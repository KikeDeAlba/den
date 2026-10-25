import {
  addProject,
  jiraKeyMap,
  jiraProjects,
  noJiraSet,
  projects,
  scopes,
  setScope,
  unsetScope,
  type Project,
  type Scope,
} from '../../bita.ts'
import { element } from '../../dom.ts'
import { projectColor } from '../../tabs.ts'
import { block, problemBox, quietButton, waiting } from './parts.ts'

interface Data {
  scopes: Scope[]
  catalog: Project[]
  keys: Map<number, string>
  noJira: Set<number>
}

function dot(projectId: number | null): HTMLElement {
  const mark = element('i', 'ajustes-dot')
  mark.style.background = projectColor(projectId)
  return mark
}

function jiraTag(projectId: number, data: Data): HTMLElement {
  if (data.noJira.has(projectId)) return element('span', 'ajustes-key ajustes-key--muted', 'sin Jira')
  return element('span', 'ajustes-key', data.keys.get(projectId) ?? '')
}

function scopeRow(scope: Scope, data: Data, remove: (prefix: string) => void): HTMLElement {
  const line = element('div', 'ajustes-repo')
  const path = element('span', 'ajustes-repo-path')
  const cut = scope.prefix.lastIndexOf('/')
  if (cut === -1) {
    path.append(element('span', 'ajustes-repo-leaf', scope.prefix))
  } else {
    path.append(scope.prefix.slice(0, cut + 1), element('span', 'ajustes-repo-leaf', scope.prefix.slice(cut + 1)))
  }
  const project = element('span', 'ajustes-repo-project')
  project.append(dot(scope.projectId), element('span', undefined, scope.projectName))
  const drop = quietButton('Quitar', () => remove(scope.prefix))
  drop.classList.add('quiet-link--danger')
  drop.setAttribute('aria-label', `Quitar la ruta ${scope.prefix}`)
  line.append(path, project, jiraTag(scope.projectId, data), drop)
  return line
}

function option(value: string, label: string): HTMLOptionElement {
  const node = document.createElement('option')
  node.value = value
  node.textContent = label
  return node
}

function scopeForm(catalog: Project[], save: (prefix: string, project: string) => void): HTMLFormElement {
  const form = document.createElement('form')
  form.className = 'ajustes-form'
  const prefix = document.createElement('input')
  prefix.type = 'text'
  prefix.placeholder = 'gitlab.com/org/grupo'
  prefix.autocomplete = 'off'
  prefix.spellcheck = false
  prefix.setAttribute('aria-label', 'Prefijo de ruta')
  const select = document.createElement('select')
  select.setAttribute('aria-label', 'Proyecto de la ruta')
  select.append(option('', 'Proyecto…'))
  for (const project of catalog) select.append(option(String(project.id), project.name))
  const submit = element('button', 'ghost-button', 'Mapear') as HTMLButtonElement
  submit.type = 'submit'
  form.append(prefix, select, submit)
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    if (prefix.value.trim() === '' || select.value === '') return
    save(prefix.value.trim(), select.value)
  })
  return form
}

function projectForm(save: (name: string) => void): HTMLFormElement {
  const form = document.createElement('form')
  form.className = 'ajustes-form'
  const name = document.createElement('input')
  name.type = 'text'
  name.placeholder = 'Nombre del proyecto nuevo'
  name.autocomplete = 'off'
  name.setAttribute('aria-label', 'Nombre del proyecto nuevo')
  const submit = element('button', 'ghost-button', 'Crear') as HTMLButtonElement
  submit.type = 'submit'
  form.append(name, submit)
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    if (name.value.trim() === '') return
    save(name.value.trim())
  })
  return form
}

export function reposBlock(jiraEnabled: () => boolean): { element: HTMLElement; load(): Promise<void> } {
  let adding = false
  let busy = false
  let ticket = 0
  let data: Data | null = null
  const add = quietButton('Agregar ruta', () => {
    adding = !adding
    paint()
  })
  const { section, body } = block('Proyectos y repos', add)
  const failure = element('div', 'ajustes-failure')

  function paint(): void {
    add.textContent = adding ? 'Cerrar' : 'Agregar ruta'
    if (data === null) return
    const current = data
    body.replaceChildren(failure)
    if (adding) body.append(scopeForm(current.catalog, (prefix, project) => void run(() => setScope(prefix, project), true)))
    if (current.scopes.length === 0) body.append(element('p', 'ajustes-empty', 'Ninguna ruta mapeada todavía.'))
    for (const scope of current.scopes) {
      body.append(scopeRow(scope, current, (prefix) => void run(() => unsetScope(prefix), false)))
    }
    body.append(
      element(
        'p',
        'ajustes-legend',
        'Manda el prefijo más largo, y el empate es por carpetas: …/apartados nunca se traga …/apartados-legacy.',
      ),
    )
    body.append(element('h3', 'ajustes-sublabel', `Proyectos · ${current.catalog.length}`))
    for (const project of current.catalog) {
      const line = element('div', 'ajustes-project')
      line.append(dot(project.id), element('span', 'ajustes-project-name', project.name), jiraTag(project.id, current))
      body.append(line)
    }
    body.append(projectForm((name) => void run(() => addProject(name), false)))
  }

  async function run(action: () => Promise<unknown>, closeForm: boolean): Promise<void> {
    if (busy) return
    busy = true
    failure.replaceChildren()
    try {
      await action()
      if (closeForm) adding = false
      busy = false
      await load()
    } catch (error) {
      busy = false
      failure.replaceChildren(problemBox(error))
    }
  }

  async function load(): Promise<void> {
    ticket += 1
    const mine = ticket
    if (data === null) body.replaceChildren(waiting())
    try {
      const mapped = jiraEnabled() ? jiraProjects().catch(() => []) : Promise.resolve([])
      const [nextScopes, catalog, jira] = await Promise.all([scopes(), projects(), mapped])
      if (mine !== ticket) return
      data = { scopes: nextScopes, catalog, keys: jiraKeyMap(jira), noJira: noJiraSet(jira) }
      paint()
    } catch (error) {
      if (mine === ticket) body.replaceChildren(problemBox(error))
    }
  }

  return { element: section, load }
}
