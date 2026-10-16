/**
 * 6. Settings: appearance, the licence, the models, content packs, the
 * activity log, and help. Everything an administrator does after install.
 */
import { CallFailure, call, messageOf } from '../api.js'
import { type Child, confirmDialog, fileBytes, fill, h, icon, pickFile, saveFile, spinner, toast } from '../dom.js'
import { app, applyTextSize, applyTheme, prefs, type ThemePref } from '../state.js'
import { LICENSE_FEATURE_LIST, errorNotice, featureName } from '../widgets.js'
import type { Section } from './section.js'

type Page = 'general' | 'licence' | 'models' | 'packs' | 'log' | 'help'

const PAGES: { id: Page; title: string; icon: string }[] = [
  { id: 'general', title: 'General', icon: 'sliders' },
  { id: 'licence', title: 'Licence', icon: 'key' },
  { id: 'models', title: 'Models', icon: 'cpu' },
  { id: 'packs', title: 'Content packs', icon: 'package' },
  { id: 'log', title: 'Activity log', icon: 'list' },
  { id: 'help', title: 'Help', icon: 'help' }
]

const fmtBytes = (n: number) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${(n / 1e6).toFixed(1)} MB`)
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })

export function settingsSection(): Section & { open(page: string): void } {
  let current: Page = (prefs.get('settings.page', 'general') as Page) ?? 'general'
  const nav = h('nav', { class: 'settings-nav', 'aria-label': 'Settings' })
  const body = h('div', { class: 'settings-body' })
  const root = h('div', { class: 'settings' }, nav, body)
  const header = h('div', { class: 'trio' }, h('span', { class: 'trio-name' }, 'Settings'))

  function renderNav() {
    fill(
      nav,
      PAGES.map((p) =>
        h('button', { 'aria-current': p.id === current ? 'page' : null, onclick: () => open(p.id) }, icon(p.icon), p.title)
      )
    )
  }

  function open(page: string) {
    current = PAGES.some((p) => p.id === page) ? (page as Page) : 'general'
    prefs.set('settings.page', current)
    renderNav()
    void renderPage()
  }

  const title = (t: string, lead: string) => [h('h1', null, t), h('p', { class: 'lead' }, lead)]
  const row = (titleText: string, desc: string | Node | null, control: Node | null) =>
    h('div', { class: 'row' }, h('div', { class: 'row-text' }, h('div', { class: 'row-title' }, titleText), desc ? h('div', { class: 'row-desc' }, desc) : null), control)

  async function renderPage() {
    body.scrollTop = 0
    switch (current) {
      case 'general':
        return fill(body, general())
      case 'help':
        return fill(body, help())
      default:
        fill(body, h('div', { class: 'empty' }, spinner()))
        try {
          const page = current
          const view = page === 'licence' ? await licence() : page === 'models' ? await models() : page === 'packs' ? await packs() : await log()
          if (page === current) fill(body, view)
        } catch (err) {
          fill(body, errorNotice(messageOf(err)))
        }
    }
  }

  function segmented<T extends string>(label: string, options: [T, string][], value: T, onPick: (v: T) => void) {
    const el = h('div', { class: 'segmented', role: 'group', 'aria-label': label })
    const draw = (v: T) =>
      fill(
        el,
        options.map(([id, text]) =>
          h(
            'button',
            {
              'aria-pressed': String(id === v),
              onclick: () => {
                onPick(id)
                draw(id)
              }
            },
            text
          )
        )
      )
    draw(value)
    return el
  }

  function general(): Child[] {
    return [
      ...title('General', 'How the app looks on this Mac.'),
      h(
        'div',
        { class: 'group' },
        row(
          'Appearance',
          'Follow the Mac, or keep the app light or dark.',
          segmented<ThemePref>(
            'Appearance',
            [
              ['system', 'Same as Mac'],
              ['light', 'Light'],
              ['dark', 'Dark']
            ],
            prefs.get('theme', 'system') as ThemePref,
            (v) => {
              prefs.set('theme', v)
              applyTheme(v)
            }
          )
        ),
        row(
          'Text size',
          'Larger text for reading at arm’s length.',
          segmented(
            'Text size',
            [
              ['normal', 'Normal'],
              ['large', 'Large']
            ],
            prefs.get('textSize', 'normal'),
            (v) => {
              prefs.set('textSize', v)
              applyTextSize(v)
            }
          )
        )
      ),
      h(
        'div',
        { class: 'group' },
        h('h2', null, 'Keyboard shortcuts'),
        h(
          'div',
          { class: 'shortcuts' },
          [
            ['Go to a section', '⌘1 – ⌘6'],
            ['Clinician talks (Conversation)', 'Hold Space'],
            ['Patient talks (Conversation)', 'Hold Return'],
            ['Search (Phrasebook, Ask the guide)', '/'],
            ['Translate (Translate & read aloud)', '⌘↩']
          ].map(([what, keys]) => [h('span', null, what), h('span', null, keys!.split(' ').map((k) => (k === '–' ? ' – ' : k === 'Hold' ? 'Hold ' : h('kbd', null, k))))])
        )
      )
    ]
  }

  async function licence(): Promise<Child[]> {
    const l = await call('license.status', {})
    const full = l.mode === 'full'
    const tone = l.status === 'valid' ? (l.warnings.length ? 'warn' : '') : 'danger'
    const install = async () => {
      const f = await pickFile('.ofalicense,application/json')
      if (!f) return
      try {
        await call('license.install', { text: await f.text() })
        toast('Licence installed. Quit and reopen the app to apply it.')
        fill(body, await licence())
      } catch (err) {
        toast(messageOf(err), 'alert')
      }
    }
    return [
      ...title('Licence', 'The licence decides which parts of the app this Mac can use. It is checked when the app starts, never online.'),
      h(
        'div',
        { class: 'group' },
        h(
          'div',
          { class: 'status-hero' },
          h('div', { class: `status-dot ${tone}` }, icon(full ? 'check' : 'lock')),
          h('div', null, h('h2', null, full ? 'Full licence' : 'Read-only'), h('div', { class: 'row-desc' }, l.message))
        ),
        h(
          'dl',
          { class: 'dl' },
          l.licensee ? [h('dt', null, 'Licensed to'), h('dd', null, l.licensee)] : null,
          l.expiry ? [h('dt', null, 'Expires'), h('dd', null, `${fmtDate(l.expiry)}${l.daysLeft !== undefined && l.daysLeft >= 0 ? ` (in ${l.daysLeft} days)` : ''}`)] : null,
          l.warnings.includes('clock-behind') ? [h('dt', null, 'Clock'), h('dd', null, 'This Mac’s clock is behind the licence’s issue date. Check the date and time.')] : null,
          h('dt', null, 'Can use'),
          h(
            'dd',
            null,
            h(
              'div',
              { class: 'features' },
              LICENSE_FEATURE_LIST.map((f) =>
                h('span', { class: `chip ${l.available.includes(f) ? 'accent' : ''}` }, icon(l.available.includes(f) ? 'check' : 'lock'), featureName(f))
              )
            )
          )
        )
      ),
      h(
        'div',
        { class: 'group' },
        row('Install a licence file', 'A .ofalicense file from your organisation. It applies the next time the app opens.', h('button', { class: 'btn primary', onclick: () => void install() }, icon('upload'), 'Choose licence file…')),
        l.deviceId
          ? row(
              'This Mac’s device ID',
              h('code', null, l.deviceId),
              h(
                'button',
                {
                  class: 'btn',
                  onclick: async () => {
                    await navigator.clipboard.writeText(l.deviceId!).catch(() => undefined)
                    toast('Device ID copied')
                  }
                },
                icon('copy'),
                'Copy'
              )
            )
          : null
      )
    ]
  }

  async function models(): Promise<Child[]> {
    const m = await call('models.status', {})
    const missing = m.models.filter((x) => x.status !== 'ok')
    const STATUS: Record<string, string> = { ok: 'Ready', missing: 'Missing', 'size-mismatch': 'Damaged', 'hash-mismatch': 'Damaged' }
    return [
      ...title('Models', 'Speech, translation, read-aloud and text-reading models. They run on this Mac only and arrive as a signed model pack, usually on a USB stick.'),
      h(
        'div',
        { class: 'group' },
        h(
          'div',
          { class: 'status-hero' },
          h('div', { class: `status-dot ${missing.length ? 'danger' : ''}` }, icon(missing.length ? 'alert' : 'check')),
          h(
            'div',
            null,
            h('h2', null, missing.length ? `${missing.length} of ${m.models.length} models need installing` : 'All models ready'),
            h(
              'div',
              { class: 'row-desc' },
              m.pack.status === 'signed'
                ? `Model pack ${m.pack.manifest.id} ${m.pack.manifest.version}, signed by ${m.pack.signedBy.label}`
                : m.pack.status === 'invalid'
                  ? `The model pack record does not check out: ${m.pack.problem}`
                  : 'Not installed from a signed model pack'
            )
          )
        ),
        m.models.map((x) =>
          row(x.name, null, h('span', { class: `chip ${x.status === 'ok' ? 'safe' : 'danger'}` }, icon(x.status === 'ok' ? 'check' : 'alert'), STATUS[x.status] ?? x.status))
        )
      ),
      h(
        'div',
        { class: 'group' },
        h('h2', null, 'Install or update from a USB stick'),
        h(
          'div',
          { class: 'help-list' },
          h('p', { class: 'muted' }, 'Plug in the stick, then run this in Terminal with the pack’s folder name. The signature is checked and every file verified before anything is replaced.'),
          h('code', { class: 'code' }, '"/Applications/Offline Field Assistant.app/Contents/MacOS/offline-field-assistant" ofa models install /Volumes/USB/ofa-models-1.0.0')
        )
      )
    ]
  }

  async function packs(): Promise<Child[]> {
    const list = await call('packs.list', {})
    const install = async () => {
      const f = await pickFile('.ofapack')
      if (!f) return
      try {
        const p = await call('packs.install', { bytes: await fileBytes(f) })
        const synthetic = p.files.filter((x) => x.synthetic).length
        toast(`Installed ${p.title} ${p.version}${synthetic ? ` (${synthetic} placeholder recordings)` : ''}`)
        await app.refresh()
        fill(body, await packs())
      } catch (err) {
        toast(err instanceof CallFailure ? err.message : messageOf(err), 'alert')
      }
    }
    return [
      ...title('Content packs', 'Your organisation’s phrases and guidance cards. Only packs signed by a trusted key are accepted, and an older version never replaces a newer one.'),
      h(
        'div',
        { class: 'group' },
        list.length
          ? list.map((p) => row(p.id, `Version ${p.version}`, h('span', { class: 'chip safe' }, icon('check'), 'Installed')))
          : row('No content pack installed', 'The phrasebook and Ask the guide stay empty until one is installed.', null),
        row('Install a pack', 'A signed .ofapack file.', h('button', { class: 'btn primary', onclick: () => void install() }, icon('upload'), 'Choose pack file…'))
      )
    ]
  }

  async function log(): Promise<Child[]> {
    const s = await call('logs.status', {})
    const ok = !s.problems.length
    const exportLog = async () => {
      try {
        const r = await call('logs.export', {})
        saveFile(`activity-log-${new Date().toISOString().slice(0, 10)}.jsonl`, r.records.map((x) => JSON.stringify(x)).join('\n') + '\n', 'application/x-ndjson')
        toast(`Exported ${r.records.length} records`)
      } catch (err) {
        toast(messageOf(err), 'alert')
      }
    }
    const wipe = async () => {
      const yes = await confirmDialog({
        title: 'Delete the whole activity log?',
        body: 'Every record and the key that unlocks them are deleted from this Mac. This cannot be undone.',
        confirm: 'Delete log',
        danger: true
      })
      if (!yes) return
      try {
        const r = await call('logs.wipe', { confirm: true })
        toast(`Deleted ${r.files} log files`)
        fill(body, await log())
      } catch (err) {
        toast(messageOf(err), 'alert')
      }
    }
    return [
      ...title('Activity log', 'What the app did, for review: which feature, when, how long it took, and the outcome. Each line is encrypted on this Mac and kept for 30 days.'),
      h(
        'div',
        { class: 'group' },
        h(
          'div',
          { class: 'status-hero' },
          h('div', { class: `status-dot ${ok ? '' : 'danger'}` }, icon(ok ? 'shield' : 'alert')),
          h(
            'div',
            null,
            h('h2', null, ok ? 'Every line checks out' : `${s.problems.length} problems found`),
            h('div', { class: 'row-desc' }, `${s.lines} records over ${s.days.length} ${s.days.length === 1 ? 'day' : 'days'}`)
          )
        ),
        row(
          'What is recorded',
          s.transcripts ? 'Metadata, and what people said, typed or read.' : 'Metadata only. What people said, typed or read is never recorded.',
          h('span', { class: `chip ${s.transcripts ? 'warn' : 'safe'}` }, s.transcripts ? 'Includes words' : 'Metadata only')
        ),
        row('Key', `Kept in ${s.keyStore === 'keychain' ? 'the macOS Keychain' : 'macOS secure storage'}`, null),
        !ok ? h('div', { class: 'row' }, h('ul', { class: 'row-desc' }, s.problems.slice(0, 8).map((p) => h('li', null, JSON.stringify(p))))) : null
      ),
      h(
        'div',
        { class: 'group' },
        row('Export for review', 'Decrypted records, one per line, saved as a file.', h('button', { class: 'btn', onclick: () => void exportLog() }, icon('download'), 'Export…')),
        row('Delete the log', 'Removes every record and the log key.', h('button', { class: 'btn danger', onclick: () => void wipe() }, icon('trash'), 'Delete log…'))
      )
    ]
  }

  function help(): Child[] {
    const items: [string, string, string][] = [
      ['chat', 'Conversation', 'Each person holds their button and speaks their own language. The app writes it down, translates it and reads it aloud for the other person. Under each of your sentences, “Back to English” shows how the translation reads in English again.'],
      ['book', 'Phrasebook', 'Common phrases recorded by people, played exactly as recorded. A “Placeholder voice” label means a computer voice stands in until a native speaker records it.'],
      ['guide', 'Ask the guide', 'Type or say the main symptom. The guide shows your organisation’s card with its danger signs first. It never makes up an answer: when no card fits, it says to see a clinician.'],
      ['doc', 'Documents', 'Translates a photo or PDF part by part. Parts that were hard to read are marked; compare them with the paper.'],
      ['translate', 'Translate & read aloud', 'Translates typed text and reads either side aloud.']
    ]
    return [
      ...title('Help', 'The app works without internet. Nothing you say, type or photograph leaves this Mac.'),
      h(
        'div',
        { class: 'group' },
        h('div', { class: 'help-list' }, items.map(([ic, t, d]) => h('div', null, icon(ic), h('strong', null, t), h('p', null, d))))
      ),
      h(
        'div',
        { class: 'group' },
        h('h2', null, 'When a warning appears'),
        h(
          'div',
          { class: 'help-list' },
          h('p', null, 'Red warnings mean the translation should not be used as it is: a number, a “not”, or the whole meaning may be wrong. Say it again in simpler words, or confirm out loud. Amber warnings ask you to check before relying on it.')
        )
      ),
      app.status ? h('p', { class: 'muted' }, `Offline Field Assistant ${app.status.app}, QVAC SDK ${app.status.sdk}`) : null
    ]
  }

  renderNav()

  return {
    id: 'settings',
    title: 'Settings',
    desc: 'Licence, models, packs, log',
    icon: 'sliders',
    root,
    header,
    show() {
      void renderPage()
    },
    open
  }
}
