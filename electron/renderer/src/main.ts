/**
 * The window: a top bar (menu, the shown section's own controls, the
 * privacy badge), banners for anything that limits the app, and the six
 * sections. Sections are built once and kept, so a conversation or a
 * translated document is still there after a look at the phrasebook.
 *
 * Bundled to build/renderer/app.js by scripts/build-electron.ts.
 */
import { player } from './audio.js'
import { fill, h, icon } from './dom.js'
import { conversationSection } from './sections/conversation.js'
import { documentsSection } from './sections/documents.js'
import { guideSection } from './sections/guide.js'
import { phrasebookSection } from './sections/phrasebook.js'
import type { Section, SectionId, Shell } from './sections/section.js'
import { settingsSection } from './sections/settings.js'
import { translateSection } from './sections/translate.js'
import { app, applyTextSize, applyTheme, prefs } from './state.js'

if (navigator.userAgent.includes('Electron')) document.documentElement.classList.add('is-electron')
applyTheme()
applyTextSize()

const shell: Shell = { go }
const settings = settingsSection()
const sections: Section[] = [
  conversationSection(shell),
  phrasebookSection(shell),
  guideSection(shell),
  documentsSection(shell),
  translateSection(shell),
  settings
]
const byId = new Map(sections.map((s) => [s.id, s]))
let current: Section | null = null

const menuBtn = h('button', { class: 'icon-btn', 'aria-label': 'Sections', 'aria-expanded': 'false', 'aria-controls': 'drawer', title: 'Sections' }, icon('menu'))
const center = h('div', { class: 'topbar-center' })
const badge = h('button', { class: 'status-badge', 'aria-haspopup': 'dialog' }, icon('shield'), 'Secure & offline')
const modeChip = h('span', { class: 'chip warn', hidden: true }, icon('lock'), 'Read-only')
const version = h('span', { class: 'version' })
const topbar = h(
  'header',
  { class: 'topbar' },
  h('div', { class: 'topbar-left' }, menuBtn),
  center,
  h('div', { class: 'topbar-right' }, modeChip, badge, version)
)
const banners = h('div', { class: 'banners', role: 'status' })
const stage = h('main', { class: 'stage' })
const containers = new Map<SectionId, HTMLElement>()
for (const s of sections) {
  const c = h('div', { class: 'section', hidden: true, 'aria-label': s.title }, s.root)
  containers.set(s.id, c)
  stage.appendChild(c)
}

const drawer = h('nav', { class: 'drawer', id: 'drawer', 'aria-label': 'Sections' })
const scrim = h('div', { class: 'scrim', onclick: () => setNav(false) })
const popover = h(
  'div',
  { class: 'popover', role: 'dialog', 'aria-label': 'Privacy', hidden: true },
  h('h3', null, icon('shield'), 'Everything stays on this Mac'),
  h(
    'ul',
    null,
    h('li', null, 'Speech, translation, reading aloud and document reading all run on this Mac. The app works with no internet connection.'),
    h('li', null, 'Nothing you say, type or photograph is sent anywhere.'),
    h('li', null, 'The activity log keeps only what was used and when, encrypted, for 30 days.')
  )
)
document.getElementById('app')!.append(topbar, banners, stage)
document.body.append(scrim, drawer, popover)

function renderDrawer() {
  fill(
    drawer,
    sections.map((s, i) => [
      s.id === 'settings' ? h('div', { class: 'nav-sep' }) : null,
      h(
        'button',
        { class: 'nav-item', 'aria-current': s === current ? 'page' : null, onclick: () => go(s.id) },
        h('span', { class: 'nav-icon' }, icon(s.icon)),
        h('span', null, h('span', { class: 'nav-name' }, s.title), h('span', { class: 'nav-desc' }, s.desc)),
        h('span', { class: 'nav-meta' }, s.feature && !app.can(s.feature) ? icon('lock') : h('kbd', null, `⌘${i + 1}`))
      )
    ])
  )
}

function setNav(open: boolean) {
  document.body.classList.toggle('nav-open', open)
  menuBtn.setAttribute('aria-expanded', String(open))
  if (open) {
    popover.hidden = true
    ;(drawer.querySelector('[aria-current="page"]') as HTMLElement | null)?.focus()
  }
}

function go(id: SectionId, sub?: string) {
  const next = byId.get(id)
  if (!next) return
  setNav(false)
  if (next !== current) {
    current?.hide?.()
    if (current) containers.get(current.id)!.hidden = true
    current = next
    containers.get(id)!.hidden = false
    fill(center, next.header)
    document.title = `${next.title}, Offline Field Assistant`
    prefs.set('section', id)
    renderDrawer()
    next.show?.()
  }
  if (id === 'settings' && sub) settings.open(sub)
}

function renderStatus() {
  const s = app.status
  version.textContent = s ? `v${s.app}` : ''
  modeChip.hidden = !app.readOnly
  const items: HTMLElement[] = []
  if (app.statusError) items.push(banner('danger', `The app could not read its status: ${app.statusError}`))
  if (app.modelsMissing)
    items.push(banner('danger', 'Speech and translation models are missing. Conversation, translation and documents will not work until the model pack is installed.', 'Open Models', () => go('settings', 'models')))
  if (s && app.readOnly)
    items.push(banner('warn', `Read-only: ${s.license.message} The phrasebook and Ask the guide still work.`, 'Licence settings', () => go('settings', 'licence')))
  else if (s?.license.warnings.includes('expires-soon'))
    items.push(banner('warn', `The licence expires in ${s.license.daysLeft} days. Ask your organisation for a new one.`, 'Licence settings', () => go('settings', 'licence')))
  fill(banners, items)
  renderDrawer()
}

function banner(tone: 'warn' | 'danger', text: string, action?: string, onClick?: () => void) {
  return h(
    'div',
    { class: `banner ${tone === 'danger' ? 'danger' : ''}` },
    icon(tone === 'danger' ? 'alert' : 'info'),
    h('span', null, text),
    action ? h('button', { class: 'btn small', onclick: onClick }, action) : null
  )
}

menuBtn.addEventListener('click', () => setNav(!document.body.classList.contains('nav-open')))
badge.addEventListener('click', (e) => {
  e.stopPropagation()
  popover.hidden = !popover.hidden
})
document.addEventListener('click', (e) => {
  if (!popover.hidden && !popover.contains(e.target as Node)) popover.hidden = true
})

document.addEventListener('keydown', (e) => {
  if (e.metaKey && /^[1-6]$/.test(e.key)) {
    e.preventDefault()
    go(sections[Number(e.key) - 1]!.id)
    return
  }
  if (e.key === 'Escape') {
    if (document.body.classList.contains('nav-open')) return setNav(false)
    if (!popover.hidden) return void (popover.hidden = true)
    if (player.key) return player.stop()
  }
  if (document.body.classList.contains('nav-open') || document.querySelector('dialog[open]')) return
  current?.keydown?.(e)
})
document.addEventListener('keyup', (e) => {
  current?.keyup?.(e)
})
// Files dropped anywhere else must not navigate the window away.
document.addEventListener('dragover', (e) => e.preventDefault())
document.addEventListener('drop', (e) => e.preventDefault())

app.onChange(renderStatus)
go((prefs.get('section', 'conversation') as SectionId) ?? 'conversation')
void app.refresh()
