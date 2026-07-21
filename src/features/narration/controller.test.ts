import { describe, expect, it, vi } from "vitest"

import {
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
  narrationSchemaVersion,
  narrationSettingsSchemaVersion,
  type PresenceDirectionConsumerPort,
  type PresenceDirectionEventV1,
  sourceKeyFromCommitNarrationEvent,
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

function presenceEvent(
  overrides: Partial<PresenceDirectionEventV1> = {},
): PresenceDirectionEventV1 {
  const trigger = overrides.trigger ?? "decision_wait"
  return {
    schemaVersion: narrationSchemaVersion,
    requestId: "presence-1",
    workspaceId: "workspace-1",
    workspaceGeneration: 3,
    sourceEventId: "source-event-1",
    decisionId: trigger === "decision_wait" ? "pending-1" : null,
    trigger,
    locale: "ja",
    utterance: "確認が必要なところで待っています。",
    cue: "asking",
    priority: "high",
    modelRole: "presence_director",
    model: "gpt-5.6-luna",
    occurredAt: "2026-07-21T10:00:00.000Z",
    ...overrides,
  }
}

class FakeNarrationGateway implements NarrationGateway {
  public readonly kind = "demo" as const
  public readonly scopes: NarrationScopeRequestV1[] = []
  public readonly speech: NarrationSpeakRequestV1[] = []
  public readonly cancelReasons: NarrationCancelReason[] = []
  public onSpeak: ((request: NarrationSpeakRequestV1) => void) | null = null
  public onCancel:
    | ((reason: NarrationCancelReason) => void | Promise<void>)
    | null = null
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
    return Promise.resolve(this.onCancel?.(reason))
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
  it("synchronizes Luna scope without coupling its failure to the main scope", async () => {
    const { controller, gateway } = await ready(true)
    const setScope = vi.fn<
      NonNullable<PresenceDirectionConsumerPort["setScope"]>
    >(() => Promise.reject(new Error("optional Luna scope unavailable")))
    controller.connectPresence({
      subscribe: () => () => undefined,
      setScope,
    })

    await expect(
      controller.setScope({
        workspaceId: "workspace-1",
        generation: 3,
        locale: "ja",
      }),
    ).resolves.toBe(true)
    await Promise.resolve()

    expect(gateway.scopes).toHaveLength(1)
    expect(setScope).toHaveBeenCalledWith({
      schemaVersion: narrationSchemaVersion,
      workspaceId: "workspace-1",
      workspaceGeneration: 3,
      locale: "ja",
    })
    expect(controller.getSnapshot().lastErrorCode).toBeNull()
  })

  it("replays the current Luna scope when its native source connects late", async () => {
    const { controller } = await ready(true)
    await controller.setScope({
      workspaceId: "workspace-1",
      generation: 3,
      locale: "en",
    })
    const setScope = vi.fn<
      NonNullable<PresenceDirectionConsumerPort["setScope"]>
    >(() => Promise.resolve())

    controller.connectPresence({
      subscribe: () => () => undefined,
      setScope,
    })

    expect(setScope).toHaveBeenCalledWith({
      schemaVersion: narrationSchemaVersion,
      workspaceId: "workspace-1",
      workspaceGeneration: 3,
      locale: "en",
    })
  })

  it("keeps the latest locale intent when an older dismissal resolves late", async () => {
    const { controller, gateway } = await ready(true)
    await controller.setScope({
      workspaceId: "workspace-1",
      generation: 3,
      locale: "ja",
    })
    expect(controller.consumePresence(presenceEvent())).toBe(true)

    let releaseCancellation!: () => void
    vi.spyOn(gateway, "cancel").mockImplementationOnce((reason) => {
      gateway.cancelReasons.push(reason)
      return new Promise<void>((resolve) => {
        releaseCancellation = resolve
      })
    })

    const older = controller.setScope({
      workspaceId: "workspace-1",
      generation: 3,
      locale: "en",
    })
    await vi.waitFor(() =>
      expect(gateway.cancelReasons).toContain("workspace_switch"),
    )
    const latest = controller.setScope({
      workspaceId: "workspace-1",
      generation: 3,
      locale: "ja",
    })

    releaseCancellation()
    await expect(older).resolves.toBe(false)
    await expect(latest).resolves.toBe(true)
    expect(controller.getSnapshot().scope).toEqual({
      workspaceId: "workspace-1",
      generation: 3,
      locale: "ja",
    })
  })

  it("serializes Luna scope writes and coalesces to the latest desired scope", async () => {
    const { controller } = await ready(true)
    await controller.setScope({
      workspaceId: "workspace-1",
      generation: 3,
      locale: "ja",
    })

    let releaseInitial!: () => void
    const setScope =
      vi.fn<NonNullable<PresenceDirectionConsumerPort["setScope"]>>()
    setScope.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseInitial = resolve
        }),
    )
    setScope.mockResolvedValue(undefined)
    controller.connectPresence({
      subscribe: () => () => undefined,
      setScope,
    })
    expect(setScope).toHaveBeenCalledTimes(1)

    await expect(
      controller.setScope({
        workspaceId: "workspace-1",
        generation: 4,
        locale: "en",
      }),
    ).resolves.toBe(true)
    await expect(
      controller.setScope({
        workspaceId: "workspace-1",
        generation: 5,
        locale: "ja",
      }),
    ).resolves.toBe(true)
    expect(setScope).toHaveBeenCalledTimes(1)

    releaseInitial()
    await vi.waitFor(() => expect(setScope).toHaveBeenCalledTimes(2))
    expect(setScope.mock.calls[1]?.[0]).toEqual({
      schemaVersion: narrationSchemaVersion,
      workspaceId: "workspace-1",
      workspaceGeneration: 5,
      locale: "ja",
    })
  })

  it("releases a visible Luna caption to byte-identical event speech after its lead", async () => {
    const leads: Array<() => void> = []
    const pauseDurations: number[] = []
    const gateway = new FakeNarrationGateway(true)
    const controller = new NarrationController(gateway, (milliseconds) => {
      pauseDurations.push(milliseconds)
      return new Promise<void>((resolve) => leads.push(resolve))
    })
    await controller.initialize()
    await controller.setScope({
      workspaceId: "workspace-1",
      generation: 3,
      locale: "ja",
    })

    expect(controller.consumePresence(presenceEvent())).toBe(true)
    const presence = controller.getSnapshot().presence
    expect(presence).toMatchObject({
      requestId: "presence-1",
      cue: "asking",
      speechStatus: "queued",
    })
    expect(gateway.speech).toHaveLength(0)
    expect(
      controller.acknowledgePresenceCaptionVisible({
        requestId: "other-request",
        presentationGeneration: presence?.presentationGeneration ?? 0,
      }),
    ).toBe(false)
    expect(
      controller.acknowledgePresenceCaptionVisible({
        requestId: "presence-1",
        presentationGeneration: presence?.presentationGeneration ?? 0,
      }),
    ).toBe(true)
    expect(pauseDurations).toEqual([100])
    expect(gateway.speech).toHaveLength(0)

    leads[0]?.()
    await vi.waitFor(() => expect(gateway.speech).toHaveLength(1))
    expect(gateway.speech[0]).toMatchObject({
      workspaceId: "workspace-1",
      generation: 3,
      sequence: 0,
      locale: "ja",
      kind: "event",
      semanticType: "waiting_for_user",
      priority: "high",
      text: "確認が必要なところで待っています。",
    })
  })

  it("maps each Luna trigger to deterministic narration semantics", async () => {
    const cases = [
      ["decision_wait", "asking", "waiting_for_user", "high"],
      ["recoverable_failure", "warning", "error", "high"],
      ["terminal_failure", "error", "error", "high"],
      ["long_milestone", "working", "progress", "low"],
      ["main_message", "working", "progress", "normal"],
      ["commit_ready", "success", "commit_observed", "normal"],
      ["turn_completed", "success", "progress", "normal"],
    ] as const

    for (const [trigger, cue, semanticType, priority] of cases) {
      const { controller, gateway } = await ready(true)
      await controller.setScope({
        workspaceId: "workspace-1",
        generation: 3,
        locale: "ja",
      })
      expect(
        controller.consumePresence(
          presenceEvent({
            requestId: `presence-${trigger}`,
            sourceEventId: `source-${trigger}`,
            trigger,
            cue,
            priority,
          }),
        ),
      ).toBe(true)
      const presence = controller.getSnapshot().presence
      expect(
        controller.acknowledgePresenceCaptionVisible({
          requestId: `presence-${trigger}`,
          presentationGeneration: presence?.presentationGeneration ?? 0,
        }),
      ).toBe(true)
      await vi.waitFor(() => expect(gateway.speech).toHaveLength(1))
      expect(gateway.speech[0]).toMatchObject({
        semanticType,
        priority,
        text: "確認が必要なところで待っています。",
      })
    }
  })

  it("ranks main messages below failures and above commit and completion captions", async () => {
    const { controller } = await ready(true)
    await controller.setScope({
      workspaceId: "workspace-1",
      generation: 3,
      locale: "ja",
    })

    expect(
      controller.consumePresence(
        presenceEvent({
          requestId: "main-message",
          sourceEventId: "main-message-source",
          trigger: "main_message",
          cue: "working",
          priority: "normal",
        }),
      ),
    ).toBe(true)
    expect(
      controller.consumePresence(
        presenceEvent({
          requestId: "commit-ready",
          sourceEventId: "commit-ready-source",
          trigger: "commit_ready",
          cue: "success",
          priority: "normal",
        }),
      ),
    ).toBe(false)
    expect(
      controller.consumePresence(
        presenceEvent({
          requestId: "turn-completed",
          sourceEventId: "turn-completed-source",
          trigger: "turn_completed",
          cue: "success",
          priority: "normal",
        }),
      ),
    ).toBe(false)
    expect(controller.getSnapshot().presence?.requestId).toBe("main-message")

    expect(
      controller.consumePresence(
        presenceEvent({
          requestId: "recoverable-failure",
          sourceEventId: "recoverable-failure-source",
          trigger: "recoverable_failure",
          cue: "warning",
          priority: "high",
        }),
      ),
    ).toBe(true)
    expect(controller.getSnapshot().presence?.requestId).toBe(
      "recoverable-failure",
    )
  })

  it("dismisses a resolved decision before accepting and speaking the next main message", async () => {
    const { controller, gateway } = await ready(true)
    let releaseCancel: (() => void) | undefined
    gateway.onCancel = () =>
      new Promise<void>((resolve) => {
        releaseCancel = resolve
      })
    await controller.setScope({
      workspaceId: "workspace-1",
      generation: 3,
      locale: "ja",
    })

    const decision = presenceEvent()
    expect(controller.consumePresence(decision)).toBe(true)
    expect(controller.getSnapshot().presence?.speechStatus).toBe("queued")

    expect(
      controller.consumePendingRequestResolved({
        workspaceId: "workspace-1",
        workspaceGeneration: 3,
        pendingId: "pending-1",
      }),
    ).toBe(true)
    expect(controller.getSnapshot().presence).toBeNull()
    await vi.waitFor(() => expect(gateway.cancelReasons).toHaveLength(1))

    const mainMessage = presenceEvent({
      requestId: "main-message-after-decision",
      sourceEventId: "main-message-after-decision-source",
      trigger: "main_message",
      cue: "working",
      priority: "normal",
      utterance: "次の作業へ進みます。",
    })
    expect(controller.consumePresence(mainMessage)).toBe(true)
    const mainPresence = controller.getSnapshot().presence
    expect(mainPresence).toMatchObject({
      requestId: mainMessage.requestId,
      decisionId: null,
      trigger: "main_message",
      cue: "working",
    })
    expect(
      controller.acknowledgePresenceCaptionVisible({
        requestId: mainMessage.requestId,
        presentationGeneration: mainPresence?.presentationGeneration ?? 0,
      }),
    ).toBe(true)
    await Promise.resolve()
    expect(gateway.speech).toHaveLength(0)

    releaseCancel?.()
    await vi.waitFor(() => expect(gateway.speech).toHaveLength(1))
    expect(gateway.speech[0]).toMatchObject({
      semanticType: "progress",
      text: mainMessage.utterance,
    })
  })

  it("lets a terminalized failure caption yield to the next valid event", async () => {
    const { controller } = await ready(false)
    await controller.setScope({
      workspaceId: "workspace-1",
      generation: 3,
      locale: "ja",
    })
    expect(
      controller.consumePresence(
        presenceEvent({
          requestId: "failure",
          sourceEventId: "failure-source",
          trigger: "recoverable_failure",
          cue: "warning",
          priority: "high",
        }),
      ),
    ).toBe(true)
    expect(controller.getSnapshot().presence?.speechStatus).toBe("off")
    expect(
      controller.consumePresence(
        presenceEvent({
          requestId: "main-after-failure",
          sourceEventId: "main-after-failure-source",
          trigger: "main_message",
          cue: "working",
          priority: "normal",
        }),
      ),
    ).toBe(true)
    expect(controller.getSnapshot().presence?.requestId).toBe(
      "main-after-failure",
    )
  })

  it("drops privacy-invalid Luna text before caption state or TTS", async () => {
    const { controller, gateway } = await ready(true)
    await controller.setScope({
      workspaceId: "workspace-1",
      generation: 3,
      locale: "ja",
    })

    for (const [index, utterance] of [
      "空白が  二つあります。",
      "```ts const ready = true; ```",
      "diff --git old new",
      "@@ -1 +1 @@",
      "+return true;",
      "-return false;",
      "fn main(){}",
      "README.md を確認しました。",
      "secret-config.yaml is ready.",
      "private.pem secret.key Dockerfile Makefile",
      "console.log('secret') <div>secret</div>",
    ].entries()) {
      expect(
        controller.consumePresence(
          presenceEvent({
            requestId: `privacy-invalid-${index}`,
            sourceEventId: `privacy-invalid-source-${index}`,
            utterance,
          }),
        ),
      ).toBe(false)
    }

    expect(controller.getSnapshot().presence).toBeNull()
    expect(gateway.speech).toHaveLength(0)
  })

  it("rejects stale, duplicate, locale-mismatched, and lower-priority Luna captions", async () => {
    const { controller } = await ready(true)
    await controller.setScope({
      workspaceId: "workspace-1",
      generation: 3,
      locale: "ja",
    })

    expect(
      controller.consumePresence(
        presenceEvent({ workspaceGeneration: 2, requestId: "stale" }),
      ),
    ).toBe(false)
    expect(
      controller.consumePresence(
        presenceEvent({ locale: "en", requestId: "wrong-locale" }),
      ),
    ).toBe(false)
    expect(controller.getSnapshot().presence).toBeNull()

    expect(controller.consumePresence(presenceEvent())).toBe(true)
    expect(controller.consumePresence(presenceEvent())).toBe(false)
    expect(
      controller.consumePresence(
        presenceEvent({
          requestId: "milestone-2",
          sourceEventId: "milestone-source-2",
          trigger: "long_milestone",
          cue: "working",
          priority: "low",
        }),
      ),
    ).toBe(false)
    expect(controller.getSnapshot().presence?.requestId).toBe("presence-1")
  })

  it("gives explicit commit presentation priority over Luna caption and cue", async () => {
    const { controller, gateway } = await ready(true)
    await controller.setScope({
      workspaceId: "workspace-1",
      generation: 3,
      locale: "ja",
    })
    expect(controller.consumePresence(presenceEvent())).toBe(true)
    const key = prepare(controller, ["明示的なコミット説明です。"])

    await expect(controller.activatePresentation(key)).resolves.toBe(true)
    expect(controller.getSnapshot().presence).toBeNull()
    expect(controller.getSnapshot().presentation).not.toBeNull()
    expect(
      controller.consumePresence(
        presenceEvent({ requestId: "presence-2", sourceEventId: "source-2" }),
      ),
    ).toBe(false)
    expect(gateway.speech).toHaveLength(0)
  })

  it("allows Luna intake, acknowledgment, and speech after Terra is canceled", async () => {
    const { controller, gateway } = await ready(true)
    await controller.setScope({
      workspaceId: "workspace-1",
      generation: 3,
      locale: "ja",
    })
    const key = prepare(controller, ["取り消す説明です。"])
    await controller.activatePresentation(key)
    await controller.cancelPresentation()
    expect(controller.getSnapshot().presentation?.status).toBe("canceled")

    const eventAfterCancel = presenceEvent({
      requestId: "presence-after-cancel",
      sourceEventId: "source-after-cancel",
    })
    expect(controller.consumePresence(eventAfterCancel)).toBe(true)
    const activePresence = controller.getSnapshot().presence
    expect(
      controller.acknowledgePresenceCaptionVisible({
        requestId: eventAfterCancel.requestId,
        presentationGeneration: activePresence?.presentationGeneration ?? 0,
      }),
    ).toBe(true)
    await vi.waitFor(() => expect(gateway.speech).toHaveLength(1))
    expect(gateway.speech[0]?.text).toBe(eventAfterCancel.utterance)
  })

  it("keeps an existing Luna caption active when Terra activation is unavailable", async () => {
    const { controller, gateway } = await ready(true)
    await controller.setScope({
      workspaceId: "workspace-1",
      generation: 3,
      locale: "ja",
    })
    const failedStart = event("started", { requestId: "failed-support" })
    expect(controller.consume(failedStart)).toBe(true)
    expect(
      controller.consume(
        event("terminal", { requestId: "failed-support", status: "completed" }),
      ),
    ).toBe(true)
    const failedKey = sourceKeyFromCommitNarrationEvent(failedStart)
    const existingPresence = presenceEvent({
      requestId: "presence-before-failure",
      sourceEventId: "source-before-failure",
    })
    expect(controller.consumePresence(existingPresence)).toBe(true)

    await expect(controller.activatePresentation(failedKey)).resolves.toBe(true)
    expect(controller.getSnapshot()).toMatchObject({
      presentation: {
        status: "unavailable",
        errorCode: "NARRATION-PRESENTATION-EMPTY",
      },
      presence: { requestId: existingPresence.requestId },
    })
    const activePresence = controller.getSnapshot().presence
    expect(
      controller.acknowledgePresenceCaptionVisible({
        requestId: existingPresence.requestId,
        presentationGeneration: activePresence?.presentationGeneration ?? 0,
      }),
    ).toBe(true)
    await vi.waitFor(() => expect(gateway.speech).toHaveLength(1))
    expect(gateway.speech[0]?.text).toBe(existingPresence.utterance)
  })

  it("keeps a timed-out or muted Luna caption without replaying speech", async () => {
    vi.useFakeTimers()
    try {
      const gateway = new FakeNarrationGateway(true)
      const controller = new NarrationController(gateway)
      await controller.initialize()
      await controller.setScope({
        workspaceId: "workspace-1",
        generation: 3,
        locale: "ja",
      })
      expect(controller.consumePresence(presenceEvent())).toBe(true)

      await vi.advanceTimersByTimeAsync(1_000)
      expect(controller.getSnapshot().presence).toMatchObject({
        requestId: "presence-1",
        speechStatus: "unavailable",
        errorCode: "NARRATION-CAPTION-NOT-VISIBLE",
      })
      expect(gateway.speech).toHaveLength(0)

      expect(
        controller.consumePresence(
          presenceEvent({
            requestId: "presence-2",
            sourceEventId: "source-2",
          }),
        ),
      ).toBe(true)
      await controller.setMuted(true)
      expect(controller.getSnapshot().presence).toMatchObject({
        requestId: "presence-2",
        speechStatus: "muted",
      })
      await controller.setMuted(false)
      await vi.advanceTimersByTimeAsync(2_000)
      expect(gateway.speech).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

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

  it("cancels test playback at the dedicated fifty-second watchdog", async () => {
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
        "50秒で停止します。",
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
      await vi.advanceTimersByTimeAsync(49_999)
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
