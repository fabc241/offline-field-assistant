/**
 * 3. Ask the guide. A typed or spoken question finds the pack's guidance
 * cards; the best one opens with its danger signs first. Nothing here is
 * generated: no card that fits means "no match, see a clinician".
 */
import type { Lang } from '../../../../src/core/engines.js'
import type { GuideCard, GuideResult } from '../../../../src/features/guide/guide.js'
import { CallFailure, call, messageOf } from '../api.js'
import { MicError, Recorder } from '../audio.js'
import { fill, h, icon, isTyping, spinner, toast } from '../dom.js'
import { LANG_NAME, app, prefs } from '../state.js'
import { audioBar, errorNotice, langTrio, packNotice } from '../widgets.js'
import type { Section, Shell } from './section.js'

const WORDS: Record<Lang, { danger: string; dangerSub: string; steps: string; also: string }> = {
  en: { danger: 'Danger signs', dangerSub: 'Any one of these: refer now.', steps: 'What to do', also: 'Also matches' },
  sw: { danger: 'Dalili za hatari', dangerSub: 'Dalili yoyote kati ya hizi: mpe rufaa sasa.', steps: 'Hatua za kuchukua', also: 'Pia zinazolingana' }
}

const EXAMPLES: Record<Lang, string[]> = {
  en: ['Child with fever and vomiting', 'Signs of dehydration', 'Bleeding in pregnancy'],
  sw: ['Mtoto ana homa na kutapika', 'Dalili za malaria', 'Kikohozi kwa mtoto']
}

export function guideSection(shell: Shell): Section {
  let lang = prefs.get('guide.lang', 'en') as Lang
  let result: GuideResult | null = null
  let cards: GuideCard[] = []
  let selected = 0
  let heard: string | null = null
  let seq = 0
  const recorder = new Recorder()
  let recording = false

  const trio = langTrio('Ask the guide', lang, (l) => void switchLang(l))

  const input = h('input', { type: 'search', placeholder: 'Ask about symptoms, danger signs or what to do', 'aria-label': 'Question for the guide' })
  const mic = h('button', { class: 'icon-btn', 'aria-label': 'Hold to ask out loud', title: 'Hold to ask out loud' }, icon('mic'))
  const go = h('button', { class: 'btn primary' }, 'Search')
  const hint = h('span', null)
  const out = h('div', { 'aria-live': 'polite' })
  const root = h(
    'div',
    { class: 'guide' },
    h('form', { class: 'ask', role: 'search' }, icon('search'), input, mic, go),
    h('div', { class: 'ask-sub' }, hint, h('span', null, 'Answers come only from your organisation’s guide.')),
    out
  )

  root.querySelector('form')!.addEventListener('submit', (e) => {
    e.preventDefault()
    void ask(input.value.trim())
  })

  mic.addEventListener('pointerdown', async (e) => {
    if (e.button !== 0) return
    mic.setPointerCapture(e.pointerId)
    try {
      recording = true
      mic.classList.add('is-recording')
      await recorder.start()
      if (!recording) recorder.cancel()
    } catch (err) {
      recording = false
      mic.classList.remove('is-recording')
      toast(err instanceof MicError ? err.message : messageOf(err), 'alert')
    }
  })
  const release = async () => {
    if (!recording) return
    recording = false
    mic.classList.remove('is-recording')
    const rec = await recorder.stop()
    if (!rec) return toast('Hold the microphone button for as long as you speak.', 'info')
    void askAloud(rec.wav)
  }
  mic.addEventListener('pointerup', () => void release())
  mic.addEventListener('pointercancel', () => void release())

  function setHint() {
    fill(hint, 'Type in English or Swahili, or hold ', icon('mic'), ` to ask out loud in ${LANG_NAME[lang]}.`)
  }

  function working(text: string) {
    fill(out, h('div', { class: 'heard' }, spinner(), text))
  }

  async function ask(q: string) {
    if (!q) return input.focus()
    const my = ++seq
    heard = null
    working('Searching the guide…')
    try {
      const r = await call('guide.search', { query: q })
      if (my !== seq) return
      show(r)
    } catch (err) {
      if (my === seq) fail(err)
    }
  }

  async function askAloud(wav: Uint8Array) {
    const my = ++seq
    working('Listening back to your question…')
    try {
      const r = await call('guide.ask', { wav, lang })
      if (my !== seq) return
      heard = r.transcript.text
      input.value = heard
      show(r.result)
    } catch (err) {
      if (my === seq) fail(err)
    }
  }

  function show(r: GuideResult) {
    result = r
    lang = r.lang
    trio.set(lang)
    setHint()
    cards = r.status === 'match' ? r.hits.map((hit) => hit.card) : []
    selected = 0
    render()
  }

  function fail(err: unknown) {
    if (err instanceof CallFailure && err.code === 'no-pack') {
      fill(
        out,
        h(
          'div',
          { class: 'empty' },
          h('div', { class: 'empty-icon' }, icon('package')),
          h('h2', null, 'The guide is empty'),
          h('p', null, 'Guidance cards come with your organisation’s content pack. Install it to ask the guide.'),
          h('button', { class: 'btn primary', onclick: () => shell.go('settings', 'packs') }, icon('package'), 'Install a content pack')
        )
      )
    } else fill(out, errorNotice(messageOf(err)))
  }

  /** Shows the same cards in the other language. */
  async function switchLang(l: Lang) {
    lang = l
    prefs.set('guide.lang', l)
    setHint()
    if (!cards.length) return render()
    try {
      cards = await Promise.all(cards.map((c) => call('guide.card', { id: c.id, lang: l })))
      render()
    } catch (err) {
      fail(err)
    }
  }

  function render() {
    if (!result) return fill(out, intro())
    const top: (HTMLElement | null)[] = []
    if (heard !== null) top.push(h('div', { class: 'heard' }, icon('mic'), 'Heard: ', h('q', { class: 'selectable' }, heard || '(nothing)')))
    top.push(packNotice(result.notice))
    if (result.degraded) top.push(h('div', { class: 'notice info' }, icon('info'), h('span', null, `Searched by keyword only: ${result.degraded}`)))
    if (result.status === 'no-match') {
      return fill(
        out,
        h(
          'div',
          { class: 'answer' },
          top,
          h(
            'div',
            { class: 'no-match', role: 'status' },
            icon('info'),
            h(
              'div',
              null,
              h('h2', null, 'No card in the guide fits this question'),
              h('p', null, `${result.message}. Ask a clinician, or try other words for the main symptom.`)
            )
          )
        )
      )
    }
    const card = cards[selected]!
    const others = cards.map((c, i) => ({ c, i })).filter(({ i }) => i !== selected)
    fill(
      out,
      h(
        'div',
        { class: 'answer' },
        top,
        cardView(card),
        others.length
          ? h(
              'div',
              { class: 'also' },
              h('h3', null, WORDS[lang].also),
              h(
                'div',
                { class: 'also-grid' },
                others.map(({ c, i }) =>
                  h(
                    'button',
                    {
                      class: 'mini-card',
                      onclick: () => {
                        selected = i
                        render()
                        root.parentElement?.scrollTo({ top: 0, behavior: 'smooth' })
                      }
                    },
                    h('strong', null, c.title),
                    h('ul', null, c.dangerSigns.slice(0, 2).map((s) => h('li', null, s)))
                  )
                )
              )
            )
          : null
      )
    )
  }

  function cardView(card: GuideCard): HTMLElement {
    const w = WORDS[card.lang]
    const spoken = [card.title, `${w.danger}: ${card.dangerSigns.join('. ')}`, `${w.steps}: ${card.steps.join('. ')}`].join('. ').slice(0, 2000)
    const bar = audioBar(`card-${card.id}-${card.lang}`, async () => (await call('voice.speak', { text: spoken, lang: card.lang })).wav, 'Read aloud')
    bar.setEnabled(app.can('read-aloud'))
    return h(
      'article',
      { class: 'card', lang: card.lang },
      h('div', { class: 'card-head' }, h('h2', null, card.title)),
      h(
        'section',
        { class: 'danger-panel', 'aria-label': w.danger },
        h('div', { class: 'danger-head' }, icon('alert'), w.danger),
        h('p', { class: 'danger-sub' }, w.dangerSub),
        h('ul', null, card.dangerSigns.map((s) => h('li', null, s)))
      ),
      h('section', { class: 'steps' }, h('h3', null, w.steps), h('ol', null, card.steps.map((s) => h('li', null, s)))),
      h(
        'div',
        { class: 'card-foot' },
        h('span', null, `${card.source}, version ${card.version}`),
        h('div', { class: 'pane-foot' }, bar.el)
      )
    )
  }

  function intro(): HTMLElement {
    return h(
      'div',
      { class: 'empty' },
      h('div', { class: 'empty-icon' }, icon('guide')),
      h('h2', null, 'What is the patient’s problem?'),
      h(
        'p',
        null,
        'Describe the main symptom in a few words. The guide shows the matching card with its danger signs first. When no card fits, it says so.'
      ),
      h(
        'div',
        { class: 'examples' },
        EXAMPLES[lang].map((q) =>
          h(
            'button',
            {
              onclick: () => {
                input.value = q
                void ask(q)
              }
            },
            q
          )
        )
      )
    )
  }

  setHint()
  render()

  return {
    id: 'guide',
    title: 'Ask the guide',
    desc: 'Guidance cards for a question',
    icon: 'guide',
    feature: 'guide',
    root,
    header: trio.el,
    show() {
      requestAnimationFrame(() => input.focus())
    },
    keydown(e) {
      if ((e.metaKey && e.key === 'f') || (e.key === '/' && !isTyping(e))) {
        e.preventDefault()
        input.focus()
        input.select()
        return true
      }
      return false
    }
  }
}
