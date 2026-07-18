import { describe, expect, it, vi } from "vitest"

import {
  narrationSchemaVersion,
  sourceKeyFromCommitNarrationEvent,
  type CommitNarrationConsumerEventV1,
  type NarrationCancelReason,
  type NarrationMuteRequestV1,
  type NarrationRuntimeSnapshotV1,
  type NarrationScopeRequestV1,
  type NarrationSettingsSnapshotV1,
  type NarrationSettingsUpdateV1,
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
      schemaVersion: narrationSchemaVersion,
      version: 0,
      enabled,
      muted: false,
      voices: { ja: "Kyoko", en: "Samantha" },
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
  }
}

class FakeNarrationGateway implements NarrationGateway {
  public readonly kind = "demo" as const
  public readonly scopes: NarrationScopeRequestV1[] = []
  public readonly speech: NarrationSpeakRequestV1[] = []
  public readonly cancelReasons: NarrationCancelReason[] = []
  public onSpeak: ((request: NarrationSpeakRequestV1) => void) | null = null
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

  public listVoices(): Promise<NarrationVoiceListV1> {
    return Promise.resolve({
      schemaVersion: narrationSchemaVersion,
      voices: [
        { name: "Kyoko", locale: "ja_JP" },
        { name: "Samantha", locale: "en_US" },
      ],
    })
  }

  public updateSettings(
    request: NarrationSettingsUpdateV1,
  ): Promise<NarrationSettingsSnapshotV1> {
    this.#snapshot = {
      ...this.#snapshot,
      settings: {
        schemaVersion: narrationSchemaVersion,
        version: request.expectedVersion + 1,
        enabled: request.enabled,
        muted: request.muted,
        voices: request.voices,
        rate: request.rate,
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

describe("NarrationController", () => {
  it("buffers automatic generation without exposing caption or speech", async () => {
    const { controller, gateway } = await ready(true)
    prepare(controller)
    controller.consume(event("terminal"))

    expect(controller.getSnapshot().presentation).toBeNull()
    expect(gateway.speech).toHaveLength(0)
  })

  it("publishes accepted chunks before optional speech and replays in exact order", async () => {
    const { controller, gateway } = await ready(true)
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
    await vi.waitFor(() => expect(gateway.speech).toHaveLength(2))
    expect(
      gateway.speech.map(({ sequence, text }) => ({ sequence, text })),
    ).toEqual([
      { sequence: 0, text: "最初の説明です。" },
      { sequence: 1, text: "次の説明です。" },
    ])
    expect(order.indexOf("caption:2")).toBeLessThan(order.indexOf("speech"))
  })

  it("streams later chunks only after explicit activation", async () => {
    const { controller, gateway } = await ready(true)
    const key = prepare(controller, ["受理済みです。"])
    await controller.activatePresentation(key)
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
    await vi.waitFor(() => expect(gateway.speech).toHaveLength(2))
    expect(gateway.speech.at(-1)?.text).toBe("解除後です。")
    expect(gateway.cancelReasons).toContain("mute")
  })

  it("cancels old presentation for a different or unavailable commit", async () => {
    const { controller, gateway } = await ready(true)
    const key = prepare(controller, ["説明です。"])
    await controller.activatePresentation(key)
    const missing = { ...key, commitSha: shaB, requestId: "support-2" }

    await expect(controller.activatePresentation(missing)).resolves.toBe(false)
    expect(controller.getSnapshot().presentation).toMatchObject({
      status: "canceled",
    })
    expect(gateway.cancelReasons).toContain("explicit_cancel")
    expect(
      controller.consume(
        event("chunk", { sequence: 1, text: "キャンセル後の後着です。" }),
      ),
    ).toBe(false)
    expect(controller.getSnapshot().presentation).toMatchObject({
      status: "canceled",
      chunks: ["説明です。"],
    })
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

  it("validates settings before crossing the gateway", async () => {
    const { controller, gateway } = await ready(false)
    const updateSpy = vi.spyOn(gateway, "updateSettings")

    await expect(
      controller.saveSettings({
        enabled: true,
        muted: false,
        voices: { ja: null, en: null },
        rate: 1.12,
      }),
    ).resolves.toBe(false)
    expect(updateSpy).not.toHaveBeenCalled()
    expect(controller.getSnapshot()).toMatchObject({
      settingsStatus: "error",
      lastErrorCode: "NARRATION-CONTRACT-INVALID",
    })
  })
})
