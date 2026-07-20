import { describe, expect, it } from "vitest"

import redactionFixture from "@/test/fixtures/narration-redaction.v1.json"

import {
  NarrationContractError,
  commitNarrationSourceKey,
  narrationMaxTextScalars,
  narrationSchemaVersion,
  narrationSettingsSchemaVersion,
  parseCommitNarrationConsumerEvent,
  parseNarrationSettingsSnapshot,
  parseNarrationSpeakResponse,
  parseNarrationVoiceList,
  sourceKeyFromCommitNarrationEvent,
  type CommitNarrationSourceKey,
} from "@/features/narration/contracts"

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
