import { describe, expect, it } from "vitest"

import {
  GitReviewContractError,
  gitReviewCommands,
  parseCheckpointEvaluation,
  parseFileDiffView,
  parseGitBaseline,
  parseGitReviewError,
  parseGitReviewResponse,
  parseRestorePreview,
  parseReviewPack,
} from "@/lib/contracts/git-review"

const fingerprint = `sha256:${"c".repeat(64)}`

function reviewPack() {
  return {
    schemaVersion: 1,
    checkpoint: {
      checkpointId: "checkpoint-fixture",
      commitSha: "a".repeat(40),
      parentSha: "b".repeat(40),
      targetReference: "refs/heads/main",
      message: "feat(git): add fixture\n\n- verify the exact contract",
      authorName: "Fixture Author",
      authorEmail: "fixture@example.invalid",
      createdAt: "2026-07-18T00:00:02.000Z",
    },
    workspaceId: "workspace-fixture",
    workUnitId: "work-unit-fixture",
    objective: "Persist a bounded review pack",
    acceptance: ["The exact review pack is available"],
    gates: ["scope", "ownership", "verification", "risk"].map((gate) => ({
      gate,
      outcome: "pass",
      reasonCodes: [],
      observedRepositoryFingerprint: fingerprint,
    })),
    manifest: [
      {
        fileId: "file-fixture",
        relativePath: "src/main.rs",
        changeKind: "modified",
        ownership: "owned",
        beforeHash: `sha256:${"d".repeat(64)}`,
        afterHash: `sha256:${"e".repeat(64)}`,
        additions: 4,
        deletions: 1,
        reasonCode: null,
      },
    ],
    diffSummary: {
      filesChanged: 1,
      additions: 4,
      deletions: 1,
      binaryFiles: 0,
      totalBytes: 128,
    },
    verification: [
      {
        evidenceId: "evidence-fixture",
        check: "cargo test",
        result: "passed",
        durationMs: 1200,
        summary: "All focused tests passed",
        observedRepositoryFingerprint: fingerprint,
      },
    ],
    decisions: [],
    failedAttempts: [],
    risks: [],
    restoreGuidance: ["Preview the affected files before restore."],
    operationState: "history_complete",
    packDigest: `sha256:${"f".repeat(64)}`,
    historySequence: 42,
  }
}

describe("Git review contract", () => {
  it("parses exact baseline, review pack, and review-ready evaluation shapes", () => {
    const baseline = {
      schemaVersion: 1,
      baselineId: "baseline-fixture",
      workspaceId: "workspace-fixture",
      supportState: "ready",
      headSha: "a".repeat(40),
      headReference: "refs/heads/main",
      branch: "main",
      detached: false,
      indexFingerprint: fingerprint,
      statusFingerprint: fingerprint,
      repositoryFingerprint: fingerprint,
      preExisting: [],
      blockedReasons: [],
      capturedAt: "2026-07-18T00:00:00.000Z",
    }
    const pack = reviewPack()
    const evaluation = {
      schemaVersion: 1,
      status: "review_ready",
      gates: pack.gates,
      manifest: pack.manifest,
      checkpoint: pack.checkpoint,
      reviewPack: pack,
      errorCode: null,
    }

    expect(parseGitBaseline(baseline)).toEqual(baseline)
    expect(parseReviewPack(pack)).toEqual(pack)
    expect(parseCheckpointEvaluation(evaluation)).toEqual(evaluation)
    expect(
      parseGitReviewResponse(gitReviewCommands.evaluateCheckpoint, evaluation),
    ).toEqual(evaluation)
  })

  it("rejects unknown fields, future schemas, private paths, and secret text", () => {
    const pack = reviewPack()
    expect(() => parseReviewPack({ ...pack, rawGitArgs: ["commit"] })).toThrow(
      GitReviewContractError,
    )
    expect(() => parseReviewPack({ ...pack, schemaVersion: 2 })).toThrow(
      GitReviewContractError,
    )
    expect(() =>
      parseReviewPack({
        ...pack,
        manifest: [{ ...pack.manifest[0], relativePath: "/Users/private/key" }],
      }),
    ).toThrow(GitReviewContractError)
    expect(() =>
      parseReviewPack({
        ...pack,
        objective: "Authorization: Bearer private-token",
      }),
    ).toThrow(GitReviewContractError)
  })

  it("requires all four terminal gates and fresh passed verification in persisted packs", () => {
    const pack = reviewPack()
    expect(() =>
      parseReviewPack({ ...pack, gates: pack.gates.slice(0, 3) }),
    ).toThrow(GitReviewContractError)
    expect(() =>
      parseReviewPack({
        ...pack,
        gates: pack.gates.map((gate) =>
          gate.gate === "risk" ? { ...gate, outcome: "needs_review" } : gate,
        ),
      }),
    ).toThrow(GitReviewContractError)
    expect(() => parseReviewPack({ ...pack, verification: [] })).toThrow(
      GitReviewContractError,
    )
  })

  it("bounds lazy diff content and enforces coherent restore previews", () => {
    const diff = {
      schemaVersion: 1,
      checkpointId: "checkpoint-fixture",
      fileId: "file-fixture",
      relativePath: "src/main.rs",
      changeKind: "modified",
      ownership: "owned",
      content: "@@ -1 +1 @@\n-before\n+after\n",
      truncated: false,
      byteCount: 32,
    }
    const preview = {
      schemaVersion: 1,
      status: "ready",
      kind: "revert_commit",
      checkpointId: "checkpoint-fixture",
      impact: {
        targetCommitSha: "a".repeat(40),
        currentHeadSha: "b".repeat(40),
        affectedFiles: ["src/main.rs"],
        additions: 1,
        deletions: 1,
        createsNewCommit: true,
        checksOutBranch: false,
      },
      confirmationToken: "restore-fixture",
      expiresAt: "2026-07-18T00:05:00.000Z",
      blockedReasons: [],
    }
    expect(parseFileDiffView(diff)).toEqual(diff)
    expect(parseRestorePreview(preview)).toEqual(preview)
    expect(() =>
      parseRestorePreview({ ...preview, confirmationToken: null }),
    ).toThrow(GitReviewContractError)
    expect(() =>
      parseFileDiffView({ ...diff, content: "x".repeat(1024 * 1024 + 1) }),
    ).toThrow(GitReviewContractError)
  })

  it("parses only bounded sanitized error envelopes and null cancel responses", () => {
    const error = {
      code: "GIT-REF-CAS",
      operation: "evaluate_and_checkpoint_work_unit",
      recoverable: true,
      userMessageKey: "gitReview.error.generic",
      detailRef: "orphaned-objects:3",
    }
    expect(parseGitReviewError(error)).toEqual(error)
    expect(
      parseGitReviewResponse(gitReviewCommands.cancelRestore, null),
    ).toBeNull()
    expect(() =>
      parseGitReviewError({ ...error, rawStderr: "private output" }),
    ).toThrow(GitReviewContractError)
  })
})
