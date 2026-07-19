import { describe, expect, it, vi } from "vitest"

import {
  narrationCommands,
  narrationSchemaVersion,
  type NarrationSettingsUpdateV1,
  type NarrationSpeakRequestV1,
} from "@/features/narration/contracts"
import {
  DemoNarrationGateway,
  NarrationBoundaryError,
  NativeNarrationGateway,
} from "@/features/narration/transport"

const settingsSnapshot = {
  schemaVersion: narrationSchemaVersion,
  settings: {
    schemaVersion: narrationSchemaVersion,
    version: 0,
    enabled: false,
    muted: false,
    voices: { ja: null, en: null },
    rate: 1,
  },
  runtime: {
    schemaVersion: narrationSchemaVersion,
    playbackState: "idle",
    activeRequestId: null,
    queueDepth: 0,
    lastErrorCode: null,
  },
  loadWarningCode: null,
} as const

const updateRequest: NarrationSettingsUpdateV1 = {
  schemaVersion: narrationSchemaVersion,
  expectedVersion: 0,
  enabled: true,
  muted: false,
  voices: { ja: "Kyoko", en: "Samantha" },
  rate: 1,
}

const speakRequest: NarrationSpeakRequestV1 = {
  schemaVersion: narrationSchemaVersion,
  requestId: "request-1",
  workspaceId: "workspace-1",
  generation: 2,
  sequence: 0,
  locale: "ja",
  kind: "test",
  semanticType: "test",
  priority: "high",
  text: "音声テストです。",
}

describe("NativeNarrationGateway", () => {
  it("uses payload-free reads and wraps exact command request objects", async () => {
    const invoke = vi.fn().mockImplementation((command: string) => {
      if (command === narrationCommands.getSettings) return settingsSnapshot
      if (command === narrationCommands.updateSettings) {
        return {
          ...settingsSnapshot,
          settings: {
            schemaVersion: narrationSchemaVersion,
            version: 1,
            enabled: updateRequest.enabled,
            muted: updateRequest.muted,
            voices: updateRequest.voices,
            rate: updateRequest.rate,
          },
        }
      }
      return null
    })
    const gateway = new NativeNarrationGateway(invoke)

    await expect(gateway.getSettings()).resolves.toEqual(settingsSnapshot)
    await expect(gateway.updateSettings(updateRequest)).resolves.toMatchObject({
      settings: { enabled: true, version: 1 },
    })
    await expect(
      gateway.setScope({
        schemaVersion: narrationSchemaVersion,
        workspaceId: "workspace-1",
        generation: 2,
      }),
    ).resolves.toBeUndefined()

    expect(invoke).toHaveBeenNthCalledWith(1, narrationCommands.getSettings)
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      narrationCommands.updateSettings,
      { request: updateRequest },
    )
    expect(invoke).toHaveBeenNthCalledWith(3, narrationCommands.setScope, {
      request: {
        schemaVersion: narrationSchemaVersion,
        workspaceId: "workspace-1",
        generation: 2,
      },
    })
  })

  it("normalizes typed native errors and malformed private responses", async () => {
    const native = new NativeNarrationGateway(() =>
      Promise.reject(
        Object.assign(new Error("NARRATION-VOICE-UNAVAILABLE"), {
          code: "NARRATION-VOICE-UNAVAILABLE",
          operation: narrationCommands.listVoices,
          recoverable: true,
          userMessageKey: "narration.error.voice",
          detailRef: "narration-v1",
        }),
      ),
    )
    await expect(native.listVoices()).rejects.toEqual(
      expect.objectContaining({
        name: "NarrationBoundaryError",
        code: "NARRATION-VOICE-UNAVAILABLE",
      }),
    )

    const malformed = new NativeNarrationGateway(() =>
      Promise.resolve({ ...settingsSnapshot, repository: "/private/repo" }),
    )
    await expect(malformed.getSettings()).rejects.toEqual(
      expect.objectContaining({
        code: "NARRATION-CONTRACT-INVALID",
        operation: "narration_contract",
        recoverable: false,
      }),
    )
  })
})

describe("DemoNarrationGateway", () => {
  it("is quiet by default and only plays in the exact configured scope", async () => {
    const gateway = new DemoNarrationGateway()
    await expect(gateway.getSettings()).resolves.toMatchObject({
      settings: { enabled: false, muted: false, rate: 1 },
    })
    await expect(gateway.speak(speakRequest)).resolves.toMatchObject({
      disposition: "disabled",
    })

    await gateway.updateSettings(updateRequest)
    await gateway.setScope({
      schemaVersion: narrationSchemaVersion,
      workspaceId: "workspace-1",
      generation: 2,
    })
    await expect(gateway.speak(speakRequest)).resolves.toMatchObject({
      disposition: "queued",
    })
    await expect(gateway.getRuntime()).resolves.toMatchObject({
      playbackState: "playing",
      activeRequestId: "request-1",
    })
    await gateway.cancel("explicit_cancel")
    await expect(gateway.getRuntime()).resolves.toMatchObject({
      playbackState: "idle",
      activeRequestId: null,
    })
  })

  it("keeps versioned settings atomic", async () => {
    const gateway = new DemoNarrationGateway()
    await gateway.updateSettings(updateRequest)
    await expect(gateway.updateSettings(updateRequest)).rejects.toBeInstanceOf(
      NarrationBoundaryError,
    )
    await expect(gateway.getSettings()).resolves.toMatchObject({
      settings: { version: 1, enabled: true },
    })
  })
})
