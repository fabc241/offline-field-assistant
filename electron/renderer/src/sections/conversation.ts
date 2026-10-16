/**
 * 1. Conversation. Each person has a column in their own language: what
 * they said, and what the other person said translated for them. Hold a
 * button (or Space for the clinician, Return for the patient) to talk; the
 * translation is read aloud for the other person as soon as it exists.
 *
 * The clinician column also carries the check: the back-translation of what
 * the clinician said, and any warning, for either side.
 */
import type { AppEvent } from '../../../../src/app/contract.js'
import type { Lang } from '../../../../src/core/engines.js'
import { call, messageOf, newCallId, ofa } from '../api.js'
import { MicError, Recorder, liveWave, player } from '../audio.js'
import { fill, h, icon, isTyping, spinner, toast } from '../dom.js'
import { flagsView, isSevere } from '../flags.js'
import { LANG_NAME, app } from '../state.js'
import { lockedView, playButton } from '../widgets.js'
import type { Section, Shell } from './section.js'

type Side = 'clinician' | 'patient'
const SIDE_LANG: Record<Side, Lang> = { clinician: 'en', patient: 'sw' }
const SIDE_NAME: Record<Side, string> = { clinician: 'Clinician', patient: 'Patient' }
const SIDE_KEY: Record<Side, string> = { clinician: 'Space', patient: 'Return' }
const otherSide = (s: Side): Side => (s === 'clinician' ? 'patient' : 'clinician')

type Stage = 'transcribing' | 'translating' | 'speaking' | 'done' | 'failed'

interface UiTurn {
  id: string
  side: Side
  typed: boolean
  stage: Stage
  source?: string
  translation?: string
  backTranslation?: string
  flags: string[]
  wav?: Uint8Array
  error?: string
}

const STAGE_TEXT: Record<Stage, string> = {
  transcribing: 'Listening back…',
  translating: 'Translating…',
  speaking: 'Speaking…',
  done: '',
  failed: ''
}

export function conversationSection(shell: Shell): Section {
  const turns: UiTurn[] = []
  const recorder = new Recorder()
  let busy = false
  let recordingSide: Side | null = null

  const header = h(
    'div',
    { class: 'trio', 'aria-label': 'Conversation' },
    h('span', null, `Clinician · ${LANG_NAME.en}`),
    h('span', { class: 'trio-name' }, 'Conversation'),
    h('span', null, `Patient · ${LANG_NAME.sw}`)
  )

  const columns = (['clinician', 'patient'] as const).map((side) => column(side))
  const conv = h('div', { class: 'conv' }, columns.map((c) => c.el))

  function column(side: Side) {
    const wave = liveWave(recorder)
    const ptt = h(
      'button',
      { class: 'ptt', 'aria-label': `${SIDE_NAME[side]}: hold to talk in ${LANG_NAME[SIDE_LANG[side]]}` },
      h('span', { class: 'ptt-mic' }, icon('mic')),
      h('span', { class: 'ptt-title' }, side === 'patient' ? 'Bonyeza na ushikilie ili kuongea' : 'Hold to talk'),
      h('span', { class: 'ptt-hint' }, side === 'patient' ? 'Press and hold to talk, in Swahili' : ['Or hold ', h('kbd', null, SIDE_KEY[side]), ' and speak English']),
      wave.el
    )
    ptt.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      ptt.setPointerCapture(e.pointerId)
      void startTalking(side)
    })
    ptt.addEventListener('pointerup', () => void stopTalking(side))
    ptt.addEventListener('pointercancel', () => void stopTalking(side))

    const thread = h('div', { class: 'thread', 'aria-live': 'polite' })
    const textarea = h('textarea', { rows: 1, placeholder: 'Or type what to say in English…', 'aria-label': 'Type a sentence for the patient' })
    const send = h('button', { class: 'btn primary', 'aria-label': 'Translate and read aloud' }, icon('send'))
    const sendTyped = () => {
      const text = textarea.value.trim()
      if (!text || busy) return
      textarea.value = ''
      autosize()
      void runTyped(text)
    }
    const autosize = () => {
      textarea.style.height = 'auto'
      textarea.style.height = `${textarea.scrollHeight}px`
    }
    textarea.addEventListener('input', autosize)
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        sendTyped()
      }
    })
    send.addEventListener('click', sendTyped)

    const foot =
      side === 'clinician'
        ? h('div', { class: 'composer' }, textarea, send)
        : h(
            'div',
            { class: 'conv-foot' },
            h('button', { class: 'btn ghost small', onclick: () => clear() }, icon('trash'), 'Start a new conversation')
          )

    const el = h(
      'section',
      { class: 'conv-side', 'aria-label': SIDE_NAME[side] },
      h('div', { class: 'conv-head' }, h('span', { class: 'conv-role' }, SIDE_NAME[side]), h('span', { class: 'conv-lang' }, LANG_NAME[SIDE_LANG[side]])),
      ptt,
      thread,
      foot
    )
    return { side, el, ptt, wave, thread }
  }

  async function clear() {
    if (busy) return
    player.stop()
    turns.length = 0
    render()
  }

  function setBusy(on: boolean) {
    busy = on
    for (const c of columns) c.ptt.disabled = on && recordingSide !== c.side
  }

  async function startTalking(side: Side) {
    if (busy || recordingSide) return
    if (!app.can('conversation')) return toast('Conversation needs a full licence.', 'lock')
    recordingSide = side
    const col = columns.find((c) => c.side === side)!
    col.ptt.classList.add('is-recording')
    for (const c of columns) if (c.side !== side) c.ptt.disabled = true
    try {
      await recorder.start()
      if (recordingSide !== side) return void recorder.cancel() // let go while the microphone was opening
      col.wave.start()
    } catch (err) {
      recordingSide = null
      col.ptt.classList.remove('is-recording')
      for (const c of columns) c.ptt.disabled = false
      toast(err instanceof MicError ? err.message : messageOf(err), 'alert')
    }
  }

  async function stopTalking(side: Side) {
    if (recordingSide !== side) return
    recordingSide = null
    const col = columns.find((c) => c.side === side)!
    col.ptt.classList.remove('is-recording')
    col.wave.stop()
    const rec = await recorder.stop()
    if (!rec) {
      for (const c of columns) c.ptt.disabled = false
      return toast('Hold the button for as long as you speak.', 'info')
    }
    await runTurn(side, rec.wav)
  }

  async function runTurn(side: Side, wav: Uint8Array) {
    setBusy(true)
    const turn: UiTurn = { id: newCallId('turn'), side, typed: false, stage: 'transcribing', flags: [] }
    turns.push(turn)
    render()
    const key = `turn-${turn.id}`
    let streaming = false
    const off = ofa().onEvent((e: AppEvent) => {
      if (e.callId !== turn.id) return
      if (e.type === 'transcript') Object.assign(turn, { source: e.text, stage: 'translating' })
      else if (e.type === 'translation') Object.assign(turn, { translation: e.text, stage: 'speaking' })
      else if (e.type === 'check') Object.assign(turn, { backTranslation: e.backTranslation, flags: e.flags })
      else if (e.type === 'audio') {
        if (!streaming) player.beginStream(key)
        streaming = true
        void player.enqueue(key, e.wav)
      }
      render()
    })
    try {
      const r = await call('conversation.turn', { wav, side, stream: true }, { callId: turn.id })
      Object.assign(turn, {
        source: r.sourceText,
        translation: r.translation,
        backTranslation: r.backTranslation,
        flags: r.flags,
        wav: r.wav,
        stage: 'done'
      })
      if (streaming) player.endStream(key)
      else if (r.wav) void player.play(key, r.wav)
    } catch (err) {
      Object.assign(turn, { stage: 'failed', error: messageOf(err) })
      if (streaming) player.endStream(key)
    } finally {
      off()
      setBusy(false)
      render()
    }
  }

  /** A typed sentence from the clinician: translated with the check, then read aloud in Swahili. */
  async function runTyped(text: string) {
    setBusy(true)
    const turn: UiTurn = { id: newCallId('typed'), side: 'clinician', typed: true, stage: 'translating', source: text, flags: [] }
    turns.push(turn)
    render()
    try {
      const t = await call('translate.text', { text, from: 'en', to: 'sw', check: true })
      turn.translation = t.translation
      if ('backTranslation' in t) Object.assign(turn, { backTranslation: t.backTranslation, flags: [...t.flags] })
      turn.stage = 'speaking'
      render()
      const speech = await call('voice.speak', { text: t.translation, lang: 'sw' })
      turn.wav = speech.wav
      turn.flags = [...turn.flags, ...speech.flags.filter((f) => !turn.flags.includes(f))]
      turn.stage = 'done'
      render()
      void player.play(`turn-${turn.id}`, speech.wav)
    } catch (err) {
      Object.assign(turn, { stage: turn.translation ? 'done' : 'failed', error: messageOf(err) })
    } finally {
      setBusy(false)
      render()
    }
  }

  function render() {
    for (const col of columns) {
      const atBottom = col.thread.scrollHeight - col.thread.scrollTop - col.thread.clientHeight < 40
      if (!turns.length) {
        fill(
          col.thread,
          h(
            'p',
            { class: 'thread-empty' },
            col.side === 'clinician'
              ? 'Hold the button and speak English. The patient hears it in Swahili, and what they answer appears here in English.'
              : 'What the patient says appears here, and the clinician’s words are read aloud in Swahili.'
          )
        )
        continue
      }
      fill(col.thread, turns.map((t) => (t.side === col.side ? ownMessage(t, col.side) : theirMessage(t, col.side))))
      if (atBottom || turns.at(-1)?.stage !== 'done') col.thread.scrollTop = col.thread.scrollHeight
    }
  }

  /** What this column's person said. */
  function ownMessage(t: UiTurn, column: Side): HTMLElement {
    const bubble =
      t.source !== undefined
        ? h('div', { class: 'bubble' }, t.source || '…')
        : h('div', { class: 'bubble pending' }, spinner(), STAGE_TEXT[t.stage] || 'Listening back…')
    const parts: (HTMLElement | null)[] = [bubble]
    if (t.stage === 'failed') parts.push(h('div', { class: 'msg-meta' }, icon('alert'), t.error ?? 'Something went wrong.'))
    // The check is for the clinician: shown on their own words, in English.
    if (column === 'clinician' && t.side === 'clinician' && t.stage !== 'failed') {
      parts.push(checkLine(t))
      parts.push(flagsView(t.flags))
    }
    if (t.typed) parts.push(h('div', { class: 'msg-meta' }, icon('send'), 'Typed'))
    return h('div', { class: 'msg own' }, parts)
  }

  /** What the other person said, translated for this column's person. */
  function theirMessage(t: UiTurn, column: Side): HTMLElement {
    if (t.stage === 'failed' && !t.translation) return h('div', { class: 'msg theirs', hidden: true })
    const translated = t.translation !== undefined
    const text = translated ? t.translation || '(nothing was translated)' : ''
    const bubble = translated
      ? h('div', { class: 'bubble' }, text)
      : h('div', { class: 'bubble pending' }, spinner(), t.stage === 'transcribing' ? 'Listening…' : 'Translating…')
    const row = h(
      'div',
      { class: 'bubble-row' },
      bubble,
      t.wav || t.stage === 'speaking'
        ? playButton(`turn-${t.id}`, async () => t.wav ?? new Uint8Array(), { label: `the ${LANG_NAME[SIDE_LANG[column]]} translation`, quiet: true })
        : null
    )
    const parts: (HTMLElement | null)[] = [row]
    // A warning on the patient's words is still the clinician's to resolve.
    if (column === 'clinician' && t.side === 'patient') parts.push(flagsView(t.flags))
    return h('div', { class: 'msg theirs' }, parts)
  }

  function checkLine(t: UiTurn): HTMLElement | null {
    if (t.backTranslation === undefined) return t.stage === 'done' ? null : h('div', { class: 'msg-meta' }, spinner(), 'Checking the translation…')
    const ok = !t.flags.some(isSevere) && !t.flags.includes('low-fidelity')
    return h(
      'div',
      { class: `msg-meta ${ok ? 'ok' : ''}`, title: 'The Swahili translated back into English, to check it' },
      icon(ok ? 'check' : 'info'),
      h('span', null, 'Back to English: ', h('q', { class: 'selectable' }, t.backTranslation))
    )
  }

  const locked = h('div', { class: 'fill', hidden: true })
  const root = h('div', { class: 'fill' }, conv, locked)

  function updateLock() {
    const can = app.can('conversation')
    conv.hidden = !can
    locked.hidden = can
    if (!can) fill(locked, lockedView('Conversation', () => shell.go('settings', 'licence')))
  }
  app.onChange(updateLock)

  render()
  requestAnimationFrame(() => columns.forEach((c) => c.wave.stop()))

  const keyFor = (e: KeyboardEvent): Side | null => (e.code === 'Space' ? 'clinician' : e.key === 'Enter' ? 'patient' : null)

  return {
    id: 'conversation',
    title: 'Conversation',
    desc: 'Two-way spoken translation',
    icon: 'chat',
    feature: 'conversation',
    root,
    header,
    show() {
      updateLock()
      requestAnimationFrame(() => columns.forEach((c) => c.wave.stop()))
    },
    keydown(e) {
      const side = keyFor(e)
      if (!side || isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return false
      e.preventDefault()
      if (!e.repeat) void startTalking(side)
      return true
    },
    keyup(e) {
      const side = keyFor(e)
      if (!side || recordingSide !== side) return false
      void stopTalking(side)
      return true
    }
  }
}
