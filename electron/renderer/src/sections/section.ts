import type { LicenseFeature } from '../../../../src/features/platform/license.js'

export type SectionId = 'conversation' | 'phrasebook' | 'guide' | 'documents' | 'translate' | 'settings'

export interface Section {
  id: SectionId
  title: string
  /** One line in the menu. */
  desc: string
  icon: string
  /** The licence feature the section needs; none for Settings. */
  feature?: LicenseFeature
  root: HTMLElement
  /** The middle of the top bar while the section is shown. */
  header: HTMLElement
  show?(): void
  hide?(): void
  /** Return true when the key was handled. */
  keydown?(event: KeyboardEvent): boolean
  keyup?(event: KeyboardEvent): boolean
}

export interface Shell {
  go(id: SectionId, sub?: string): void
}
