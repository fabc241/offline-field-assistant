/**
 * 5. Translate & read aloud. Typed text is translated with the
 * back-translation check, and either side can be read aloud, for people who
 * find reading hard.
 */
import type { Lang } from '../../../../src/core/engines.js'
import { call, messageOf } from '../api.js'
import { fill, h, icon, spinner, toast } from '../dom.js'
import { flagsView, isSevere } from '../flags.js'
import { LANG_NAME, app, other, prefs } from '../state.js'
import { audioBar, errorNotice, lockedView } from '../widgets.js'
import type { Section, Shell } from './section.js'

const MAX_TRANSLATE = 5000
const MAX_SPEAK = 2000

export function translateSection(shell: Shell): Section {
  let from = prefs.get('translate.from', 'en') as Lang
  let translated: string | null = null
  let translatedFrom = ''
  let seq = 0

  const fromLabel = h('span', null)
  const toLabel = h('span', null)
  const swap = h('button', { class: 'trio-swap', 'aria-label': 'Swap languages', title: 'Swap languages' }, icon('swap'))
  const header = h('div', { class: 'trio' }, fromLabel, h('span', { class: 'trio-name' }, 'Translate & read aloud'), toLabel, swap)

  const srcHead = h('span', null)
  const count = h('span', { class: 'muted' })
  const textarea = h('textarea', { 'aria-label': 'Text to translate', placeholder: 'Type or paste text' })
  const srcAudio = audioBar('tr-source', async () => (await call('voice.speak', { text: textarea.value.trim().slice(0, MAX_SPEAK), lang: from })).wav, 'Read aloud')

  const outHead = h('span', null)
  const copy = h('button', { class: 'icon-btn', 'aria-label': 'Copy the translation', title: 'Copy', disabled: true }, icon('copy'))
  const output = h('div', { class: 'output placeholder selectable', 'aria-live': 'polite' })
  const outAudio = audioBar('tr-output', async () => (await call('voice.speak', { text: (translated ?? '').slice(0, MAX_SPEAK), lang: other(from) })).wav, 'Read aloud')

  const go = h('button', { class: 'btn primary' }, icon('translate'), 'Translate', h('kbd', null, '⌘↩'))
  const clear = h('button', { class: 'btn ghost' }, 'Clear')
  const check = h('div', { class: 'check-host' })

  const panes = h(
    'div',
    { class: 'tr-panes' },
    h('section', { class: 'pane source' }, h('div', { class: 'pane-head' }, srcHead, count), textarea, h('div', { class: 'pane-foot' }, srcAudio.el)),
    h('section', { class: 'pane' }, h('div', { class: 'pane-head' }, outHead, copy), output, h('div', { class: 'pane-foot' }, outAudio.el))
  )
  const tr = h('div', { class: 'tr' }, panes, h('div', { class: 'tr-bottom' }, h('div', { class: 'tr-actions' }, go, clear), check))

  function labels() {
    const to = other(from)
    fromLabel.textContent = `From ${LANG_NAME[from]}`
    toLabel.textContent = `Into ${LANG_NAME[to]}`
    srcHead.textContent = LANG_NAME[from]
    outHead.textContent = LANG_NAME[to]
    textarea.lang = from
    output.lang = to
    textarea.placeholder = `Type or paste ${LANG_NAME[from]} text`
  }

  function update() {
    const text = textarea.value.trim()
    count.textContent = text.length > MAX_TRANSLATE * 0.8 ? `${text.length} / ${MAX_TRANSLATE}` : ''
    go.disabled = !text || text.length > MAX_TRANSLATE || !app.can('translate')
    srcAudio.setEnabled(!!text && app.can('read-aloud'))
    outAudio.setEnabled(!!translated && app.can('read-aloud'))
    copy.disabled = !translated
    const stale = translated !== null && text !== translatedFrom
    output.classList.toggle('placeholder', !translated || stale)
    if (!translated) output.textContent = `The ${LANG_NAME[other(from)]} translation appears here.`
  }

  textarea.addEventListener('input', () => {
    srcAudio.invalidate()
    update()
  })
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.metaKey) {
      e.preventDefault()
      void run()
    }
  })
  go.addEventListener('click', () => void run())
  clear.addEventListener('click', () => {
    textarea.value = ''
    reset()
    textarea.focus()
  })
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(translated ?? '')
      toast('Translation copied')
    } catch {
      toast('Could not copy. Select the text and press ⌘C.', 'alert')
    }
  })
  swap.addEventListener('click', () => {
    const carry = translated && textarea.value.trim() === translatedFrom ? translated : textarea.value
    from = other(from)
    prefs.set('translate.from', from)
    textarea.value = carry
    labels()
    reset()
  })

  function reset() {
    seq++
    translated = null
    translatedFrom = ''
    srcAudio.invalidate()
    outAudio.invalidate()
    fill(check)
    update()
  }

  async function run() {
    const text = textarea.value.trim()
    if (!text || go.disabled) return
    const my = ++seq
    go.disabled = true
    fill(check, h('div', { class: 'check' }, h('div', { class: 'check-line' }, spinner(), 'Translating, then translating back to check…')))
    try {
      const t = await call('translate.text', { text, from, to: other(from), check: true })
      if (my !== seq) return
      translated = t.translation
      translatedFrom = text
      output.textContent = t.translation
      outAudio.invalidate()
      if ('backTranslation' in t) {
        const ok = !t.flags.length
        fill(
          check,
          h(
            'div',
            { class: 'check' },
            h(
              'div',
              { class: 'check-line' },
              h('span', { class: `chip ${ok ? 'safe' : t.flags.some(isSevere) ? 'danger' : 'warn'}` }, icon(ok ? 'check' : 'alert'), ok ? 'Checked' : 'Check this'),
              h('span', { class: 'label' }, `Back to ${LANG_NAME[from]}:`),
              h('q', { class: 'selectable' }, t.backTranslation)
            ),
            flagsView(t.flags)
          )
        )
      } else fill(check)
    } catch (err) {
      if (my === seq) fill(check, errorNotice(messageOf(err)))
    } finally {
      if (my === seq) update()
    }
  }

  const locked = h('div', { class: 'fill', hidden: true })
  const root = h('div', { class: 'fill' }, tr, locked)
  function updateLock() {
    const can = app.can('translate') || app.can('read-aloud')
    tr.hidden = !can
    locked.hidden = can
    if (!can) fill(locked, lockedView('Translate & read aloud', () => shell.go('settings', 'licence')))
    update()
  }
  app.onChange(updateLock)

  labels()
  update()

  return {
    id: 'translate',
    title: 'Translate & read aloud',
    desc: 'Typed text, translated and spoken',
    icon: 'translate',
    feature: 'translate',
    root,
    header,
    show() {
      updateLock()
      requestAnimationFrame(() => {
        srcAudio.redraw()
        outAudio.redraw()
        if (!tr.hidden) textarea.focus()
      })
    }
  }
}
