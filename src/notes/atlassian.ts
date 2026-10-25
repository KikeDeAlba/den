import './atlassian.css'
import {
  atlassianSiteAdd,
  atlassianSiteRemove,
  atlassianSites,
  atlassianSiteTest,
  describeProblem,
  type AtlassianSite,
  type Problem,
} from '../bita.ts'
import { element, icon } from '../dom.ts'
import { button, confirmDialog } from './media-dialogs.ts'
import { keychain, keychainShort } from '../platform.ts'

export interface AtlassianContext {
  railOpen: boolean
  onExpandRail: () => void
  onBack: () => void
}

const LOGO_COLORS = ['var(--running)', 'var(--purple)', 'var(--blue)', 'var(--ok)', 'var(--aqua)', 'var(--estimate)']

let sites: AtlassianSite[] | null = null
let failure: Problem | null = null
let checked = false
const testing = new Set<string>()
const removing = new Set<string>()
const messages = new Map<string, string>()
let formSite = ''
let formEmail = ''
let adding = false
let addFailure: Problem | null = null
let addedSite: string | null = null
let host: HTMLElement | null = null
let context: AtlassianContext | null = null
let root: HTMLElement | null = null

export function renderAtlassian(target: HTMLElement, next: AtlassianContext): void {
  const entering = !(host === target && mounted())
  host = target
  context = next
  if (entering || (sites === null && failure === null)) void load(false)
  paint(true)
}

function mounted(): boolean {
  return host !== null && root !== null && root.isConnected && root.parentElement === host
}

function paint(force: boolean): void {
  if (host === null || context === null) return
  if (!force && !mounted()) return
  const scroller = root?.querySelector<HTMLElement>('.ac-scroll')
  const scrollTop = mounted() && scroller ? scroller.scrollTop : 0
  const token = root?.querySelector<HTMLInputElement>('#ac-token')?.value ?? ''
  const focused = document.activeElement instanceof HTMLInputElement && host.contains(document.activeElement) ? document.activeElement.id : ''
  root = build(context)
  host.replaceChildren(root)
  const fresh = root.querySelector<HTMLElement>('.ac-scroll')
  if (fresh) fresh.scrollTop = scrollTop
  const tokenInput = root.querySelector<HTMLInputElement>('#ac-token')
  if (tokenInput && !adding) tokenInput.value = token
  if (focused.length > 0) root.querySelector<HTMLInputElement>(`#${CSS.escape(focused)}`)?.focus()
}

async function load(check: boolean): Promise<void> {
  try {
    sites = await atlassianSites(check)
    failure = null
    if (check) checked = true
  } catch (error) {
    if (sites === null) sites = []
    failure = describeProblem(error)
  }
  paint(false)
  if (!check && !checked && failure === null && (sites ?? []).length > 0) void load(true)
}

function hostName(site: string): string {
  return site.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
}

function initials(site: string): string {
  const name = hostName(site).split('.')[0] ?? site
  const parts = name.split(/[-_]/).filter((part) => part.length > 0)
  const letters = parts.length > 1 ? `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}` : name.slice(0, 2)
  return letters.toUpperCase()
}

function logoColor(site: string): string {
  let hash = 0
  for (const char of hostName(site)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return LOGO_COLORS[hash % LOGO_COLORS.length] ?? 'var(--blue)'
}

function pill(text: string, tone: '' | 'ok' | 'warn' | 'mcp' = ''): HTMLElement {
  return element('span', tone === '' ? 'ac-pill' : `ac-pill ac-pill--${tone}`, text)
}

function build(current: AtlassianContext): HTMLElement {
  const wrap = element('div', 'ac-root')
  wrap.append(bar(current))
  const scroll = element('div', 'ac-scroll')
  const main = element('div', 'ac-main')
  const list = element('div', 'ac-list')
  const intro = element('div', 'ac-intro')
  intro.append(
    element('h1', 'ac-title', 'Conexiones Atlassian'),
    element(
      'p',
      'ac-lede',
      'El MCP de Atlassian sigue siendo la vía predeterminada, pero solo se conecta a una organización a la vez. Aquí guardas varias para que atl hable con cada Jira y Confluence en paralelo; cada espacio elige cuál usar.',
    ),
  )
  list.append(intro)
  if (failure !== null) list.append(problemLine(failure))
  if (sites === null) list.append(element('p', 'ac-empty', 'Leyendo las organizaciones guardadas…'))
  else if (sites.length === 0 && failure === null) list.append(element('p', 'ac-empty', 'Todavía no hay ninguna organización guardada.'))
  for (const site of sites ?? []) list.append(siteCard(site))
  main.append(list, addForm())
  scroll.append(main)
  wrap.append(scroll)
  return wrap
}

function bar(current: AtlassianContext): HTMLElement {
  const row = element('div', 'reader-bar ac-bar')
  if (!current.railOpen) {
    const unfold = document.createElement('button')
    unfold.type = 'button'
    unfold.className = 'icon-button reader-step'
    unfold.setAttribute('aria-label', 'Desplegar el árbol')
    unfold.append(icon('panelLeft', 14))
    unfold.addEventListener('click', current.onExpandRail)
    row.append(unfold)
  }
  const back = document.createElement('button')
  back.type = 'button'
  back.className = 'ac-back'
  back.append(icon('prev', 13), element('span', '', 'Ajustes del espacio'))
  back.addEventListener('click', current.onBack)
  row.append(back, element('span', 'crumb-sep', '/'), element('span', 'crumb-here', 'Conexiones Atlassian'))
  return row
}

function siteCard(site: AtlassianSite): HTMLElement {
  const broken = site.status === 'auth_failed' || site.status === 'unreachable' || !site.tokenStored
  const card = element('div', broken ? 'ac-site ac-site--warn' : 'ac-site')
  const logo = element('span', 'ac-logo', initials(site.site))
  logo.style.background = logoColor(site.site)

  const text = element('div', 'ac-site-text')
  const name = element('span', 'ac-site-name')
  name.append(element('span', 'ac-site-host', hostName(site.site)))
  if (site.email.length > 0) name.append(element('span', 'v2-kbd', site.email))
  if (addedSite === site.site) name.append(pill('recién agregada', 'mcp'))

  const pills = element('span', 'ac-pills')
  if (site.status === 'auth_failed') pills.append(pill('el token ya no sirve · 401', 'warn'))
  else if (site.status === 'unreachable') pills.append(pill('no responde', 'warn'))
  pills.append(site.jira ? pill('Jira', site.status === 'ok' ? 'ok' : '') : pill('sin Jira'))
  pills.append(site.confluence ? pill('Confluence', site.status === 'ok' ? 'ok' : '') : pill('sin Confluence'))
  pills.append(site.tokenStored ? pill(`token en ${keychainShort}`) : pill('sin token', 'warn'))

  const used = element('span', 'v2-kbd', site.projects.length === 0 ? 'ningún espacio la usa todavía' : `usada por ${site.projects.join(' · ')}`)
  text.append(name, pills, used)
  const note = messages.get(site.site)
  if (note !== undefined) text.append(element('span', 'ac-site-note', note))

  const actions = element('span', 'ac-site-actions')
  if (site.status === 'auth_failed' || !site.tokenStored) {
    actions.append(
      button('Renovar token', 'v2-btn', () => {
        formSite = site.site
        formEmail = site.email
        addFailure = null
        paint(false)
        root?.querySelector<HTMLInputElement>('#ac-token')?.focus()
      }),
    )
  } else {
    const test = button(testing.has(site.site) ? 'Probando…' : 'Probar', 'v2-btn', () => void testSite(site.site))
    test.disabled = testing.has(site.site)
    actions.append(test)
  }
  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'v2-btn ac-remove'
  remove.setAttribute('aria-label', `Quitar ${hostName(site.site)}`)
  remove.title = 'Quitar la organización'
  remove.disabled = removing.has(site.site)
  remove.append(icon('trash', 13))
  remove.addEventListener('click', () => void removeSite(site))
  actions.append(remove)

  card.append(logo, text, actions)
  return card
}

function field(id: string, label: string, type: string, placeholder: string, value: string, onInput: (value: string) => void): HTMLElement {
  const wrap = element('label', 'ac-labelled')
  wrap.setAttribute('for', id)
  const box = element('span', 'ac-field')
  const input = document.createElement('input')
  input.id = id
  input.type = type
  input.placeholder = placeholder
  input.value = value
  input.autocomplete = 'off'
  input.spellcheck = false
  input.addEventListener('input', () => onInput(input.value))
  box.append(input)
  wrap.append(element('span', 'v2-kbd', label), box)
  return wrap
}

function addForm(): HTMLElement {
  const aside = element('aside', 'ac-add')
  aside.setAttribute('aria-labelledby', 'ac-add-title')
  const title = element('h2', 'ac-add-title', 'Agregar una organización')
  title.id = 'ac-add-title'
  aside.append(
    title,
    field('ac-site', 'Sitio', 'url', 'https://empresa.atlassian.net', formSite, (value) => {
      formSite = value
    }),
    field('ac-email', 'Correo de la cuenta', 'email', 'tu@empresa.com', formEmail, (value) => {
      formEmail = value
    }),
    field('ac-token', 'API token', 'password', `Se guarda en ${keychain}`, '', () => undefined),
  )
  const submit = button(adding ? 'Probando…' : 'Probar y guardar', 'v2-btn v2-btn--primary ac-submit', () => void addSite())
  submit.disabled = adding
  aside.append(submit)
  if (addFailure !== null) aside.append(problemLine(addFailure))
  const terminal = element('div', 'ac-terminal')
  terminal.append(element('span', 'v2-kbd', 'Desde la terminal'), element('code', 'ac-code', 'atl site add empresa --email tu@empresa.com'))
  aside.append(terminal)
  return aside
}

function normalizedSite(value: string): string {
  const text = value.trim().replace(/\/+$/, '')
  if (text.length === 0) return ''
  if (/^https?:\/\//.test(text)) return text
  return text.includes('.') ? `https://${text}` : `https://${text}.atlassian.net`
}

async function addSite(): Promise<void> {
  const input = root?.querySelector<HTMLInputElement>('#ac-token') ?? null
  const site = normalizedSite(formSite)
  const email = formEmail.trim()
  if (site.length === 0 || email.length === 0 || input === null || input.value.length === 0) {
    addFailure = { kind: 'cli-failed', message: 'Hacen falta el sitio, el correo y el API token.', hint: null }
    paint(false)
    return
  }
  let token = input.value
  input.value = ''
  adding = true
  addFailure = null
  paint(false)
  try {
    const added = await atlassianSiteAdd(site, email, token)
    token = ''
    addedSite = added?.site ?? site
    formSite = ''
    formEmail = ''
    messages.delete(addedSite)
    await load(false)
  } catch (error) {
    token = ''
    addFailure = describeProblem(error)
  }
  adding = false
  const cleared = root?.querySelector<HTMLInputElement>('#ac-token')
  if (cleared) cleared.value = ''
  paint(false)
}

async function testSite(site: string): Promise<void> {
  testing.add(site)
  messages.delete(site)
  paint(false)
  try {
    const result = await atlassianSiteTest(site)
    if (result !== null && sites !== null) {
      sites = sites.map((candidate) => (candidate.site === result.site ? result : candidate))
      messages.set(site, result.status === 'ok' ? 'Conexión probada: responde bien.' : 'La prueba no pasó.')
    } else {
      messages.set(site, 'Conexión probada.')
      await load(true)
    }
  } catch (error) {
    messages.set(site, describeProblem(error).message)
  }
  testing.delete(site)
  paint(false)
}

async function removeSite(site: AtlassianSite): Promise<void> {
  const used = site.projects.length > 0 ? ` La usan ${site.projects.join(', ')}; esos espacios se quedan sin sitio.` : ''
  const ok = await confirmDialog({
    title: `¿Quitar ${hostName(site.site)}?`,
    body: `Se borra el token de ${keychainShort} y atl deja de hablar con esa organización.${used}`,
    confirm: 'Quitar',
    danger: true,
  })
  if (!ok) return
  removing.add(site.site)
  paint(false)
  try {
    await atlassianSiteRemove(site.site)
    sites = (sites ?? []).filter((candidate) => candidate.site !== site.site)
  } catch (error) {
    messages.set(site.site, describeProblem(error).message)
  }
  removing.delete(site.site)
  paint(false)
}

function problemLine(problem: Problem): HTMLElement {
  const box = element('div', 'ac-problem')
  box.append(icon('warning', 13))
  const text = element('div', 'ac-problem-text')
  text.append(element('span', '', problem.message))
  if (problem.hint) text.append(element('span', 'ac-problem-hint', problem.hint))
  box.append(text)
  return box
}
