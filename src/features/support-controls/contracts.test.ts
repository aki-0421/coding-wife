import { describe, expect, it } from "vitest"

import {
  SupportControlContractError,
  parseSupportControlCommandError,
  parseSupportControlSnapshot,
} from "@/features/support-controls/contracts"

export const approvedSupportSnapshotFixture = {
  schemaVersion: 1,
  settings: {
    schemaVersion: 1,
    version: 3,
    globalEnabled: true,
    commitExplainerEnabled: true,
  },
  persistence: "native",
  recoveryCode: null,
  readiness: {
    status: "approved",
    approvedCliVersion: "0.144.5",
    approvedBinaryHashPrefix: "5e29ab10ca1171be",
    approvedSchemaFingerprintPrefix: "efea5c6649ccbae7",
    observedCliVersion: "0.144.5",
    observedBinaryHashPrefix: "5e29ab10ca1171be",
    observedSchemaFingerprintPrefix: "efea5c6649ccbae7",
    skillName: "coding-wife-explain-commit",
    skillVersion: "1.1.0",
    skillDigestPrefix: "0123456789abcdef",
    reasonCode: null,
    checkedAt: "2026-07-19T01:02:03Z",
  },
  effectiveState: "enabled",
  effectiveEnabled: true,
  fallbackReasonCode: null,
  capacity: {
    maximumActive: 1,
    maximumQueued: 10,
    active: 1,
    queued: 2,
  },
  usage: {
    attemptedTasks: 4,
    startedTasks: 3,
    succeededTasks: 1,
    failedTasks: 1,
    canceledTasks: 1,
    unavailableTasks: 1,
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    totalLatencyMs: 12,
  },
  audit: {
    role: "commit_explainer",
    modelFamily: "gpt-5.6-sol",
    reasoningEffort: "low",
    permissionProfile: "coding-wife-support-zero",
    rawTranscriptPersisted: false,
    taskTimeoutMs: 15_000,
    tokenBudget: 16_000,
    latestOutcome: {
      status: "generated",
      trigger: "auto_verified_commit",
      completedAt: "2026-07-19T01:02:03Z",
      latencyMs: 12,
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      errorCode: null,
    },
  },
  lastErrorCode: null,
} as const

describe("SupportControlSnapshotV1 contracts", () => {
  it("parses the exact approved identity, capacity, usage, and audit snapshot", () => {
    expect(parseSupportControlSnapshot(approvedSupportSnapshotFixture)).toEqual(
      approvedSupportSnapshotFixture,
    )
  })

  it("accepts a release-blocked snapshot only with a deterministic reason", () => {
    const blocked = {
      ...approvedSupportSnapshotFixture,
      readiness: {
        ...approvedSupportSnapshotFixture.readiness,
        status: "blocked",
        observedCliVersion: "0.145.0",
        observedBinaryHashPrefix: "ffffffffffffffff",
        reasonCode: "CODEX-SUPPORT-RELEASE-UNSUPPORTED",
      },
      effectiveState: "release_blocked",
      effectiveEnabled: false,
      fallbackReasonCode: "CODEX-SUPPORT-RELEASE-UNSUPPORTED",
    }
    expect(parseSupportControlSnapshot(blocked)).toMatchObject({
      effectiveState: "release_blocked",
      effectiveEnabled: false,
    })
  })

  it("rejects role drift, inconsistent state, unbounded counters, and raw material", () => {
    for (const fixture of [
      {
        ...approvedSupportSnapshotFixture,
        settings: {
          ...approvedSupportSnapshotFixture.settings,
          presenceEnabled: true,
        },
      },
      {
        ...approvedSupportSnapshotFixture,
        effectiveEnabled: false,
      },
      {
        ...approvedSupportSnapshotFixture,
        usage: {
          ...approvedSupportSnapshotFixture.usage,
          totalTokens: Number.MAX_SAFE_INTEGER + 1,
        },
      },
      {
        ...approvedSupportSnapshotFixture,
        lastErrorCode: "/\u0055sers/private/token=secret",
      },
      {
        ...approvedSupportSnapshotFixture,
        audit: {
          ...approvedSupportSnapshotFixture.audit,
          prompt: "raw support input",
        },
      },
    ]) {
      expect(() => parseSupportControlSnapshot(fixture)).toThrow(
        SupportControlContractError,
      )
    }
  })

  it("parses only exact safe error envelopes", () => {
    expect(
      parseSupportControlCommandError({
        code: "CODEX-SUPPORT-SETTINGS-CONFLICT",
        operation: "support_settings_update",
        recoverable: true,
        userMessageKey: "support.error.generic",
      }),
    ).toMatchObject({ code: "CODEX-SUPPORT-SETTINGS-CONFLICT" })
    expect(
      parseSupportControlCommandError({
        code: "CODEX-SUPPORT-SETTINGS-CONFLICT",
        operation: "support_settings_update",
        recoverable: true,
        userMessageKey: "support.error.generic",
        raw: "private response",
      }),
    ).toBeNull()
  })
})
