/**
 * Per-site picker preferences (last targeted agent, screenshot switch).
 *
 * Kept in the extension's own storage (chrome.storage.local), keyed by the page origin,
 * never in the page's localStorage: page scripts share that origin's localStorage with the
 * content script, so they could read the cmux surface id the user last targeted or pre-set
 * the preselected target and the screenshot switch.
 */

export interface Last {
  pane_id: string
  session: string | null
}

export interface Prefs {
  last: Last | null
  shot: boolean
}

export interface PrefStore {
  load(): Promise<Prefs>
  saveLast(last: Last): Promise<void>
  saveShot(on: boolean): Promise<void>
}

/** The slice of chrome.storage.StorageArea the store needs, so tests can pass a fake */
export interface StorageArea {
  get(keys: string[]): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
}

/** Keys written by versions up to 0.1.0 into the page's own localStorage */
export const LEGACY_LOCAL_STORAGE_KEYS = ['cmux:last', 'cmux:shot'] as const

export const DEFAULT_PREFS: Prefs = { last: null, shot: false }

export function lastKey(origin: string): string {
  return `last:${origin}`
}

export function shotKey(origin: string): string {
  return `shot:${origin}`
}

/** Validates a stored `last` value, dropping anything malformed */
export function parseLast(raw: unknown): Last | null {
  if (raw === null || typeof raw !== 'object') return null
  const candidate = raw as { pane_id?: unknown; session?: unknown }
  if (typeof candidate.pane_id !== 'string') return null
  return { pane_id: candidate.pane_id, session: typeof candidate.session === 'string' ? candidate.session : null }
}

/**
 * Store backed by an extension storage area. Errors (storage unavailable, quota) degrade to
 * the defaults on read and to a no-op on write: preferences are a convenience, never a reason
 * for a pick or a send to fail.
 */
export function storagePrefStore(area: StorageArea, origin: string): PrefStore {
  const last = lastKey(origin)
  const shot = shotKey(origin)
  return {
    async load() {
      try {
        const items = await area.get([last, shot])
        return { last: parseLast(items[last]), shot: items[shot] === true }
      } catch {
        return DEFAULT_PREFS
      }
    },
    async saveLast(value) {
      try {
        await area.set({ [last]: { pane_id: value.pane_id, session: value.session } })
      } catch {
        // storage unavailable: preselection just falls back next time
      }
    },
    async saveShot(on) {
      try {
        await area.set({ [shot]: on })
      } catch {
        // storage unavailable: the preference just won't persist
      }
    },
  }
}

/** In-memory store, for tests and contexts without extension storage */
export function memoryPrefStore(initial: Prefs = DEFAULT_PREFS): PrefStore & { current(): Prefs } {
  let prefs = initial
  return {
    load: async () => prefs,
    saveLast: async (value) => {
      prefs = { ...prefs, last: value }
    },
    saveShot: async (on) => {
      prefs = { ...prefs, shot: on }
    },
    current: () => prefs,
  }
}

/** Removes the keys older versions left in the page's localStorage, which the page can read */
export function clearLegacyLocalStorage(storage: Pick<Storage, 'removeItem'>): void {
  for (const key of LEGACY_LOCAL_STORAGE_KEYS) {
    try {
      storage.removeItem(key)
    } catch {
      // storage unavailable: nothing to clear
    }
  }
}
