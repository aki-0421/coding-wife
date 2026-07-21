import { describe, expect, it } from "vitest"
import {
  type CommitNarrationSourceKey,
  commitNarrationSourceKey,
  NarrationContractError,
  narrationMaxTextScalars,
  narrationSchemaVersion,
  narrationSettingsSchemaVersion,
  parseCommitNarrationConsumerEvent,
  parseNarrationSettingsSnapshot,
  parseNarrationSpeakResponse,
  parseNarrationVoiceList,
  parsePresenceDirectionEvent,
  sourceKeyFromCommitNarrationEvent,
} from "@/features/narration/contracts"
import redactionFixture from "@/test/fixtures/narration-redaction.v1.json"

const sha = "a".repeat(40)

const settingsSnapshot = {
  schemaVersion: narrationSchemaVersion,
  settings: {
    schemaVersion: narrationSettingsSchemaVersion,
    version: 4,
    enabled: true,
    muted: false,
    provider: "openai",
    apiKeyConfigured: true,
    model: "gpt-4o-mini-tts",
    voice: "marin",
    speed: 1.15,
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

function started(trigger = "auto_verified_commit") {
  return {
    schemaVersion: narrationSchemaVersion,
    source: "background_support",
    trigger,
    kind: "started",
    workspaceId: "workspace-1",
    workspaceGeneration: 7,
    commitSha: sha,
    requestId: "support-request-1",
    locale: "ja",
  }
}

function presenceDirection(overrides: Readonly<Record<string, unknown>> = {}) {
  const trigger = overrides.trigger ?? "decision_wait"
  return {
    schemaVersion: narrationSchemaVersion,
    requestId: "presence-request-1",
    workspaceId: "workspace-1",
    workspaceGeneration: 7,
    sourceEventId: "event-42",
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

describe("narration contracts", () => {
  it("accepts strict native snapshots, installed voices, and dispositions", () => {
    expect(parseNarrationSettingsSnapshot(settingsSnapshot)).toEqual(
      settingsSnapshot,
    )
    expect(
      parseNarrationVoiceList({
        schemaVersion: narrationSchemaVersion,
        voices: [
          { name: "marin", locale: "ja_JP" },
          { name: "cedar", locale: "en_US" },
        ],
      }).voices,
    ).toHaveLength(2)
    expect(
      parseNarrationSpeakResponse({
        schemaVersion: narrationSchemaVersion,
        disposition: "queued",
        queueDepth: 1,
        code: null,
      }),
    ).toMatchObject({ disposition: "queued", queueDepth: 1 })
  })

  it("accepts every canonical background trigger and exact sequence data", () => {
    for (const trigger of [
      "auto_verified_commit",
      "user_request",
      "user_retry",
    ]) {
      expect(parseCommitNarrationConsumerEvent(started(trigger))).toMatchObject(
        {
          source: "background_support",
          trigger,
        },
      )
    }
    expect(
      parseCommitNarrationConsumerEvent({
        ...started(),
        kind: "chunk",
        sequence: 0,
        text: "検証済みの変更を説明します。",
      }),
    ).toMatchObject({ kind: "chunk", sequence: 0 })
  })

  it("accepts exact Luna presence events and trigger-specific semantic cues", () => {
    const cases = [
      ["decision_wait", "asking", "high"],
      ["recoverable_failure", "warning", "high"],
      ["terminal_failure", "error", "high"],
      ["long_milestone", "working", "low"],
      ["main_message", "working", "normal"],
      ["commit_ready", "success", "normal"],
      ["turn_completed", "neutral", "normal"],
    ] as const

    for (const [trigger, cue, priority] of cases) {
      expect(
        parsePresenceDirectionEvent(
          presenceDirection({ trigger, cue, priority }),
        ),
      ).toMatchObject({ trigger, cue, priority, model: "gpt-5.6-luna" })
    }
  })

  it("accepts ordinary Japanese and English Luna reactions", () => {
    for (const [locale, utterance] of [
      ["ja", "実装の要点がきれいにまとまりましたね。"],
      ["en", "That is a clear step forward."],
    ] as const) {
      expect(
        parsePresenceDirectionEvent(presenceDirection({ locale, utterance })),
      ).toMatchObject({ locale, utterance })
    }
  })

  it("rejects non-canonical, code, diff, and file-like Luna utterances", () => {
    const unsafeUtterances = [
      "空白が  二つあります。",
      "This contains\u00a0a non-breaking space.",
      "```ts const ready = true; ```",
      "diff --git old new",
      "@@ -1 +1 @@",
      "--- previous +++ current",
      "+return true;",
      "-return false;",
      "fn main(){}",
      "const ready = true;",
      'console.log("ready");',
      "<main>Ready</main>",
      "README.md を確認しました。",
      "secrets.txt を確認しました。",
      ".config を確認しました。",
      "foo/bar を確認しました。",
      "foo\\bar を確認しました。",
      "処理済み [ReDaCtEd] です。",
      "secret-config.yaml is ready.",
      "private.pem secret.key Dockerfile Makefile",
      "diff --git old new @@ -1 +1 @@ -return false; +return true;",
      "console.log('secret') <div>secret</div>",
    ]

    for (const utterance of unsafeUtterances) {
      expect(
        () => parsePresenceDirectionEvent(presenceDirection({ utterance })),
        `unsafe utterance accepted: ${utterance}`,
      ).toThrowError("PRESENCE-DIRECTION-ENVELOPE")
    }
  })

  it("rejects unsafe, extended, cross-role, and mismatched presence events", () => {
    const invalidEvents = [
      presenceDirection({ extra: true }),
      presenceDirection({ schemaVersion: 2 }),
      presenceDirection({ workspaceGeneration: 0 }),
      presenceDirection({ trigger: "routine_tool" }),
      presenceDirection({ decisionId: null }),
      presenceDirection({ trigger: "main_message", decisionId: "pending-1" }),
      presenceDirection({ trigger: "decision_wait", cue: "success" }),
      presenceDirection({
        trigger: "main_message",
        cue: "success",
        priority: "normal",
      }),
      presenceDirection({
        trigger: "main_message",
        cue: "working",
        priority: "low",
      }),
      presenceDirection({ trigger: "decision_wait", priority: "normal" }),
      presenceDirection({
        trigger: "recoverable_failure",
        cue: "warning",
        priority: "normal",
      }),
      presenceDirection({
        trigger: "long_milestone",
        cue: "working",
        priority: "high",
      }),
      presenceDirection({
        trigger: "turn_completed",
        cue: "neutral",
        priority: "low",
      }),
      presenceDirection({ modelRole: "main_session" }),
      presenceDirection({ model: "gpt-5.6" }),
      presenceDirection({ locale: "fr" }),
      presenceDirection({ utterance: "password=private-value" }),
      presenceDirection({ utterance: "See src/private/file.ts" }),
      presenceDirection({ utterance: "See https://example.com" }),
      presenceDirection({ utterance: "first line\nsecond line" }),
      presenceDirection({ utterance: "🦀".repeat(161) }),
      presenceDirection({ occurredAt: "not-a-time" }),
    ]

    for (const event of invalidEvents) {
      expect(() => parsePresenceDirectionEvent(event)).toThrowError(
        "PRESENCE-DIRECTION-ENVELOPE",
      )
    }
  })

  it("rejects unknown fields, invalid speed steps, and malformed native values", () => {
    expect(() =>
      parseNarrationSettingsSnapshot({
        ...settingsSnapshot,
        settings: { ...settingsSnapshot.settings, speed: 1.12 },
      }),
    ).toThrow(NarrationContractError)
    expect(() =>
      parseNarrationSettingsSnapshot({
        ...settingsSnapshot,
        privatePath: "/\u0055sers/private",
      }),
    ).toThrow(NarrationContractError)
    expect(() =>
      parseNarrationVoiceList({
        schemaVersion: narrationSchemaVersion,
        voices: [{ name: "Daniel", locale: "fr_FR" }],
      }),
    ).toThrow(NarrationContractError)
    expect(() =>
      parseNarrationSpeakResponse({
        schemaVersion: narrationSchemaVersion,
        disposition: "dropped_duplicate",
        queueDepth: 0,
        code: "NARRATION-DUPLICATE",
      }),
    ).toThrow(NarrationContractError)
  })

  it("rejects non-background, unsafe, partial, and extended explanation events", () => {
    const invalidEvents = [
      { ...started(), source: "main_session" },
      { ...started(), trigger: "assistant_output" },
      { ...started(), commitSha: "abc123" },
      { ...started(), commitSha: sha.toUpperCase() },
      { ...started(), extra: true },
      {
        ...started(),
        kind: "chunk",
        sequence: 0,
        text: "password=private-value",
      },
      {
        ...started(),
        kind: "chunk",
        sequence: 0,
        text: "See /\u0055sers/private/project/file.ts",
      },
      {
        ...started(),
        kind: "chunk",
        sequence: 1_024,
        text: "Too far",
      },
    ]
    for (const event of invalidEvents) {
      expect(() => parseCommitNarrationConsumerEvent(event)).toThrowError(
        "NARRATION-PRESENTATION-ENVELOPE",
      )
    }
  })

  it("matches the shared redaction parity fixture", () => {
    expect(redactionFixture.schemaVersion).toBe(narrationSchemaVersion)
    for (const fixture of redactionFixture.safe) {
      expect(
        () =>
          parseCommitNarrationConsumerEvent({
            ...started(),
            kind: "chunk",
            sequence: 0,
            text: fixture.text,
          }),
        `safe fixture rejected: ${fixture.name}`,
      ).not.toThrow()
    }
    for (const fixture of redactionFixture.private) {
      expect(
        () =>
          parseCommitNarrationConsumerEvent({
            ...started(),
            kind: "chunk",
            sequence: 0,
            text: fixture.text,
          }),
        `private fixture accepted: ${fixture.name}`,
      ).toThrowError("NARRATION-PRESENTATION-ENVELOPE")
    }
  })

  it("keeps redaction scanning inside the scalar-size boundary", () => {
    const safeAtLimit = "a".repeat(narrationMaxTextScalars)
    const multibyteAtLimit = "🦀".repeat(narrationMaxTextScalars)
    const privateAtLimit = `${"a".repeat(narrationMaxTextScalars - 3)} /x`
    const overLimit = "a".repeat(narrationMaxTextScalars + 1)
    const farOverLimit = "a".repeat(narrationMaxTextScalars * 1_000)

    expect([...safeAtLimit]).toHaveLength(narrationMaxTextScalars)
    expect([...multibyteAtLimit]).toHaveLength(narrationMaxTextScalars)
    expect([...privateAtLimit]).toHaveLength(narrationMaxTextScalars)
    for (const text of [safeAtLimit, multibyteAtLimit]) {
      expect(() =>
        parseCommitNarrationConsumerEvent({
          ...started(),
          kind: "chunk",
          sequence: 0,
          text,
        }),
      ).not.toThrow()
    }
    for (const text of [privateAtLimit, overLimit, farOverLimit]) {
      expect(() =>
        parseCommitNarrationConsumerEvent({
          ...started(),
          kind: "chunk",
          sequence: 0,
          text,
        }),
      ).toThrowError("NARRATION-PRESENTATION-ENVELOPE")
    }
  })

  it("derives an unambiguous full source key", () => {
    const event = parseCommitNarrationConsumerEvent(started())
    const key = sourceKeyFromCommitNarrationEvent(event)
    const similar: CommitNarrationSourceKey = {
      ...key,
      workspaceId: `${key.workspaceId}:${key.workspaceGeneration}`,
      workspaceGeneration: 0,
    }
    expect(commitNarrationSourceKey(key)).not.toBe(
      commitNarrationSourceKey(similar),
    )
    expect(JSON.parse(commitNarrationSourceKey(key))).toEqual([
      "workspace-1",
      7,
      sha,
      "support-request-1",
      "ja",
    ])
  })
})
