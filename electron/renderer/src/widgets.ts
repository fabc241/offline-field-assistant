/** Small pieces several sections share. */
import type { Lang } from '../../../src/core/engines.js'
import type { LicenseFeature } from '../../../src/features/platform/license.js'
import { messageOf } from './api.js'
import { decode, drawBars, peaks, player } from './audio.js'
import { h, icon, toast } from './dom.js'
import { LANG_NAME } from './state.js'

type WavSource = () => Promise<Uint8Array>

/**
 * A round play button. Fetches the audio on first press, plays it, and turns
 * into a stop button while it plays.
 */
export function playButton(key: string, source: WavSource, opts: { label: string; quiet?: boolean }): HTMLButtonElement {
  let cached: Uint8Array | null = null
  const btn = h('button', { class: `play ${opts.quiet ? 'quiet' : ''}`, 'aria-label': `Play ${opts.label}`, title: `Play ${opts.label}` }, icon('play'))
  const show = (playing: boolean) => {
    btn.classList.toggle('is-playing', playing)
    btn.replaceChildren(playing ? icon('stop') : icon('play'))
    btn.setAttribute('aria-label', `${playing ? 'Stop' : 'Play'} ${opts.label}`)
  }
  const off = player.onChange((k) => (btn.isConnected ? show(k === key) : off()))
  btn.addEventListener('click', async () => {
    if (player.key === key) return player.stop()
    btn.disabled = true
    try {
      cached ??= await source()
      btn.disabled = false
      await player.play(key, cached)
    } catch (err) {
      btn.disabled = false
      toast(messageOf(err), 'alert')
    }
  })
  return btn
}

/**
 * The "Play audio" strip: play button, the recording's waveform filling in
 * as it plays, and a label. `source` is asked again whenever `invalidate()`
 * is called (the text changed).
 */
export function audioBar(key: string, source: WavSource, label: string) {
  let buffer: AudioBuffer | null = null
  let values = new Array<number>(56).fill(0)
  let raf = 0
  const canvas = h('canvas', { class: 'wave', 'aria-hidden': 'true' })
  const btn = h('button', { class: 'play', 'aria-label': `Play ${label}` }, icon('play'))
  const text = h('span', { class: 'audio-bar-label' }, label)
  const el = h('div', { class: 'audio-bar' }, btn, text, canvas)
  let startedAt = 0

  const paint = (progress: number) => drawBars(canvas, values, progress, !buffer)
  const tick = () => {
    if (player.key !== key || !buffer) return paint(buffer ? 1 : 0)
    const ac = player.position
    const progress = Math.min(1, (ac.at - startedAt) / buffer.duration)
    paint(progress)
    raf = requestAnimationFrame(tick)
  }
  const off = player.onChange((k) => {
    if (!el.isConnected) return off()
    const playing = k === key
    btn.classList.toggle('is-playing', playing)
    btn.replaceChildren(icon(playing ? 'stop' : 'play'))
    if (!playing) {
      cancelAnimationFrame(raf)
      paint(buffer ? 1 : 0)
    }
  })
  btn.addEventListener('click', async () => {
    if (player.key === key) return player.stop()
    btn.disabled = true
    text.textContent = 'Preparing…'
    try {
      if (!buffer) {
        buffer = await decode(await source())
        values = peaks(buffer, values.length)
      }
      btn.disabled = false
      text.textContent = label
      const done = player.play(key, buffer)
      startedAt = player.position.end - buffer.duration
      raf = requestAnimationFrame(tick)
      await done
    } catch (err) {
      btn.disabled = false
      text.textContent = label
      toast(messageOf(err), 'alert')
    }
  })
  requestAnimationFrame(() => paint(0))
  return {
    el,
    setEnabled(on: boolean) {
      btn.disabled = !on
    },
    invalidate() {
      if (player.key === key) player.stop()
      buffer = null
      values = new Array<number>(values.length).fill(0)
      paint(0)
    },
    redraw() {
      paint(buffer ? 1 : 0)
    }
  }
}

/** The two languages either side of a section name, as in "English · Phrasebook · Swahili". */
export function langTrio(name: string, current: Lang, onPick: (lang: Lang) => void, labels?: Partial<Record<Lang, string>>) {
  const make = (lang: Lang) =>
    h('button', { 'aria-pressed': String(lang === current), title: `Show in ${LANG_NAME[lang]}`, onclick: () => pick(lang) }, labels?.[lang] ?? LANG_NAME[lang])
  const en = make('en')
  const sw = make('sw')
  const el = h('div', { class: 'trio', role: 'group', 'aria-label': `${name} language` }, en, h('span', { class: 'trio-name' }, name), sw)
  const pick = (lang: Lang, quiet = false) => {
    current = lang
    en.setAttribute('aria-pressed', String(lang === 'en'))
    sw.setAttribute('aria-pressed', String(lang === 'sw'))
    if (!quiet) onPick(lang)
  }
  return { el, set: (lang: Lang) => pick(lang, true) }
}

const FEATURE_NAME: Record<LicenseFeature, string> = {
  conversation: 'Conversation',
  translate: 'Translation',
  speech: 'Speech to text',
  'read-aloud': 'Read aloud',
  documents: 'Documents',
  guide: 'Ask the guide',
  phrasebook: 'Phrasebook',
  packs: 'Content packs'
}
export const featureName = (f: LicenseFeature) => FEATURE_NAME[f]
export const LICENSE_FEATURE_LIST = Object.keys(FEATURE_NAME) as LicenseFeature[]

/** What a section shows instead of itself when the licence does not cover it. */
export function lockedView(title: string, openSettings: () => void): HTMLElement {
  return h(
    'div',
    { class: 'empty locked' },
    h('div', { class: 'empty-icon' }, icon('lock')),
    h('h2', null, `${title} needs a full licence`),
    h('p', null, 'This Mac is running read-only, so the phrasebook and Ask the guide are available. Install a licence to use the rest of the app.'),
    h('div', { class: 'drop-actions' }, h('button', { class: 'btn primary', onclick: openSettings }, icon('key'), 'Open licence settings'))
  )
}

export function errorNotice(message: string): HTMLElement {
  return h('div', { class: 'notice error', role: 'alert' }, icon('alert'), h('span', null, message))
}

export function packNotice(notice: string | undefined): HTMLElement | null {
  return notice ? h('div', { class: 'notice' }, icon('alert'), h('span', null, notice)) : null
}
