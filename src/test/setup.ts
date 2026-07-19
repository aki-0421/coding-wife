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

class TestResizeObserver implements ResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    void callback
  }

  disconnect() {}

  observe() {}

  unobserve() {}
}

Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  value: TestResizeObserver,
})

Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
  configurable: true,
  value: () => null,
})

afterEach(() => {
  cleanup()
  testStorage.clear()
})
