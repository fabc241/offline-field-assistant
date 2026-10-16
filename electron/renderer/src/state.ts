/** What every section needs to know: the app's status, the licence, preferences. */
import type { AppStatus } from '../../../src/app/contract.js'
import type { Lang } from '../../../src/core/engines.js'
import type { LicenseFeature } from '../../../src/features/platform/license.js'
import { call } from './api.js'

export const LANG_NAME: Record<Lang, string> = { en: 'English', sw: 'Swahili' }
export const other = (lang: Lang): Lang => (lang === 'en' ? 'sw' : 'en')

type Listener = () => void
const listeners = new Set<Listener>()

export const app = {
  status: null as AppStatus | null,
  statusError: null as string | null,

  /** True while the licence allows a feature (and before the status is known, so nothing flickers locked). */
  can(feature: LicenseFeature): boolean {
    return !this.status || this.status.license.available.includes(feature)
  },
  get readOnly(): boolean {
    return this.status?.license.mode === 'read-only'
  },
  get modelsMissing(): boolean {
    return !!this.status && this.status.models.models.some((m) => m.status !== 'ok')
  },
  onChange(listener: Listener): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  async refresh(): Promise<void> {
    try {
      this.status = await call('app.status', {})
      this.statusError = null
    } catch (err) {
      this.statusError = err instanceof Error ? err.message : String(err)
    }
    listeners.forEach((l) => l())
  }
}

/** Per-viewer conveniences only; the page works the same when storage is unavailable. */
export const prefs = {
  get(key: string, fallback: string): string {
    try {
      return localStorage.getItem(`ofa.${key}`) ?? fallback
    } catch {
      return fallback
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(`ofa.${key}`, value)
    } catch {
      // Not kept; the choice still applies until the window closes.
    }
  }
}

export type ThemePref = 'system' | 'light' | 'dark'
const darkQuery = matchMedia('(prefers-color-scheme: dark)')

export function applyTheme(pref = prefs.get('theme', 'system') as ThemePref): void {
  const dark = pref === 'dark' || (pref === 'system' && darkQuery.matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
}
darkQuery.addEventListener('change', () => applyTheme())

export function applyTextSize(size = prefs.get('textSize', 'normal')): void {
  document.documentElement.dataset.text = size
}
