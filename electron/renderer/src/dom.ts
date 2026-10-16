/** A few lines of DOM building, so the sections read as markup. */

export type Child = Node | string | number | null | undefined | false | Child[]
type Handler = (event: never) => void
export type Props = Record<string, string | number | boolean | null | undefined | Handler>

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue
    if (typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value as EventListener)
    else if (key === 'class') el.className = String(value)
    else if (value === true) el.setAttribute(key, '')
    else el.setAttribute(key, String(value))
  }
  append(el, children)
  return el
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children.flat(Infinity as 1) as Child[]) {
    if (child === null || child === undefined || child === false) continue
    parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)))
  }
}

/** Replaces an element's content. */
export function fill(el: Element, ...children: Child[]): void {
  el.replaceChildren()
  append(el, children)
}

const SVG = 'http://www.w3.org/2000/svg'

/** An icon from the sprite in index.html. */
export function icon(name: string, cls = ''): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('class', `icon ${cls}`.trim())
  svg.setAttribute('aria-hidden', 'true')
  const use = document.createElementNS(SVG, 'use')
  use.setAttribute('href', `#i-${name}`)
  svg.appendChild(use)
  return svg
}

export function spinner(): HTMLElement {
  return h('span', { class: 'spinner', role: 'status', 'aria-label': 'Working' })
}

/** A short message at the bottom of the window. */
export function toast(message: string, iconName = 'check'): void {
  let host = document.querySelector('.toasts')
  if (!host) host = document.body.appendChild(h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }))
  const el = h('div', { class: 'toast' }, icon(iconName), message)
  host.appendChild(el)
  setTimeout(() => el.remove(), 3200)
}

/** A modal question; resolves true when the confirming button is used. */
export function confirmDialog(opts: { title: string; body: string; confirm: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = h('dialog', null)
    const done = (answer: boolean) => {
      dialog.close()
      dialog.remove()
      resolve(answer)
    }
    append(dialog, [
      h('h2', null, opts.title),
      h('p', null, opts.body),
      h(
        'div',
        { class: 'dialog-actions' },
        h('button', { class: 'btn', onclick: () => done(false) }, 'Cancel'),
        h('button', { class: `btn ${opts.danger ? 'danger solid' : 'primary'}`, onclick: () => done(true) }, opts.confirm)
      )
    ])
    dialog.addEventListener('cancel', () => done(false))
    document.body.appendChild(dialog)
    dialog.showModal()
  })
}

/** Lets the person pick a file; resolves with it, or null when they cancel. */
export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept })
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null))
    input.addEventListener('cancel', () => resolve(null))
    input.click()
  })
}

export async function fileBytes(file: Blob): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer())
}

/** Hands the person a file to save. */
export function saveFile(name: string, content: BlobPart, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const a = h('a', { href: url, download: name })
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** True when a key press belongs to a text field rather than to a shortcut. */
export function isTyping(event: KeyboardEvent): boolean {
  const t = event.target as HTMLElement | null
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
}
