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
  parseCommitExplanationPresentation,
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

function explanationEvidenceWithEncodedBytes(target: number) {
  const decisions = Array.from({ length: 20 }, (_, index) => ({
    decisionId: `decision-${index}`,
    sourceEventId: `decision-event-${index}`,
    summary: `Decision ${index}`,
    answer: "Keep the boundary read only",
    rationale: "",
    reversible: true,
  }))
  const evidence = {
    ...explanationEvidence(),
    body: "",
    verification: [],
    decisions,
  }
  let remaining =
    target - new TextEncoder().encode(JSON.stringify(evidence)).byteLength
  for (const decision of decisions) {
    if (remaining <= 0) break
    const length = Math.min(4096, remaining)
    decision.rationale = "x".repeat(length)
    remaining -= length
  }
  if (remaining !== 0) throw new Error("Unable to create payload boundary")
  return evidence
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

  it("rejects every public string slot when it contains a repository path", () => {
    const privatePath = "src/private.ts"
    const mutations = [
      { subject: privatePath },
      { body: privatePath },
      {
        verification: [{ ...verification(), check: privatePath }],
      },
      {
        verification: [{ ...verification(), summary: privatePath }],
      },
      {
        decisions: [
          {
            decisionId: "decision-one",
            sourceEventId: "decision-event-one",
            summary: privatePath,
            answer: "Keep the boundary read only",
            rationale: "No private material",
            reversible: true,
          },
        ],
      },
      {
        decisions: [
          {
            decisionId: "decision-one",
            sourceEventId: "decision-event-one",
            summary: "Keep the boundary read only",
            answer: privatePath,
            rationale: "No private material",
            reversible: true,
          },
        ],
      },
      {
        decisions: [
          {
            decisionId: "decision-one",
            sourceEventId: "decision-event-one",
            summary: "Keep the boundary read only",
            answer: "No private material",
            rationale: privatePath,
            reversible: true,
          },
        ],
      },
      {
        risks: [
          {
            riskId: "risk-one",
            sourceEventId: "risk-event-one",
            category: privatePath,
            level: "low",
            summary: "No private material",
            mitigation: "Keep the boundary read only",
            resolved: false,
          },
        ],
      },
      {
        risks: [
          {
            riskId: "risk-one",
            sourceEventId: "risk-event-one",
            category: "privacy",
            level: "low",
            summary: privatePath,
            mitigation: "Keep the boundary read only",
            resolved: false,
          },
        ],
      },
      {
        risks: [
          {
            riskId: "risk-one",
            sourceEventId: "risk-event-one",
            category: "privacy",
            level: "low",
            summary: "No private material",
            mitigation: privatePath,
            resolved: false,
          },
        ],
      },
    ]

    for (const mutation of mutations) {
      expect(() =>
        parseCommitEvidenceV1({ ...explanationEvidence(), ...mutation }),
      ).toThrow(GitReviewContractError)
    }
  })

  it("rejects path variants and common credential formats", () => {
    for (const privateMaterial of [
      "src/private.ts",
      "./src/private.ts",
      "../private/config.json",
      "/Users/alice/repository/private.ts",
      String.raw`C:\Users\alice\private.ts`,
      "<workspace>/src/private.ts",
      "~/private/config.json",
      "Bearer abcdefghijklmnop",
      "token=credential-value",
      "ghp_abcdefghijklmnopqrstuvwxyz123456",
      "github_pat_abcdefghijklmnopqrstuvwxyz",
      "AKIAABCDEFGHIJKLMNOP",
      "xoxb-1234567890-abcdefghijkl",
      "-----BEGIN PRIVATE KEY-----",
    ]) {
      expect(() =>
        parseCommitEvidenceV1({
          ...explanationEvidence(),
          subject: privateMaterial,
        }),
      ).toThrow(GitReviewContractError)
    }
  })

  it("accepts exactly 64 KiB and rejects the next serialized byte", () => {
    const exact = explanationEvidenceWithEncodedBytes(64 * 1024)
    expect(new TextEncoder().encode(JSON.stringify(exact))).toHaveLength(
      64 * 1024,
    )
    expect(parseCommitEvidenceV1(exact)).toEqual(exact)

    expect(() =>
      parseCommitEvidenceV1(explanationEvidenceWithEncodedBytes(64 * 1024 + 1)),
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
      locale: request.locale,
      selectionVersion: request.selectionVersion,
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
    expect(() =>
      parseCommitExplanationControllerState({
        ...controllerState,
        selectionVersion: request.selectionVersion + 1,
        locale: null,
      }),
    ).toThrow(GitReviewContractError)

    const notGenerated = {
      ...controllerState,
      requestId: null,
      locale: null,
      selectionVersion: null,
      status: "not_generated",
      trigger: null,
      presentationAvailable: false,
    }
    expect(parseCommitExplanationControllerState(notGenerated)).toEqual(
      notGenerated,
    )

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

  it("parses only exact, bounded, redacted commit explanation presentations", () => {
    const presentation = {
      schemaVersion: 1,
      workspaceId: "workspace-one",
      workspaceGeneration: 3,
      commitEvidenceId: `commit-${sha}`,
      requestId: "explanation-request-one",
      selectionVersion: 2,
      trigger: "auto_verified_commit",
      locale: "ja",
      mode: "show",
      explanation: {
        schemaVersion: 1,
        locale: "ja",
        summary: "変更内容を安全に説明します。",
        changes: ["読み取り専用の証跡を追加しました。"],
        reasons: ["変更の根拠を確認できるようにするためです。"],
        verification: ["テストが成功しました。"],
        impact: ["コミット画面から確認できます。"],
        cautions: ["既知の注意事項はありません。"],
        howToReadNext: ["検証結果を確認してください。"],
        narrationChunks: [
          { sequence: 1, section: "summary", text: "安全な説明です。" },
          { sequence: 2, section: "changes", text: "証跡を追加しました。" },
        ],
      },
      usage: { inputTokens: 120, outputTokens: 48, totalTokens: 168 },
      latencyMs: 420,
      presentedAt: "2026-07-18T01:00:07.000Z",
    }

    expect(parseCommitExplanationPresentation(presentation)).toEqual(
      presentation,
    )
    for (const invalid of [
      { ...presentation, privatePath: "src/private.ts" },
      {
        ...presentation,
        explanation: {
          ...presentation.explanation,
          narrationChunks: [
            {
              sequence: 0,
              section: "summary",
              text: "zero-based native chunk",
            },
          ],
        },
      },
      {
        ...presentation,
        explanation: {
          ...presentation.explanation,
          narrationChunks: [
            { sequence: 1, section: "changes", text: "change" },
            { sequence: 2, section: "summary", text: "summary" },
          ],
        },
      },
      {
        ...presentation,
        explanation: {
          ...presentation.explanation,
          summary: "https://private.example.invalid/repository",
        },
      },
      {
        ...presentation,
        explanation: {
          ...presentation.explanation,
          summary: "unsafe\u0000control",
        },
      },
    ]) {
      expect(() => parseCommitExplanationPresentation(invalid)).toThrow(
        GitReviewContractError,
      )
    }
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
