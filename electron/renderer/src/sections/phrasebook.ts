/**
 * 2. Phrasebook. Ready-made phrases from the content pack, played as they
 * were recorded, never with a computer voice. The language picked in the
 * top bar is the one shown large and played first: the listener's.
 */
import type { PhraseList } from '../../../../src/app/contract.js'
import type { Lang } from '../../../../src/core/engines.js'
import type { PhraseEntry } from '../../../../src/features/phrasebook/phrasebook.js'
import { CallFailure, call, messageOf } from '../api.js'
import { fill, h, icon, isTyping, spinner } from '../dom.js'
import { LANG_NAME, other, prefs } from '../state.js'
import { errorNotice, langTrio, packNotice, playButton } from '../widgets.js'
import type { Section, Shell } from './section.js'

const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export function phrasebookSection(shell: Shell): Section {
  let primary = prefs.get('phrasebook.lang', 'sw') as Lang
  let category = 'all'
  let query = ''
  let list: PhraseList | null = null
  let shown: PhraseEntry[] = []
  let searchSeq = 0

  const trio = langTrio('Phrasebook', primary, (lang) => {
    primary = lang
    prefs.set('phrasebook.lang', lang)
    renderGrid()
  })

  const input = h('input', { class: 'field', type: 'search', placeholder: 'Search phrases in English or Swahili', 'aria-label': 'Search phrases' })
  const cats = h('div', { class: 'cats', role: 'group', 'aria-label': 'Categories' })
  const body = h('div', { class: 'pb-body' })
  const root = h('div', { class: 'pb' }, h('div', { class: 'toolbar' }, h('label', { class: 'search' }, icon('search'), input), cats), body)

  let timer = 0
  input.addEventListener('input', () => {
    clearTimeout(timer)
    timer = window.setTimeout(() => void search(input.value.trim()), 160)
  })
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      input.value = ''
      void search('')
    }
  })

  async function load() {
    fill(body, h('div', { class: 'empty' }, spinner()))
    try {
      list = await call('phrasebook.list', {})
      shown = list.phrases
      renderCats()
      renderGrid()
    } catch (err) {
      list = null
      if (err instanceof CallFailure && err.code === 'no-pack') {
        fill(
          body,
          h(
            'div',
            { class: 'empty' },
            h('div', { class: 'empty-icon' }, icon('package')),
            h('h2', null, 'No phrases yet'),
            h('p', null, 'Phrases come with your organisation’s content pack. Install the pack to use the phrasebook.'),
            h('button', { class: 'btn primary', onclick: () => shell.go('settings', 'packs') }, icon('package'), 'Install a content pack')
          )
        )
      } else fill(body, errorNotice(messageOf(err)))
    }
  }

  async function search(q: string) {
    query = q
    if (!list) return
    if (!q) {
      shown = list.phrases
      return renderGrid()
    }
    const seq = ++searchSeq
    try {
      // People mix languages; search as both and keep each phrase's better score.
      const [en, sw] = await Promise.all((['en', 'sw'] as const).map((lang) => call('phrasebook.search', { query: q, lang, limit: 20 })))
      if (seq !== searchSeq) return
      const best = new Map<string, { phrase: PhraseEntry; score: number }>()
      for (const hit of [...en!.hits, ...sw!.hits]) {
        const had = best.get(hit.phrase.id)
        if (!had || hit.score > had.score) best.set(hit.phrase.id, hit)
      }
      shown = [...best.values()].sort((a, b) => b.score - a.score).map((x) => x.phrase)
      renderGrid()
    } catch (err) {
      if (seq === searchSeq) fill(body, errorNotice(messageOf(err)))
    }
  }

  function renderCats() {
    if (!list) return
    const all = ['all', ...list.categories]
    fill(
      cats,
      all.map((c) =>
        h(
          'button',
          {
            'aria-pressed': String(c === category),
            onclick: () => {
              category = c
              renderCats()
              renderGrid()
            }
          },
          c === 'all' ? 'All' : sentence(c)
        )
      )
    )
  }

  function renderGrid() {
    if (!list) return
    const phrases = shown.filter((p) => category === 'all' || p.category === category)
    const second = other(primary)
    const isSynthetic = (p: PhraseEntry) => p.recordings.en.synthetic || p.recordings.sw.synthetic
    // When every recording is a stand-in, say so once rather than on each card.
    const allSynthetic = list.phrases.every(isSynthetic)
    const grid = h(
      'div',
      { class: 'pb-grid' },
      phrases.map((p) => {
        const synthetic = !allSynthetic && isSynthetic(p)
        return h(
          'article',
          { class: 'phrase' },
          h(
            'div',
            { class: 'phrase-top' },
            h('span', { class: 'phrase-cat' }, sentence(p.category)),
            synthetic ? h('span', { class: 'chip warn', title: 'A computer voice stands in until a native speaker records this phrase' }, 'Placeholder voice') : null
          ),
          h('div', null, h('div', { class: 'phrase-main', lang: primary }, p.text[primary]), h('div', { class: 'phrase-other', lang: second }, p.text[second])),
          h(
            'div',
            { class: 'phrase-actions' },
            h('span', { class: 'lang-play' }, recordingButton(p, primary, false), LANG_NAME[primary]),
            h('span', { class: 'lang-play' }, recordingButton(p, second, true), LANG_NAME[second])
          )
        )
      })
    )
    const empty = !phrases.length
      ? h(
          'div',
          { class: 'empty' },
          h('div', { class: 'empty-icon' }, icon('search')),
          h('h2', null, query ? `No phrase matches “${query}”` : 'No phrases in this category'),
          h('p', null, query ? 'Try one word, such as “pain” or “homa”. For questions about care, use Ask the guide.' : 'Pick another category.'),
          query ? h('button', { class: 'btn', onclick: () => shell.go('guide') }, icon('guide'), 'Ask the guide instead') : null
        )
      : null
    fill(
      body,
      packNotice(list.notice),
      allSynthetic
        ? h('div', { class: 'notice info' }, icon('info'), h('span', null, 'These recordings are placeholder computer voices until native speakers record the phrases.'))
        : null,
      empty ?? grid
    )
  }

  function recordingButton(p: PhraseEntry, lang: Lang, quiet: boolean) {
    return playButton(
      `phrase-${p.id}-${lang}`,
      async () => (await call('phrasebook.recording', { id: p.id, lang })).wav,
      { label: `“${p.text[lang]}” in ${LANG_NAME[lang]}`, quiet }
    )
  }

  return {
    id: 'phrasebook',
    title: 'Phrasebook',
    desc: 'Recorded phrases by topic',
    icon: 'book',
    feature: 'phrasebook',
    root,
    header: trio.el,
    show() {
      if (!list) void load()
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
