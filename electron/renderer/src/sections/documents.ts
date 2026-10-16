/**
 * 4. Documents. A photo or PDF is read and translated part by part. The
 * original stays beside the translation, with each part outlined on the page,
 * and parts that were hard to read are marked before anyone relies on them.
 */
import type { Responses } from '../../../../src/app/contract.js'
import type { Lang } from '../../../../src/core/engines.js'
import { call, messageOf } from '../api.js'
import { fileBytes, fill, h, icon, pickFile, toast } from '../dom.js'
import { flagView } from '../flags.js'
import { LANG_NAME, app, prefs } from '../state.js'
import { audioBar, errorNotice, langTrio, lockedView, playButton } from '../widgets.js'
import type { Section, Shell } from './section.js'

type DocTranslation = Responses['documents.translate']

const ACCEPT = 'image/png,image/jpeg,image/heic,image/heif,image/webp,image/tiff,application/pdf,.heic,.pdf'
const MAX_MB = 50

export function documentsSection(shell: Shell): Section {
  let to = prefs.get('documents.to', 'sw') as Lang
  let file: { name: string; url: string | null; bytes: Uint8Array } | null = null
  let doc: DocTranslation | null = null
  let page = 1
  let seq = 0

  const trio = langTrio(
    'Photo or PDF',
    to,
    (l) => {
      to = l
      prefs.set('documents.to', l)
      if (file) void translate()
    },
    { en: 'Into English', sw: 'Into Swahili' }
  )
  const body = h('div', { class: 'fill' })
  const root = h('div', { class: 'docs' }, body)

  function dropView(): HTMLElement {
    const zone = h(
      'div',
      { class: 'drop' },
      h('div', { class: 'empty-icon' }, icon('doc')),
      h('h2', null, 'Drop a photo or PDF of a form or label'),
      h('p', { class: 'muted' }, `PNG, JPEG, HEIC or PDF, up to ${MAX_MB} MB. Each part is translated and checked, and the original stays beside it.`),
      h(
        'div',
        { class: 'drop-actions' },
        h('button', { class: 'btn primary', onclick: () => void choose() }, icon('upload'), 'Choose a file…'),
        h('button', { class: 'btn', onclick: () => void camera() }, icon('camera'), 'Use the camera')
      )
    )
    zone.addEventListener('dragover', (e) => {
      e.preventDefault()
      zone.classList.add('is-over')
    })
    zone.addEventListener('dragleave', () => zone.classList.remove('is-over'))
    zone.addEventListener('drop', (e) => {
      e.preventDefault()
      zone.classList.remove('is-over')
      const f = e.dataTransfer?.files[0]
      if (f) void open(f)
    })
    return zone
  }

  async function choose() {
    const f = await pickFile(ACCEPT)
    if (f) await open(f)
  }

  async function open(f: File) {
    if (f.size > MAX_MB * 1024 * 1024) return toast(`That file is larger than ${MAX_MB} MB.`, 'alert')
    if (file?.url) URL.revokeObjectURL(file.url)
    const isImage = f.type.startsWith('image/') && !/heic|heif|tiff/.test(f.type)
    file = { name: f.name, url: isImage ? URL.createObjectURL(f) : null, bytes: await fileBytes(f) }
    await translate()
  }

  async function translate() {
    if (!file) return
    const my = ++seq
    doc = null
    page = 1
    fill(
      body,
      h(
        'div',
        { class: 'empty' },
        h('div', { class: 'empty-icon' }, icon('doc')),
        h('h2', null, `Reading ${file.name}`),
        h('p', null, `Finding the text on each page, then translating it into ${LANG_NAME[to]} part by part. A scanned page can take a minute.`),
        h('div', { class: 'progress', role: 'progressbar', 'aria-label': 'Working' }),
        h('button', { class: 'btn ghost', onclick: () => reset() }, 'Cancel')
      )
    )
    try {
      const r = await call('documents.translate', { bytes: file.bytes, to, check: true })
      if (my !== seq) return
      doc = r
      renderResult()
    } catch (err) {
      if (my !== seq) return
      fill(
        body,
        h(
          'div',
          { class: 'empty' },
          errorNotice(messageOf(err)),
          h('div', { class: 'drop-actions' }, h('button', { class: 'btn primary', onclick: () => void choose() }, icon('upload'), 'Choose another file'))
        )
      )
    }
  }

  function reset() {
    seq++
    doc = null
    if (file?.url) URL.revokeObjectURL(file.url)
    file = null
    fill(body, dropView())
  }

  function renderResult() {
    if (!doc || !file) return
    const pages = doc.pages
    const pg = pages.find((p) => p.page === page) ?? pages[0]!
    const segs = doc.segments.map((s, i) => ({ s, i })).filter(({ s }) => s.page === pg.page)
    const flagged = doc.segments.filter((s) => s.flags.length).length
    const boxes = new Map<number, HTMLElement>()
    const rows = new Map<number, HTMLElement>()
    const hot = (i: number, on: boolean) => {
      boxes.get(i)?.classList.toggle('is-hot', on)
      rows.get(i)?.classList.toggle('is-hot', on)
    }

    const pct = (v: number, of: number) => `${((v / of) * 100).toFixed(3)}%`
    const sheet = h('div', { class: `page ${file.url ? '' : 'sheet'}` }, file.url ? h('img', { src: file.url, alt: `Page ${pg.page} of ${file.name}` }) : null)
    // Keep the page's proportions for PDFs, whose pages are drawn as a sheet.
    if (!file.url) sheet.style.aspectRatio = `${pg.width} / ${pg.height}`
    for (const { s, i } of segs) {
      const box = h('div', { class: `box ${s.flags.length ? 'flagged' : ''}`, title: s.original }, file.url ? null : s.original)
      const [x0, y0, x1, y1] = s.bbox
      box.style.left = pct(x0, pg.width)
      box.style.top = pct(y0, pg.height)
      box.style.width = pct(x1 - x0, pg.width)
      box.style.height = pct(y1 - y0, pg.height)
      box.addEventListener('mouseenter', () => hot(i, true))
      box.addEventListener('mouseleave', () => hot(i, false))
      box.addEventListener('click', () => rows.get(i)?.scrollIntoView({ block: 'center', behavior: 'smooth' }))
      boxes.set(i, box)
      sheet.appendChild(box)
    }

    const list = h(
      'div',
      { class: 'segments' },
      h('div', { class: 'seg-head' }, h('span', null, `Original (${LANG_NAME[doc.from]})`), h('span', null, `Translation (${LANG_NAME[doc.to]})`), h('span', null, '')),
      segs.map(({ s, i }) => {
        const canSpeak = !s.kept && s.translation.trim() && app.can('read-aloud')
        const row = h(
          'div',
          { class: 'seg' },
          h('div', { class: 'seg-orig' }, s.original),
          h(
            'div',
            { class: 'seg-tr' },
            s.translation,
            s.kept ? h('span', { class: 'seg-kept' }, s.kept === 'no-words' ? 'Numbers and dates are kept as printed' : `Already in ${LANG_NAME[doc!.to]}`) : null,
            s.flags.map(flagView)
          ),
          canSpeak
            ? playButton(`seg-${i}`, async () => (await call('voice.speak', { text: s.translation, lang: doc!.to })).wav, { label: 'this part aloud', quiet: true })
            : h('span', null)
        )
        row.addEventListener('mouseenter', () => hot(i, true))
        row.addEventListener('mouseleave', () => hot(i, false))
        rows.set(i, row)
        return row
      })
    )

    const allText = segs
      .filter(({ s }) => !s.kept)
      .map(({ s }) => s.translation)
      .join('\n')
      .slice(0, 2000)
    const readAll = audioBar(`doc-page-${pg.page}-${seq}`, async () => (await call('voice.speak', { text: allText, lang: doc!.to })).wav, 'Read the page aloud')
    readAll.setEnabled(!!allText && app.can('read-aloud'))

    fill(
      body,
      h(
        'div',
        { class: 'doc-view' },
        h(
          'div',
          { class: 'toolbar' },
          h('strong', null, file.name),
          flagged
            ? h('span', { class: 'chip warn' }, icon('alert'), `${flagged} of ${doc.segments.length} parts need checking`)
            : h('span', { class: 'chip safe' }, icon('check'), `${doc.segments.length} parts translated`),
          h('span', { class: 'spacer' }),
          h('div', { class: 'toolbar-audio' }, readAll.el),
          h('button', { class: 'btn', onclick: () => reset() }, icon('plus'), 'New document')
        ),
        h(
          'div',
          { class: 'doc-split' },
          h(
            'div',
            { class: 'doc-preview' },
            h(
              'div',
              { class: 'doc-pages' },
              pages.length > 1
                ? [
                    h('button', { class: 'btn small', disabled: pg.page <= 1, onclick: () => goPage(pg.page - 1) }, 'Previous'),
                    `Page ${pg.page} of ${pages.length}`,
                    h('button', { class: 'btn small', disabled: pg.page >= pages.length, onclick: () => goPage(pg.page + 1) }, 'Next')
                  ]
                : pg.source === 'ocr'
                  ? 'Read from the photo.'
                  : 'Text taken from the PDF.',
              h('span', { class: 'muted' }, 'Point at a part to find it on the page.')
            ),
            h('div', { class: 'page-wrap' }, sheet)
          ),
          segs.length ? list : h('div', { class: 'empty' }, h('h2', null, 'No text found on this page'), h('p', null, 'Try a sharper photo, taken straight on, in good light.'))
        )
      )
    )
  }

  function goPage(p: number) {
    page = p
    renderResult()
  }

  /** A still from the camera, sent like a photo. */
  async function camera() {
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1920 }, height: { ideal: 1080 } } })
    } catch {
      return toast('The camera is off for this app. Turn it on in System Settings › Privacy & Security › Camera.', 'alert')
    }
    const video = h('video', { autoplay: true, playsinline: true, muted: true })
    video.srcObject = stream
    const dialog = h('dialog', { class: 'camera' })
    const close = () => {
      stream.getTracks().forEach((t) => t.stop())
      dialog.close()
      dialog.remove()
    }
    const capture = async () => {
      const canvas = h('canvas', null)
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      canvas.getContext('2d')!.drawImage(video, 0, 0)
      close()
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.92))
      if (blob) await open(new File([blob], 'Camera photo.jpg', { type: 'image/jpeg' }))
    }
    fill(
      dialog,
      h('h2', null, 'Hold the page flat and straight'),
      h('p', null, 'Fill the frame with the page, in good light.'),
      video,
      h('div', { class: 'dialog-actions' }, h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: () => void capture() }, icon('camera'), 'Take photo'))
    )
    dialog.addEventListener('cancel', close)
    document.body.appendChild(dialog)
    dialog.showModal()
  }

  const locked = h('div', { class: 'fill', hidden: true })
  const outer = h('div', { class: 'fill' }, root, locked)
  function updateLock() {
    const can = app.can('documents')
    root.hidden = !can
    locked.hidden = can
    if (!can) fill(locked, lockedView('Documents', () => shell.go('settings', 'licence')))
  }
  app.onChange(updateLock)

  fill(body, dropView())

  return {
    id: 'documents',
    title: 'Documents',
    desc: 'Translate a photo or PDF',
    icon: 'doc',
    feature: 'documents',
    root: outer,
    header: trio.el,
    show: updateLock
  }
}
