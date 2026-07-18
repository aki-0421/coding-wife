import type { GitReviewTransport } from "@/features/git-review/transport"
import {
  gitReviewCommands,
  gitReviewSchemaVersion,
  parseGitReviewResponse,
  type CommitDiffFile,
  type CommitEvidenceDetail,
  type CommitEvidenceSummary,
  type GitObservation,
  type GitReviewCommand,
  type GitReviewRequestMap,
  type GitReviewResponseMap,
} from "@/lib/contracts/git-review"

const currentSha = "a".repeat(40)
const previousSha = "b".repeat(40)
const baseSha = "c".repeat(40)
const digest = `sha256:${"d".repeat(64)}`

const skillAudit = {
  schemaVersion: gitReviewSchemaVersion,
  skillId: "coding-wife-commit-work",
  skillVersion: "1.0.0",
  contentDigest: `sha256:${"e".repeat(64)}`,
  pathAuthority: "app_bundle",
  injectionMode: "skill_input",
  workspaceGeneration: 1,
  workUnitId: "work-unit-read-only-git",
  clientRequestId: "turn-read-only-git",
  injectedAt: "2026-07-18T08:32:00.000Z",
} as const

const currentDetail: CommitEvidenceDetail = {
  schemaVersion: gitReviewSchemaVersion,
  commitEvidenceId: `commit-${currentSha}`,
  workspaceId: "workspace-demo",
  producer: "main_codex",
  identity: {
    commitSha: currentSha,
    subject: "feat(git): add read-only commit evidence",
    body: [
      "- observe repository state without changing the index or worktree",
      "- present commit metadata, lazy diffs, and correlated verification",
      "- expose pathless evidence only through the app-owned explanation controller",
    ].join("\n"),
    authorName: "Coding Wife",
    authorEmail: "coding-wife@example.invalid",
    authoredAt: "2026-07-18T08:40:00.000Z",
    committedAt: "2026-07-18T08:40:04.000Z",
    parents: [previousSha],
  },
  workUnitId: "work-unit-read-only-git",
  objective:
    "Make main-session commits understandable without giving the native observer mutation authority.",
  acceptance: [
    "Show commit identity and correlation without changing Git state.",
    "Load one sanitized file diff only after file selection.",
    "Start isolated explanation only after the user asks for it.",
  ],
  beforeObservationId: "observation-before-read-only-git",
  afterObservationId: "observation-after-read-only-git",
  sourceEventId: "event-terminal-read-only-git",
  gates: [
    {
      gate: "scope",
      outcome: "pass",
      reasonCodes: ["objective_correlated", "acceptance_bounded"],
      evidenceIds: ["decision-observer-boundary"],
    },
    {
      gate: "ownership",
      outcome: "pass",
      reasonCodes: ["pre_existing_changes_observed", "main_session_reported"],
      evidenceIds: ["event-terminal-read-only-git"],
    },
    {
      gate: "verification",
      outcome: "pass",
      reasonCodes: ["typescript_passed", "focused_tests_passed"],
      evidenceIds: ["verification-typescript", "verification-vitest"],
    },
    {
      gate: "risk",
      outcome: "needs_review",
      reasonCodes: ["support_runtime_optional"],
      evidenceIds: ["risk-support-unavailable"],
    },
  ],
  files: [
    {
      fileEvidenceId: "file-store",
      relativePath: "src/features/git-review/store.ts",
      changeKind: "modified",
      additions: 286,
      deletions: 451,
      binary: false,
    },
    {
      fileEvidenceId: "file-view",
      relativePath: "src/features/git-review/EvidenceView.tsx",
      changeKind: "modified",
      additions: 344,
      deletions: 302,
      binary: false,
    },
    {
      fileEvidenceId: "file-demo-image",
      relativePath: "docs/thinking/demo.png",
      changeKind: "modified",
      additions: 0,
      deletions: 0,
      binary: true,
    },
  ],
  diffSummary: {
    filesChanged: 3,
    additions: 630,
    deletions: 753,
    binaryFiles: 1,
  },
  verification: [
    {
      evidenceId: "verification-typescript",
      sourceEventId: "event-verification-typescript",
      check: "pnpm exec tsc -b --pretty false",
      result: "passed",
      durationMs: 3_842,
      summary: "The read-only Git contracts compiled.",
    },
    {
      evidenceId: "verification-vitest",
      sourceEventId: "event-verification-vitest",
      check: "Git review Vitest suite",
      result: "passed",
      durationMs: 2_118,
      summary: "Transport, store, and evidence UI tests passed.",
    },
  ],
  decisions: [
    {
      decisionId: "decision-observer-boundary",
      sourceEventId: "event-decision-observer-boundary",
      summary: "Keep the native Git boundary read only.",
      answer: "Let the main Codex session remain the sole commit producer.",
      rationale:
        "One producer avoids index ownership conflicts and makes evidence attribution explicit.",
      reversible: true,
    },
  ],
  failedAttempts: [
    {
      attemptId: "attempt-second-git-producer",
      sourceEventId: "event-attempt-second-git-producer",
      approach: "Create commits in a second native Git service.",
      outcome: "Rejected because it introduced a competing Git producer.",
      learning: "Observation and mutation need separate authorities.",
    },
  ],
  risks: [
    {
      riskId: "risk-support-unavailable",
      sourceEventId: "event-risk-support-unavailable",
      category: "support_runtime",
      level: "low",
      summary: "Commit explanation may be unavailable while offline.",
      mitigation: "Keep all local commit evidence readable without support.",
      resolved: false,
    },
  ],
  commitSkillInjection: skillAudit,
  observedAt: "2026-07-18T08:40:06.000Z",
  historySequence: 42,
}

const previousDetail: CommitEvidenceDetail = {
  schemaVersion: gitReviewSchemaVersion,
  commitEvidenceId: `commit-${previousSha}`,
  workspaceId: "workspace-demo",
  producer: "external_uncorrelated",
  identity: {
    commitSha: previousSha,
    subject: "chore: update local project metadata",
    body: "",
    authorName: "Local Developer",
    authorEmail: "developer@example.invalid",
    authoredAt: "2026-07-18T07:16:00.000Z",
    committedAt: "2026-07-18T07:16:00.000Z",
    parents: [baseSha],
  },
  workUnitId: null,
  objective: null,
  acceptance: [],
  beforeObservationId: null,
  afterObservationId: null,
  sourceEventId: null,
  gates: ["scope", "ownership", "verification", "risk"].map((gate) => ({
    gate: gate as "scope" | "ownership" | "verification" | "risk",
    outcome: "unknown" as const,
    reasonCodes: ["external_commit_uncorrelated"],
    evidenceIds: [],
  })),
  files: [
    {
      fileEvidenceId: "file-project-metadata",
      relativePath: "package.json",
      changeKind: "modified",
      additions: 2,
      deletions: 2,
      binary: false,
    },
  ],
  diffSummary: {
    filesChanged: 1,
    additions: 2,
    deletions: 2,
    binaryFiles: 0,
  },
  verification: [],
  decisions: [],
  failedAttempts: [],
  risks: [],
  commitSkillInjection: null,
  observedAt: "2026-07-18T07:16:02.000Z",
  historySequence: 31,
}

const details = [currentDetail, previousDetail] as const

function summary(detail: CommitEvidenceDetail): CommitEvidenceSummary {
  const verification = detail.gates.find((gate) => gate.gate === "verification")
  const risk = detail.gates.find((gate) => gate.gate === "risk")
  return {
    commitEvidenceId: detail.commitEvidenceId,
    commitSha: detail.identity.commitSha,
    subject: detail.identity.subject,
    authorName: detail.identity.authorName,
    authoredAt: detail.identity.authoredAt,
    parentCount: detail.identity.parents.length,
    producer: detail.producer,
    workUnitId: detail.workUnitId,
    verificationOutcome: verification?.outcome ?? "unknown",
    riskOutcome: risk?.outcome ?? "unknown",
    diffSummary: detail.diffSummary,
    historySequence: detail.historySequence,
  }
}

const diffs: Readonly<Record<string, CommitDiffFile>> = {
  "file-store": {
    schemaVersion: gitReviewSchemaVersion,
    commitEvidenceId: currentDetail.commitEvidenceId,
    fileEvidenceId: "file-store",
    relativePath: "src/features/git-review/store.ts",
    changeKind: "modified",
    state: "text",
    content: [
      "@@ -21,7 +21,8 @@ export class GitReviewStore {",
      "-  async initialize(): Promise<void> {",
      "+  async activate(): Promise<void> {",
      "+    if (this.current.active) return",
      "     await this.refresh()",
      "   }",
    ].join("\n"),
    byteCount: 184,
    additions: 2,
    deletions: 1,
  },
  "file-view": {
    schemaVersion: gitReviewSchemaVersion,
    commitEvidenceId: currentDetail.commitEvidenceId,
    fileEvidenceId: "file-view",
    relativePath: "src/features/git-review/EvidenceView.tsx",
    changeKind: "modified",
    state: "text",
    content: [
      "@@ -80,6 +80,10 @@ export function EvidenceView() {",
      "+  useEffect(() => {",
      "+    if (active) void store.activate()",
      "+    else store.deactivate()",
      "+  }, [active, store])",
    ].join("\n"),
    byteCount: 166,
    additions: 4,
    deletions: 0,
  },
  "file-demo-image": {
    schemaVersion: gitReviewSchemaVersion,
    commitEvidenceId: currentDetail.commitEvidenceId,
    fileEvidenceId: "file-demo-image",
    relativePath: "docs/thinking/demo.png",
    changeKind: "modified",
    state: "binary",
    content: "",
    byteCount: 824_018,
    additions: 0,
    deletions: 0,
  },
  "file-project-metadata": {
    schemaVersion: gitReviewSchemaVersion,
    commitEvidenceId: previousDetail.commitEvidenceId,
    fileEvidenceId: "file-project-metadata",
    relativePath: "package.json",
    changeKind: "modified",
    state: "text",
    content: '@@ -4 +4 @@\n-  "version": "0.1.0"\n+  "version": "0.1.1"',
    byteCount: 74,
    additions: 1,
    deletions: 1,
  },
}

function detailById(commitEvidenceId: string) {
  const detail = details.find(
    (candidate) => candidate.commitEvidenceId === commitEvidenceId,
  )
  if (detail === undefined) throw new Error("Demo commit evidence is missing")
  return detail
}

function observationFor(
  request: GitReviewRequestMap["observe_git_repository"],
): GitObservation {
  return {
    schemaVersion: gitReviewSchemaVersion,
    observationId: `observation-${request.clientRequestId}`,
    workspaceId: request.workspaceId,
    workspaceGeneration: request.workspaceGeneration,
    reason: request.reason,
    workUnitId: request.workUnitId,
    sourceEventId: request.sourceEventId,
    supportState: "ready",
    headSha: currentSha,
    headReference: "refs/heads/feature/read-only-git",
    branch: "feature/read-only-git",
    detached: false,
    indexFingerprint: digest,
    statusFingerprint: digest,
    repositoryFingerprint: digest,
    preExisting: [
      {
        fileId: "pre-existing-local-note",
        relativePath: "notes/local-plan.md",
        changeKind: "modified",
        staged: false,
        unstaged: true,
        untracked: false,
      },
    ],
    blockedReasons: [],
    capturedAt: "2026-07-18T08:42:00.000Z",
    historySequence: 43,
  }
}

export class DemoGitReviewTransport implements GitReviewTransport {
  readonly kind = "demo"

  constructor(private readonly latencyMs = 80) {}

  async request<K extends GitReviewCommand>(
    command: K,
    request: GitReviewRequestMap[K],
  ): Promise<GitReviewResponseMap[K]> {
    if (this.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.latencyMs))
    }

    let response: unknown
    switch (command) {
      case gitReviewCommands.observeRepository:
        response = observationFor(
          request as GitReviewRequestMap["observe_git_repository"],
        )
        break
      case gitReviewCommands.observeTerminalWorkUnit: {
        const input =
          request as GitReviewRequestMap["observe_terminal_work_unit"]
        const observation = observationFor({
          schemaVersion: gitReviewSchemaVersion,
          clientRequestId: input.clientRequestId,
          workspaceId: input.workspaceId,
          workspaceGeneration: input.workspaceGeneration,
          reason: "work_unit_terminal",
          workUnitId: input.workUnitId,
          sourceEventId: input.sourceEventId,
        })
        response = {
          schemaVersion: gitReviewSchemaVersion,
          observation,
          workUnit: {
            schemaVersion: gitReviewSchemaVersion,
            workspaceId: input.workspaceId,
            workspaceGeneration: input.workspaceGeneration,
            workUnitId: input.workUnitId,
            sourceEventId: input.sourceEventId,
            terminalState: input.terminalState,
            beforeObservationId: input.beforeObservationId,
            afterObservationId: observation.observationId,
            newCommitEvidenceIds: [currentDetail.commitEvidenceId],
            commitSkillInjection: input.commitSkillInjection,
            reportedCommitBlockReason: input.reportedCommitBlockReason,
            observedAt: observation.capturedAt,
            historySequence: 44,
          },
          newCommits: [summary(currentDetail)],
        }
        break
      }
      case gitReviewCommands.listCommitEvidence: {
        const input = request as GitReviewRequestMap["list_commit_evidence"]
        const filtered = details.filter((detail) => {
          if (input.filter === "all") return true
          if (input.filter === "this_work_unit") {
            return (
              input.workUnitId !== null &&
              detail.workUnitId === input.workUnitId
            )
          }
          return detail.gates.some((gate) => gate.outcome !== "pass")
        })
        response = {
          schemaVersion: gitReviewSchemaVersion,
          items: filtered.slice(0, input.limit).map(summary),
          nextCursor: null,
        }
        break
      }
      case gitReviewCommands.readCommitEvidence: {
        const input = request as GitReviewRequestMap["read_commit_evidence"]
        response = {
          ...detailById(input.commitEvidenceId),
          workspaceId: input.workspaceId,
        }
        break
      }
      case gitReviewCommands.readCommitDiffFile: {
        const input = request as GitReviewRequestMap["read_commit_diff_file"]
        const diff = diffs[input.fileEvidenceId]
        if (
          diff === undefined ||
          diff.commitEvidenceId !== input.commitEvidenceId
        ) {
          throw new Error("Demo diff evidence is missing")
        }
        response = diff
        break
      }
      case gitReviewCommands.prepareCommitExplanationEvidence: {
        const input =
          request as GitReviewRequestMap["prepare_commit_explanation_evidence"]
        const detail = detailById(input.commitEvidenceId)
        const changeKinds = [
          "added",
          "modified",
          "deleted",
          "type_changed",
        ] as const
        response = {
          schemaVersion: gitReviewSchemaVersion,
          commitId: detail.commitEvidenceId,
          subject: detail.identity.subject,
          body: detail.identity.body,
          changes: changeKinds
            .map((changeKind) => {
              const files = detail.files.filter(
                (file) => file.changeKind === changeKind,
              )
              return {
                changeKind,
                fileCount: files.length,
                additions: files.reduce(
                  (total, file) => total + file.additions,
                  0,
                ),
                deletions: files.reduce(
                  (total, file) => total + file.deletions,
                  0,
                ),
                binaryFiles: files.filter((file) => file.binary).length,
              }
            })
            .filter((aggregate) => aggregate.fileCount > 0),
          diffSummary: detail.diffSummary,
          verification: detail.verification,
          decisions: detail.decisions,
          risks: detail.risks,
          locale: input.locale,
          workspaceGeneration: input.workspaceGeneration,
          selectionVersion: input.selectionVersion,
        }
        break
      }
    }

    return parseGitReviewResponse(command, response)
  }
}

export const demoCommitEvidence = details
