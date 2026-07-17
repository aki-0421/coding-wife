import "@testing-library/jest-dom/vitest"

import { cleanup } from "@testing-library/react"
import { afterEach } from "vitest"

const storageEntries = new Map<string, string>()

const testStorage: Storage = {
  get length() {
    return storageEntries.size
  },
  clear() {
    storageEntries.clear()
  },
  getItem(key) {
    return storageEntries.get(key) ?? null
  },
  key(index) {
    return [...storageEntries.keys()][index] ?? null
  },
  removeItem(key) {
    storageEntries.delete(key)
  },
  setItem(key, value) {
    storageEntries.set(key, value)
  },
}

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: testStorage,
})

afterEach(() => {
  cleanup()
  testStorage.clear()
})
