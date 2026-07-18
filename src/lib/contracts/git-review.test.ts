import { describe, expect, it } from "vitest"

import {
  createCommitExplanationCancelRequested,
  createCommitExplanationPresentationRequested,
  createCommitExplanationRequested,
  GitReviewContractError,
  gitReviewCommands,
  parseCommitEvidenceDetail,
  parseCommitEvidenceV1,
  parseCommitExplanationControllerState,
  parseGitObservation,
  parseGitReviewError,
  parseGitReviewResponse,
} from "@/lib/contracts/git-review"

const sha = "a".repeat(40)
const parent = "b".repeat(40)
const digest = `sha256:${"c".repeat(64)}`

function skillAudit() {
  return {
    schemaVersion: 1,
    skillId: "coding-wife-commit-work",
    skillVersion: "1.0.0",
    contentDigest: digest,
    pathAuthority: "app_bundle",
    injectionMode: "skill_input",
    workspaceGeneration: 3,
    workUnitId: "work-unit-one",
    clientRequestId: "turn-one",
    injectedAt: "2026-07-18T01:00:00.000Z",
  }
}

function verification() {
  return {
    evidenceId: "verification-one",
    sourceEventId: "event-verification-one",
    check: "pnpm test",
    result: "passed",
    durationMs: 420,
    summary: "Focused tests passed.",
  }
}

function detail() {
  return {
    schemaVersion: 1,
    commitEvidenceId: `commit-${sha}`,
    workspaceId: "workspace-one",
    producer: "main_codex",
    identity: {
      commitSha: sha,
      subject: "feat(git): observe commit evidence",
      body: "- keep the native boundary read only",
      authorName: "Coding Wife",
      authorEmail: "coding-wife@example.invalid",
      authoredAt: "2026-07-18T01:00:00.000Z",
      committedAt: "2026-07-18T01:00:01.000Z",
      parents: [parent],
    },
    workUnitId: "work-unit-one",
    objective: "Expose read-only commit evidence",
    acceptance: ["The selected diff is loaded lazily."],
    beforeObservationId: "observation-before",
    afterObservationId: "observation-after",
    sourceEventId: "event-terminal-one",
    gates: ["scope", "ownership", "verification", "risk"].map((gate) => ({
      gate,
      outcome: "pass",
      reasonCodes: [`${gate}_observed`],
      evidenceIds: gate === "verification" ? ["verification-one"] : [],
    })),
    files: [
      {
        fileEvidenceId: "file-one",
        relativePath: "src/feature.ts",
        changeKind: "modified",
        additions: 12,
        deletions: 3,
        binary: false,
      },
    ],
    diffSummary: {
      filesChanged: 1,
      additions: 12,
      deletions: 3,
      binaryFiles: 0,
    },
    verification: [verification()],
    decisions: [],
    failedAttempts: [],
    risks: [],
    commitSkillInjection: skillAudit(),
    observedAt: "2026-07-18T01:00:02.000Z",
    historySequence: 42,
  }
}

function observation() {
  return {
    schemaVersion: 1,
    observationId: "observation-active",
    workspaceId: "workspace-one",
    workspaceGeneration: 3,
    reason: "active_view",
    workUnitId: null,
    sourceEventId: null,
    supportState: "ready",
    headSha: sha,
    headReference: "refs/heads/feature/read-only",
    branch: "feature/read-only",
    detached: false,
    indexFingerprint: digest,
    statusFingerprint: digest,
    repositoryFingerprint: digest,
    preExisting: [],
    blockedReasons: [],
    capturedAt: "2026-07-18T01:00:02.000Z",
    historySequence: 40,
  }
}

function explanationEvidence() {
  return {
    schemaVersion: 1,
    commitId: `commit-${sha}`,
    subject: "feat(git): observe commit evidence",
    body: "- keep the native boundary read only",
    changes: [
      {
        changeKind: "modified",
        fileCount: 1,
        additions: 12,
        deletions: 3,
        binaryFiles: 0,
      },
    ],
    diffSummary: {
      filesChanged: 1,
      additions: 12,
      deletions: 3,
      binaryFiles: 0,
    },
    verification: [verification()],
    decisions: [],
    risks: [],
    locale: "ja",
    workspaceGeneration: 3,
    selectionVersion: 2,
  }
}

describe("read-only Git review contracts", () => {
  it("parses observation, list, detail, diff, and explanation responses", () => {
    expect(parseGitObservation(observation())).toEqual(observation())
    expect(parseCommitEvidenceDetail(detail())).toEqual(detail())
    expect(
      parseGitReviewResponse(gitReviewCommands.listCommitEvidence, {
        schemaVersion: 1,
        items: [
          {
            commitEvidenceId: `commit-${sha}`,
            commitSha: sha,
            subject: "feat(git): observe commit evidence",
            authorName: "Coding Wife",
            authoredAt: "2026-07-18T01:00:00.000Z",
            parentCount: 1,
            producer: "main_codex",
            workUnitId: "work-unit-one",
            verificationOutcome: "pass",
            riskOutcome: "pass",
            diffSummary: detail().diffSummary,
            historySequence: 42,
          },
        ],
        nextCursor: null,
      }).items,
    ).toHaveLength(1)
    expect(
      parseGitReviewResponse(gitReviewCommands.readCommitDiffFile, {
        schemaVersion: 1,
        commitEvidenceId: `commit-${sha}`,
        fileEvidenceId: "file-one",
        relativePath: "src/feature.ts",
        changeKind: "modified",
        state: "text",
        content: "@@ -1 +1 @@\n-old\n+new",
        byteCount: 24,
        additions: 1,
        deletions: 1,
      }).state,
    ).toBe("text")
    expect(parseCommitEvidenceV1(explanationEvidence())).toEqual(
      explanationEvidence(),
    )
  })

  it("rejects mutation fields, unknown fields, and non-pathless support evidence", () => {
    expect(() =>
      parseGitObservation({ ...observation(), gitArgs: ["commit"] }),
    ).toThrow(GitReviewContractError)
    expect(() =>
      parseCommitEvidenceDetail({ ...detail(), mutationAction: "write" }),
    ).toThrow(GitReviewContractError)
    expect(() =>
      parseCommitEvidenceV1({
        ...explanationEvidence(),
        relativePath: "src/secret.ts",
      }),
    ).toThrow(GitReviewContractError)
    expect(() =>
      parseCommitEvidenceV1({
        ...explanationEvidence(),
        subject: "token=secret-value",
      }),
    ).toThrow(GitReviewContractError)
  })

  it("creates app-owned, selection-bound explanation requests and presentation intents", () => {
    const request = {
      schemaVersion: 1 as const,
      requestId: "explanation-request-one",
      workspaceId: "workspace-one",
      workspaceGeneration: 3,
      commitEvidenceId: `commit-${sha}`,
      locale: "ja" as const,
      selectionVersion: 2,
      trigger: "user_request" as const,
      requestedAt: "2026-07-18T01:00:03.000Z",
    }
    expect(createCommitExplanationRequested(request)).toEqual(request)
    expect(() =>
      createCommitExplanationRequested({ ...request, selectionVersion: 0 }),
    ).toThrow(GitReviewContractError)
    expect(() =>
      createCommitExplanationRequested({
        ...request,
        trigger: "verified_commit" as never,
      }),
    ).toThrow(GitReviewContractError)

    const controllerState = {
      schemaVersion: 1,
      workspaceId: request.workspaceId,
      workspaceGeneration: request.workspaceGeneration,
      commitEvidenceId: request.commitEvidenceId,
      requestId: request.requestId,
      status: "generated",
      trigger: "auto_verified_commit",
      retryable: false,
      presentationAvailable: true,
      errorCode: null,
      updatedAt: "2026-07-18T01:00:04.000Z",
    }
    expect(parseCommitExplanationControllerState(controllerState)).toEqual(
      controllerState,
    )
    expect(() =>
      parseCommitExplanationControllerState({
        ...controllerState,
        presentationAvailable: false,
      }),
    ).toThrow(GitReviewContractError)

    expect(
      createCommitExplanationPresentationRequested({
        schemaVersion: 1,
        workspaceId: request.workspaceId,
        workspaceGeneration: request.workspaceGeneration,
        commitEvidenceId: request.commitEvidenceId,
        requestId: request.requestId,
        mode: "show",
        requestedAt: "2026-07-18T01:00:05.000Z",
      }),
    ).toMatchObject({ mode: "show" })

    expect(
      createCommitExplanationCancelRequested({
        schemaVersion: 1,
        requestId: request.requestId,
        workspaceGeneration: request.workspaceGeneration,
        selectionVersion: request.selectionVersion,
        reason: "selection_changed",
        requestedAt: "2026-07-18T01:00:06.000Z",
      }),
    ).toMatchObject({ reason: "selection_changed" })
  })

  it("parses only bounded structured native errors", () => {
    const error = {
      code: "GIT-COMMIT-NOT-FOUND",
      operation: "read_git_commit_evidence",
      recoverable: false,
      userMessageKey: "gitReview.error.generic",
      detailRef: "commit-evidence",
    }
    expect(parseGitReviewError(error)).toEqual(error)
    expect(() =>
      parseGitReviewError({ ...error, rawStderr: "secret" }),
    ).toThrow(GitReviewContractError)
  })
})
