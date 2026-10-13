import { describe, it, expect } from 'vitest'
import {
  DEFAULT_PREFS,
  clearLegacyLocalStorage,
  lastKey,
  parseLast,
  shotKey,
  storagePrefStore,
  type StorageArea,
} from '../extension/prefs.ts'

function fakeArea(): StorageArea & { items: Record<string, unknown> } {
  const items: Record<string, unknown> = {}
  return {
    items,
    get: async (keys) => Object.fromEntries(keys.filter((k) => k in items).map((k) => [k, items[k]])),
    set: async (next) => {
      Object.assign(items, next)
    },
  }
}

const failingArea: StorageArea = {
  get: async () => {
    throw new Error('storage unavailable')
  },
  set: async () => {
    throw new Error('storage unavailable')
  },
}

describe('storagePrefStore', () => {
  it('returns the defaults when nothing is stored', async () => {
    expect(await storagePrefStore(fakeArea(), 'https://a.example').load()).toEqual(DEFAULT_PREFS)
  })

  it('round-trips last and shot under keys scoped to the origin', async () => {
    const area = fakeArea()
    const store = storagePrefStore(area, 'https://a.example')
    await store.saveLast({ pane_id: 'w1:p2', session: 's1' })
    await store.saveShot(true)
    expect(await store.load()).toEqual({ last: { pane_id: 'w1:p2', session: 's1' }, shot: true })
    expect(Object.keys(area.items).sort()).toEqual([lastKey('https://a.example'), shotKey('https://a.example')].sort())
  })

  it('keeps origins apart', async () => {
    const area = fakeArea()
    await storagePrefStore(area, 'https://a.example').saveLast({ pane_id: 'w1:p2', session: null })
    await storagePrefStore(area, 'https://a.example').saveShot(true)
    expect(await storagePrefStore(area, 'https://b.example').load()).toEqual(DEFAULT_PREFS)
  })

  it('drops malformed stored values', async () => {
    const area = fakeArea()
    area.items[lastKey('https://a.example')] = { pane_id: 42 }
    area.items[shotKey('https://a.example')] = '1'
    expect(await storagePrefStore(area, 'https://a.example').load()).toEqual(DEFAULT_PREFS)
  })

  it('degrades to the defaults and no-op writes when storage fails', async () => {
    const store = storagePrefStore(failingArea, 'https://a.example')
    expect(await store.load()).toEqual(DEFAULT_PREFS)
    await expect(store.saveLast({ pane_id: 'w1:p2', session: null })).resolves.toBeUndefined()
    await expect(store.saveShot(true)).resolves.toBeUndefined()
  })
})

describe('parseLast', () => {
  it('keeps a valid value and nulls a non-string session', () => {
    expect(parseLast({ pane_id: 'p', session: 's' })).toEqual({ pane_id: 'p', session: 's' })
    expect(parseLast({ pane_id: 'p', session: 3 })).toEqual({ pane_id: 'p', session: null })
  })

  it('rejects non-objects', () => {
    expect(parseLast(null)).toBeNull()
    expect(parseLast('w1:p2')).toBeNull()
  })
})

describe('clearLegacyLocalStorage', () => {
  it('removes the keys older versions wrote and leaves the page own keys alone', () => {
    const removed: string[] = []
    clearLegacyLocalStorage({ removeItem: (k: string) => void removed.push(k) })
    expect(removed).toEqual(['cmux:last', 'cmux:shot'])
  })

  it('survives a storage that throws', () => {
    expect(() =>
      clearLegacyLocalStorage({
        removeItem: () => {
          throw new Error('denied')
        },
      }),
    ).not.toThrow()
  })
})
