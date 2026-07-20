import { describe, expect, it, vi } from "vitest"

import {
  narrationSchemaVersion,
  narrationSettingsSchemaVersion,
  sourceKeyFromCommitNarrationEvent,
  type CommitNarrationConsumerEventV1,
  type CommitNarrationSourceKey,
  type NarrationCancelReason,
  type NarrationMuteRequestV1,
  type NarrationRuntimeSnapshotV1,
  type NarrationScopeRequestV1,
  type NarrationSettingsSnapshotV1,
  type NarrationSettingsUpdateV2,
  type NarrationSpeakRequestV1,
  type NarrationSpeakResponseV1,
  type NarrationVoiceListV1,
} from "@/features/narration/contracts"
import { NarrationController } from "@/features/narration/controller"
import type { NarrationGateway } from "@/features/narration/transport"

const shaA = "a".repeat(40)
const shaB = "b".repeat(40)

function event(
  kind: "started" | "chunk" | "terminal",
  overrides: Record<string, unknown> = {},
): CommitNarrationConsumerEventV1 {
  const base = {
    schemaVersion: narrationSchemaVersion,
    source: "background_support" as const,
    trigger: "auto_verified_commit" as const,
    workspaceId: "workspace-1",
    workspaceGeneration: 3,
    commitSha: shaA,
    requestId: "support-1",
    locale: "ja" as const,
  }
  if (kind === "chunk") {
    return {
      ...base,
      kind,
      sequence: 0,
      text: "最初の説明です。",
      ...overrides,
    }
  }
  if (kind === "terminal") {
    return {
      ...base,
      kind,
      status: "completed",
      errorCode: null,
      ...overrides,
    }
  }
  return { ...base, kind, ...overrides }
}

function initialSnapshot(enabled = false): NarrationSettingsSnapshotV1 {
  return {
    schemaVersion: narrationSchemaVersion,
    settings: {
      schemaVersion: narrationSettingsSchemaVersion,
      version: 0,
      enabled,
      muted: false,
      provider: enabled ? "openai" : null,
      apiKeyConfigured: enabled,
      model: "gpt-4o-mini-tts",
      voice: "marin",
      speed: 1,
    },
    runtime: {
      schemaVersion: narrationSchemaVersion,
      playbackState: "idle",
      activeRequestId: null,
      queueDepth: 0,
      lastErrorCode: null,
    },
    loadWarningCode: null,
  }
}

class FakeNarrationGateway implements NarrationGateway {
  public readonly kind = "demo" as const
  public readonly scopes: NarrationScopeRequestV1[] = []
  public readonly speech: NarrationSpeakRequestV1[] = []
  public readonly cancelReasons: NarrationCancelReason[] = []
  public onSpeak: ((request: NarrationSpeakRequestV1) => void) | null = null
  public onCancel: ((reason: NarrationCancelReason) => void) | null = null
  #snapshot: NarrationSettingsSnapshotV1

  public constructor(enabled = false) {
    this.#snapshot = initialSnapshot(enabled)
  }

  public getSettings(): Promise<NarrationSettingsSnapshotV1> {
    return Promise.resolve(structuredClone(this.#snapshot))
  }

  public getRuntime(): Promise<NarrationRuntimeSnapshotV1> {
    return Promise.resolve(structuredClone(this.#snapshot.runtime))
  }

  public setRuntime(update: Partial<NarrationRuntimeSnapshotV1>): void {
    this.#snapshot = {
      ...this.#snapshot,
      runtime: { ...this.#snapshot.runtime, ...update },
    }
  }

  public listVoices(): Promise<NarrationVoiceListV1> {
    return Promise.resolve({
      schemaVersion: narrationSchemaVersion,
      voices: [
        { name: "marin", locale: "ja_JP" },
        { name: "cedar", locale: "en_US" },
      ],
    })
  }

  public updateSettings(
    request: NarrationSettingsUpdateV2,
  ): Promise<NarrationSettingsSnapshotV1> {
    this.#snapshot = {
      ...this.#snapshot,
      settings: {
        schemaVersion: narrationSettingsSchemaVersion,
        version: request.expectedVersion + 1,
        enabled: request.enabled,
        muted: request.muted,
        provider: request.provider,
        apiKeyConfigured:
          request.apiKeyAction.kind === "clear"
            ? false
            : request.apiKeyAction.kind === "replace"
              ? true
              : this.#snapshot.settings.apiKeyConfigured,
        model: request.model,
        voice: request.voice,
        speed: request.speed,
      },
    }
    return this.getSettings()
  }

  public setMuted(
    request: NarrationMuteRequestV1,
  ): Promise<NarrationSettingsSnapshotV1> {
    this.#snapshot = {
      ...this.#snapshot,
      settings: {
        ...this.#snapshot.settings,
        version: request.expectedVersion + 1,
        muted: request.muted,
      },
    }
    return this.getSettings()
  }

  public resetSettings(
    expectedVersion: number,
  ): Promise<NarrationSettingsSnapshotV1> {
    this.#snapshot = initialSnapshot(false)
    this.#snapshot = {
      ...this.#snapshot,
      settings: { ...this.#snapshot.settings, version: expectedVersion + 1 },
    }
    return this.getSettings()
  }

  public setScope(request: NarrationScopeRequestV1): Promise<void> {
    this.scopes.push(request)
    return Promise.resolve()
  }

  public speak(
    request: NarrationSpeakRequestV1,
  ): Promise<NarrationSpeakResponseV1> {
    this.speech.push(request)
    this.onSpeak?.(request)
    return Promise.resolve({
      schemaVersion: narrationSchemaVersion,
      disposition: "queued",
      queueDepth: 0,
      code: null,
    })
  }

  public cancel(reason: NarrationCancelReason): Promise<void> {
    this.cancelReasons.push(reason)
    this.onCancel?.(reason)
    return Promise.resolve()
  }
}

async function ready(enabled = false) {
  const gateway = new FakeNarrationGateway(enabled)
  const controller = new NarrationController(gateway, () => Promise.resolve())
  await controller.initialize()
  return { controller, gateway }
}

function prepare(
  controller: NarrationController,
  texts = ["最初の説明です。", "次の説明です。"],
) {
  const started = event("started")
  expect(controller.consume(started)).toBe(true)
  texts.forEach((text, sequence) => {
    expect(controller.consume(event("chunk", { sequence, text }))).toBe(true)
  })
  return sourceKeyFromCommitNarrationEvent(started)
}

function acknowledge(
  controller: NarrationController,
  key: CommitNarrationSourceKey,
  sequence: number,
): boolean {
  const presentationGeneration =
    controller.getSnapshot().presentation?.presentationGeneration
  if (presentationGeneration === undefined) {
    throw new Error("presentation is not active")
  }
  return controller.acknowledgeCaptionVisible({
    key,
    presentationGeneration,
    sequence,
  })
}

describe("NarrationController", () => {
  it("buffers automatic generation without exposing caption or speech", async () => {
    const { controller, gateway } = await ready(true)
    prepare(controller)
    controller.consume(event("terminal"))

    expect(controller.getSnapshot().presentation).toBeNull()
    expect(gateway.speech).toHaveLength(0)
  })

  it("publishes accepted chunks before optional speech and replays in exact order", async () => {
    const leads: Array<() => void> = []
    const pauseDurations: number[] = []
    const gateway = new FakeNarrationGateway(true)
    const controller = new NarrationController(gateway, (milliseconds) => {
      pauseDurations.push(milliseconds)
      return new Promise<void>((resolve) => leads.push(resolve))
    })
    await controller.initialize()
    const key = prepare(controller)
    controller.consume(event("terminal"))
    const order: string[] = []
    controller.subscribe(() => {
      const chunks = controller.getSnapshot().presentation?.chunks.length ?? 0
      if (chunks > 0) order.push(`caption:${chunks}`)
    })
    gateway.onSpeak = () => order.push("speech")

    await expect(controller.activatePresentation(key)).resolves.toBe(true)
    expect(controller.getSnapshot().presentation).toMatchObject({
      status: "ready",
      chunks: ["最初の説明です。", "次の説明です。"],
    })
    expect(gateway.speech).toHaveLength(0)
    expect(acknowledge(controller, key, 1)).toBe(true)
    expect(acknowledge(controller, key, 1)).toBe(false)
    expect(
      controller.acknowledgeCaptionVisible({
        key: { ...key, requestId: "other-request" },
        presentationGeneration:
          controller.getSnapshot().presentation?.presentationGeneration ?? 0,
        sequence: 0,
      }),
    ).toBe(false)
    expect(
      controller.acknowledgeCaptionVisible({
        key,
        presentationGeneration:
          (controller.getSnapshot().presentation?.presentationGeneration ?? 0) +
          1,
        sequence: 0,
      }),
    ).toBe(false)
    expect(acknowledge(controller, key, 2)).toBe(false)
    expect(acknowledge(controller, key, 0)).toBe(true)
    expect(pauseDurations).toEqual([100, 100])

    leads[0]?.()
    await Promise.resolve()
    expect(gateway.speech).toHaveLength(0)
    leads[1]?.()
    await vi.waitFor(() => expect(gateway.speech).toHaveLength(2))
    expect(
      gateway.speech.map(({ sequence, text }) => ({ sequence, text })),
    ).toEqual([
      { sequence: 0, text: "最初の説明です。" },
      { sequence: 1, text: "次の説明です。" },
    ])
    expect(order.indexOf("caption:2")).toBeLessThan(order.indexOf("speech"))
  })

  it("never revives speech from a late acknowledgment after timeout", async () => {
    vi.useFakeTimers()
    try {
      const gateway = new FakeNarrationGateway(true)
      const controller = new NarrationController(gateway)
      await controller.initialize()
      const key = prepare(controller, ["説明です。"])
      await controller.activatePresentation(key)

      await vi.advanceTimersByTimeAsync(1_000)
      expect(controller.getSnapshot().presentation).toMatchObject({
        chunks: ["説明です。"],
        speechStatus: "unavailable",
        errorCode: "NARRATION-CAPTION-NOT-VISIBLE",
      })
      expect(acknowledge(controller, key, 0)).toBe(false)

      await vi.advanceTimersByTimeAsync(1_000)
      expect(gateway.speech).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps each streamed chunk on its original visibility deadline", async () => {
    vi.useFakeTimers()
    try {
      const gateway = new FakeNarrationGateway(true)
      const controller = new NarrationController(gateway)
      await controller.initialize()
      const key = prepare(controller, ["最初の説明です。"])
      await controller.activatePresentation(key)

      await vi.advanceTimersByTimeAsync(900)
      expect(
        controller.consume(
          event("chunk", { sequence: 1, text: "後から届いた説明です。" }),
        ),
      ).toBe(true)
      await vi.advanceTimersByTimeAsync(100)

      expect(controller.getSnapshot().presentation).toMatchObject({
        chunks: ["最初の説明です。", "後から届いた説明です。"],
        speechStatus: "unavailable",
        errorCode: "NARRATION-CAPTION-NOT-VISIBLE",
      })
      expect(gateway.speech).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it("streams later chunks only after explicit activation", async () => {
    const { controller, gateway } = await ready(true)
    const key = prepare(controller, ["受理済みです。"])
    await controller.activatePresentation(key)
    expect(acknowledge(controller, key, 0)).toBe(true)
    await vi.waitFor(() => expect(gateway.speech).toHaveLength(1))

    expect(
      controller.consume(
        event("chunk", { sequence: 1, text: "後から届いた説明です。" }),
      ),
    ).toBe(true)
    expect(controller.getSnapshot().presentation?.chunks).toEqual([
      "受理済みです。",
      "後から届いた説明です。",
    ])
    expect(acknowledge(controller, key, 1)).toBe(true)
    await vi.waitFor(() => expect(gateway.speech).toHaveLength(2))
  })

  it("keeps captions when TTS is off", async () => {
    const { controller, gateway } = await ready(false)
    const key = prepare(controller)
    await controller.activatePresentation(key)

    expect(controller.getSnapshot().presentation).toMatchObject({
      chunks: ["最初の説明です。", "次の説明です。"],
      speechStatus: "off",
    })
    expect(gateway.speech).toHaveLength(0)
  })

  it("does not replay muted chunks after unmute", async () => {
    const { controller, gateway } = await ready(true)
    const key = prepare(controller, ["最初の説明です。"])
    await controller.activatePresentation(key)
    expect(acknowledge(controller, key, 0)).toBe(true)
    await vi.waitFor(() => expect(gateway.speech).toHaveLength(1))
    await controller.setMuted(true)

    controller.consume(
      event("chunk", { sequence: 1, text: "ミュート中です。" }),
    )
    expect(controller.getSnapshot().presentation?.chunks).toHaveLength(2)
    expect(gateway.speech).toHaveLength(1)
    await controller.setMuted(false)
    expect(gateway.speech).toHaveLength(1)

    controller.consume(event("chunk", { sequence: 2, text: "解除後です。" }))
    expect(acknowledge(controller, key, 2)).toBe(true)
    await vi.waitFor(() => expect(gateway.speech).toHaveLength(2))
    expect(gateway.speech.at(-1)?.text).toBe("解除後です。")
    expect(gateway.cancelReasons).toContain("mute")
  })

  it("terminalizes immediately with the native unavailable code", async () => {
    const { controller, gateway } = await ready(true)
    const key = prepare(controller, ["説明です。"])
    const runtimeSpy = vi.spyOn(gateway, "getRuntime")
    gateway.setRuntime({
      playbackState: "unavailable",
      activeRequestId: null,
      queueDepth: 0,
      lastErrorCode: "NARRATION-SAY-EXIT",
    })

    await controller.activatePresentation(key)
    expect(acknowledge(controller, key, 0)).toBe(true)

    await vi.waitFor(() =>
      expect(controller.getSnapshot().presentation).toMatchObject({
        speechStatus: "unavailable",
        errorCode: "NARRATION-SAY-EXIT",
      }),
    )
    expect(runtimeSpy).toHaveBeenCalledOnce()
  })

  it("cancels the released speech chain after a terminal speak response", async () => {
    const { controller, gateway } = await ready(true)
    const key = prepare(controller)
    vi.spyOn(gateway, "speak").mockImplementation((request) => {
      gateway.speech.push(request)
      return Promise.resolve({
        schemaVersion: narrationSchemaVersion,
        disposition: request.sequence === 0 ? "unavailable" : "queued",
        queueDepth: 0,
        code: request.sequence === 0 ? "NARRATION-VOICE-UNAVAILABLE" : null,
      })
    })

    await controller.activatePresentation(key)
    expect(acknowledge(controller, key, 0)).toBe(true)
    expect(acknowledge(controller, key, 1)).toBe(true)

    await vi.waitFor(() =>
      expect(controller.getSnapshot().presentation).toMatchObject({
        speechStatus: "unavailable",
        errorCode: "NARRATION-VOICE-UNAVAILABLE",
      }),
    )
    await vi.waitFor(() =>
      expect(gateway.cancelReasons).toContain("explicit_cancel"),
    )
    expect(gateway.speech.map(({ sequence }) => sequence)).toEqual([0])
    expect(controller.getSnapshot().presentation?.speechStatus).toBe(
      "unavailable",
    )
  })

  it("cancels the released speech chain after runtime becomes unavailable", async () => {
    const { controller, gateway } = await ready(true)
    const key = prepare(controller)
    let runtimeCalls = 0
    vi.spyOn(gateway, "getRuntime").mockImplementation(() => {
      runtimeCalls++
      return Promise.resolve({
        schemaVersion: narrationSchemaVersion,
        playbackState: runtimeCalls === 1 ? "unavailable" : "idle",
        activeRequestId: null,
        queueDepth: 0,
        lastErrorCode: runtimeCalls === 1 ? "NARRATION-SAY-EXIT" : null,
      })
    })

    await controller.activatePresentation(key)
    expect(acknowledge(controller, key, 0)).toBe(true)
    expect(acknowledge(controller, key, 1)).toBe(true)

    await vi.waitFor(() =>
      expect(gateway.cancelReasons).toContain("explicit_cancel"),
    )
    expect(gateway.speech.map(({ sequence }) => sequence)).toEqual([0])
    expect(controller.getSnapshot().presentation).toMatchObject({
      speechStatus: "unavailable",
      errorCode: "NARRATION-SAY-EXIT",
    })
  })

  it("awaits native cancellation before terminalizing a playback watchdog", async () => {
    const { controller, gateway } = await ready(true)
    const key = prepare(controller, ["説明です。"])
    const statesAtCancel: string[] = []
    gateway.setRuntime({
      playbackState: "playing",
      activeRequestId: "present-support-1",
      queueDepth: 1,
      lastErrorCode: null,
    })
    gateway.onCancel = () => {
      statesAtCancel.push(
        controller.getSnapshot().presentation?.speechStatus ?? "missing",
      )
    }

    await controller.activatePresentation(key)
    expect(acknowledge(controller, key, 0)).toBe(true)

    await vi.waitFor(() =>
      expect(controller.getSnapshot().presentation).toMatchObject({
        speechStatus: "unavailable",
        errorCode: "NARRATION-PLAYBACK-TIMEOUT",
      }),
    )
    expect(gateway.cancelReasons).toContain("explicit_cancel")
    expect(statesAtCancel).toEqual(["playing"])
  })

  it("dismisses a different selection without canceling its prepared cache", async () => {
    const { controller, gateway } = await ready(true)
    const key = prepare(controller, ["説明です。"])
    await controller.activatePresentation(key)
    const missing = { ...key, commitSha: shaB, requestId: "support-2" }

    await expect(controller.activatePresentation(missing)).resolves.toBe(false)
    expect(controller.getSnapshot().presentation).toBeNull()
    expect(gateway.cancelReasons).toContain("explicit_cancel")
    expect(
      controller.consume(
        event("chunk", { sequence: 1, text: "キャンセル後の後着です。" }),
      ),
    ).toBe(true)
    await expect(controller.activatePresentation(key)).resolves.toBe(true)
    expect(controller.getSnapshot().presentation).toMatchObject({
      status: "streaming",
      chunks: ["説明です。", "キャンセル後の後着です。"],
    })
  })

  it("terminalizes support cancellation and rejects late chunks or replay", async () => {
    const { controller, gateway } = await ready(true)
    const key = prepare(controller, ["説明です。"])
    await controller.activatePresentation(key)

    await controller.cancelPresentation()

    expect(controller.getSnapshot().presentation).toMatchObject({
      status: "canceled",
      errorCode: "NARRATION-PRESENTATION-CANCELED",
    })
    expect(gateway.cancelReasons).toContain("explicit_cancel")
    expect(
      controller.consume(
        event("chunk", { sequence: 1, text: "cancel後の後着です。" }),
      ),
    ).toBe(false)
    await expect(controller.activatePresentation(key)).resolves.toBe(false)
    expect(controller.getSnapshot().presentation?.status).toBe("canceled")
  })

  it("drops stale generation chunks and refuses scope rollback", async () => {
    const { controller } = await ready(true)
    const oldKey = prepare(controller, ["古い説明です。"])
    await controller.setScope({ workspaceId: "workspace-1", generation: 4 })

    expect(
      controller.consume(event("chunk", { sequence: 1, text: "後着です。" })),
    ).toBe(false)
    await expect(controller.activatePresentation(oldKey)).resolves.toBe(false)
    expect(controller.getSnapshot().scope).toEqual({
      workspaceId: "workspace-1",
      generation: 4,
    })
  })

  it("rejects same-workspace rollback before transport, including a pending generation", async () => {
    const { controller, gateway } = await ready(true)
    await expect(
      controller.setScope({ workspaceId: "workspace-1", generation: 4 }),
    ).resolves.toBe(true)
    const callsBeforeRollback = gateway.scopes.length

    await expect(
      controller.setScope({ workspaceId: "workspace-1", generation: 3 }),
    ).resolves.toBe(false)
    expect(gateway.scopes).toHaveLength(callsBeforeRollback)
    expect(controller.getSnapshot()).toMatchObject({
      scope: { workspaceId: "workspace-1", generation: 4 },
      lastErrorCode: "NARRATION-SCOPE-ROLLBACK",
    })

    let releasePending!: () => void
    vi.spyOn(gateway, "setScope").mockImplementationOnce((request) => {
      gateway.scopes.push(request)
      return new Promise<void>((resolve) => {
        releasePending = resolve
      })
    })
    const pending = controller.setScope({
      workspaceId: "workspace-1",
      generation: 6,
    })
    await Promise.resolve()

    await expect(
      controller.setScope({ workspaceId: "workspace-1", generation: 5 }),
    ).resolves.toBe(false)
    expect(gateway.scopes.at(-1)?.generation).toBe(6)
    releasePending()
    await expect(pending).resolves.toBe(true)
  })

  it("terminalizes an active stream on a sequence gap and cancels speech", async () => {
    const { controller, gateway } = await ready(true)
    const key = prepare(controller, ["最初です。"])
    await controller.activatePresentation(key)

    expect(
      controller.consume(event("chunk", { sequence: 2, text: "欠落後です。" })),
    ).toBe(false)
    expect(controller.getSnapshot().presentation).toMatchObject({
      status: "unavailable",
      errorCode: "NARRATION-PRESENTATION-SEQUENCE",
    })
    await vi.waitFor(() =>
      expect(gateway.cancelReasons).toContain("explicit_cancel"),
    )
  })

  it("does not recover an unsafe active stream from later valid chunks", async () => {
    const { controller } = await ready(true)
    const key = prepare(controller, ["最初です。"])
    await controller.activatePresentation(key)

    expect(controller.consume({ privateText: "untrusted" })).toBe(false)
    expect(controller.getSnapshot().presentation?.status).toBe("unavailable")
    expect(
      controller.consume(event("chunk", { sequence: 1, text: "後着です。" })),
    ).toBe(false)
    expect(controller.getSnapshot().presentation).toMatchObject({
      status: "unavailable",
      chunks: ["最初です。"],
    })
  })

  it("waits for an exact visible test caption and the speech lead", async () => {
    const gateway = new FakeNarrationGateway(true)
    const pendingPauses: Array<{
      readonly milliseconds: number
      readonly resolve: () => void
    }> = []
    const controller = new NarrationController(
      gateway,
      (milliseconds) =>
        new Promise<void>((resolve) => {
          pendingPauses.push({ milliseconds, resolve })
        }),
    )
    await controller.initialize()

    const playback = controller.playTest(
      { workspaceId: "workspace-1", generation: 3 },
      "ja",
      "字幕が先に表示されます。",
    )
    await vi.waitFor(() =>
      expect(controller.getSnapshot().test.status).toBe("preparing"),
    )
    expect(gateway.speech).toHaveLength(0)
    const testGeneration = controller.getSnapshot().test.generation
    expect(
      controller.acknowledgeTestCaptionVisible({
        testGeneration: testGeneration + 1,
      }),
    ).toBe(false)
    expect(controller.acknowledgeTestCaptionVisible({ testGeneration })).toBe(
      true,
    )
    await Promise.resolve()
    expect(pendingPauses.map(({ milliseconds }) => milliseconds)).toEqual([100])
    expect(gateway.speech).toHaveLength(0)

    pendingPauses[0]?.resolve()
    await expect(playback).resolves.toBe(true)
    expect(gateway.speech).toHaveLength(1)
    expect(controller.getSnapshot().test.status).toBe("idle")
  })

  it("fails closed when the test caption never becomes visible", async () => {
    vi.useFakeTimers()
    try {
      const gateway = new FakeNarrationGateway(true)
      const controller = new NarrationController(gateway)
      await controller.initialize()
      const playback = controller.playTest(
        { workspaceId: "workspace-1", generation: 3 },
        "ja",
        "非表示の字幕です。",
      )
      await vi.advanceTimersByTimeAsync(0)
      expect(controller.getSnapshot().test.status).toBe("preparing")

      await vi.advanceTimersByTimeAsync(1_000)

      await expect(playback).resolves.toBe(false)
      expect(gateway.speech).toHaveLength(0)
      expect(controller.getSnapshot().test).toMatchObject({
        status: "unavailable",
        errorCode: "NARRATION-TEST-CAPTION-NOT-VISIBLE",
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it("cancels test playback at the dedicated five-second watchdog", async () => {
    vi.useFakeTimers()
    try {
      const gateway = new FakeNarrationGateway(true)
      gateway.setRuntime({
        playbackState: "playing",
        activeRequestId: "narration-test-1",
        queueDepth: 1,
      })
      const controller = new NarrationController(gateway)
      await controller.initialize()
      const playback = controller.playTest(
        { workspaceId: "workspace-1", generation: 3 },
        "ja",
        "5秒で停止します。",
      )
      await vi.advanceTimersByTimeAsync(0)
      expect(controller.getSnapshot().test.status).toBe("preparing")
      expect(
        controller.acknowledgeTestCaptionVisible({
          testGeneration: controller.getSnapshot().test.generation,
        }),
      ).toBe(true)

      await vi.advanceTimersByTimeAsync(100)
      expect(gateway.speech).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(4_999)
      expect(gateway.cancelReasons).not.toContain("explicit_cancel")
      await vi.advanceTimersByTimeAsync(1)

      await expect(playback).resolves.toBe(false)
      expect(gateway.cancelReasons).toContain("explicit_cancel")
      expect(controller.getSnapshot().test).toMatchObject({
        status: "unavailable",
        errorCode: "NARRATION-PLAYBACK-TIMEOUT",
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it("validates settings before crossing the gateway", async () => {
    const { controller, gateway } = await ready(false)
    const updateSpy = vi.spyOn(gateway, "updateSettings")

    await expect(
      controller.saveSettings({
        enabled: true,
        muted: false,
        provider: null,
        apiKeyAction: { kind: "keep" },
        model: "gpt-4o-mini-tts",
        voice: "marin",
        speed: 1.12,
      }),
    ).resolves.toBe(false)
    expect(updateSpy).not.toHaveBeenCalled()
    expect(controller.getSnapshot()).toMatchObject({
      settingsStatus: "error",
      lastErrorCode: "NARRATION-CONTRACT-INVALID",
    })
  })
})
