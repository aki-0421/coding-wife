import {
  gitReviewCommands,
  gitReviewSchemaVersion,
  parseGitReviewResponse,
  type CompareCheckpointsView,
  type FileDiffView,
  type GitBaseline,
  type GitReviewCommand,
  type GitReviewRequestMap,
  type GitReviewResponseMap,
  type RestoreKind,
  type RestorePreview,
  type RestoreResult,
  type ReviewPack,
  type ReviewPackPage,
  type ReviewPackSummary,
} from "@/lib/contracts/git-review"

import type { GitReviewTransport } from "@/features/git-review/transport"

const currentSha = "a".repeat(40)
const previousSha = "b".repeat(40)
const baseSha = "c".repeat(40)
const fingerprint = `sha256:${"d".repeat(64)}`

const currentPack: ReviewPack = {
  schemaVersion: gitReviewSchemaVersion,
  checkpoint: {
    checkpointId: "checkpoint-git-review-ui",
    commitSha: currentSha,
    parentSha: previousSha,
    targetReference: "refs/heads/feature/git-review",
    message:
      "feat(git): add evidence review workflow\n\n- connect typed review packs to the Commit view\n- add lazy diff, compare, and safe restore previews",
    authorName: "Coding Wife",
    authorEmail: "coding-wife@example.invalid",
    createdAt: "2026-07-18T08:42:00.000Z",
  },
  workspaceId: "workspace-demo",
  workUnitId: "work-unit-git-review-ui",
  objective:
    "Connect automatic Git checkpoints to a reviewable evidence workflow.",
  acceptance: [
    "Show Scope, Ownership, Verification, and Risk separately.",
    "Load one sanitized file diff at a time.",
    "Compare checkpoints without moving HEAD or the working tree.",
    "Require preview and explicit confirmation before restore operations.",
  ],
  gates: [
    {
      gate: "scope",
      outcome: "pass",
      reasonCodes: ["objective_present", "acceptance_bounded"],
      observedRepositoryFingerprint: fingerprint,
    },
    {
      gate: "ownership",
      outcome: "pass",
      reasonCodes: ["owned_manifest_only", "user_index_preserved"],
      observedRepositoryFingerprint: fingerprint,
    },
    {
      gate: "verification",
      outcome: "pass",
      reasonCodes: ["frontend_tests_passed", "rust_tests_passed"],
      observedRepositoryFingerprint: fingerprint,
    },
    {
      gate: "risk",
      outcome: "pass",
      reasonCodes: ["local_refs_only", "restore_is_reversible"],
      observedRepositoryFingerprint: fingerprint,
    },
  ],
  manifest: [
    {
      fileId: "file-store",
      relativePath: "src/features/git-review/store.ts",
      changeKind: "added",
      ownership: "owned",
      beforeHash: null,
      afterHash: `sha256:${"1".repeat(64)}`,
      additions: 418,
      deletions: 0,
      reasonCode: null,
    },
    {
      fileId: "file-view",
      relativePath: "src/features/git-review/EvidenceView.tsx",
      changeKind: "added",
      ownership: "owned",
      beforeHash: null,
      afterHash: `sha256:${"2".repeat(64)}`,
      additions: 692,
      deletions: 0,
      reasonCode: null,
    },
    {
      fileId: "file-transport",
      relativePath: "src/features/git-review/transport.ts",
      changeKind: "added",
      ownership: "owned",
      beforeHash: null,
      afterHash: `sha256:${"3".repeat(64)}`,
      additions: 96,
      deletions: 0,
      reasonCode: null,
    },
    {
      fileId: "file-shell",
      relativePath: "src/features/workspace-view/WorkspaceShell.tsx",
      changeKind: "modified",
      ownership: "pre_existing",
      beforeHash: `sha256:${"4".repeat(64)}`,
      afterHash: `sha256:${"5".repeat(64)}`,
      additions: 7,
      deletions: 3,
      reasonCode: "pre_existing_change_excluded",
    },
  ],
  diffSummary: {
    filesChanged: 4,
    additions: 1213,
    deletions: 3,
    binaryFiles: 0,
    totalBytes: 48_122,
  },
  verification: [
    {
      evidenceId: "verify-typescript",
      check: "pnpm exec tsc -b --pretty false",
      result: "passed",
      durationMs: 3_842,
      summary: "TypeScript project references completed without diagnostics.",
      observedRepositoryFingerprint: fingerprint,
    },
    {
      evidenceId: "verify-vitest",
      check: "pnpm exec vitest run src/features/git-review",
      result: "passed",
      durationMs: 2_118,
      summary: "Transport, store, and Evidence UI tests passed.",
      observedRepositoryFingerprint: fingerprint,
    },
    {
      evidenceId: "verify-browser",
      check: "agent-browser responsive walkthrough",
      result: "passed",
      durationMs: 8_430,
      summary:
        "Desktop, compact, mobile, zoom, and restore flow were inspected.",
      observedRepositoryFingerprint: fingerprint,
    },
  ],
  decisions: [
    {
      decisionId: "decision-headless-store",
      summary: "Keep Git review state outside the workspace shell.",
      answer: "Use an injectable external store and typed transport.",
      rationale:
        "The evidence UI stays testable and the shell only composes workspace-scoped services.",
      reversible: true,
    },
    {
      decisionId: "decision-lazy-diff",
      summary: "Avoid loading every diff with the review pack.",
      answer: "Request one file diff after explicit file selection.",
      rationale:
        "Large checkpoints remain responsive and failures stay isolated to one file.",
      reversible: true,
    },
  ],
  failedAttempts: [
    {
      attemptId: "attempt-shared-shell-first",
      approach:
        "Replace the shared Evidence placeholder before its owner finished.",
      outcome: "Deferred to avoid overlapping worktree changes.",
      learning:
        "Build the feature boundary first, then integrate through a small reviewed shell change.",
    },
  ],
  risks: [
    {
      riskId: "risk-stale-head",
      category: "git_state",
      level: "medium",
      summary: "HEAD or user changes may move after evidence is opened.",
      mitigation:
        "The Rust service re-fingerprints the repository and issues a one-shot confirmation token.",
      resolved: true,
    },
  ],
  restoreGuidance: [
    "Use a revert commit when the current branch is clean and still contains this checkpoint.",
    "Use a recovery branch to inspect this checkpoint without checkout.",
    "The app never performs hard reset, force push, or destructive checkout.",
  ],
  operationState: "history_complete",
  packDigest: `sha256:${"6".repeat(64)}`,
  historySequence: 42,
}

const previousPack: ReviewPack = {
  ...currentPack,
  checkpoint: {
    checkpointId: "checkpoint-git-runtime",
    commitSha: previousSha,
    parentSha: baseSha,
    targetReference: "refs/heads/feature/git-review",
    message:
      "feat(git): add isolated review checkpoints\n\n- preserve user index and worktree state\n- journal checkpoint and restore operations",
    authorName: "Coding Wife",
    authorEmail: "coding-wife@example.invalid",
    createdAt: "2026-07-18T07:16:00.000Z",
  },
  workUnitId: "work-unit-git-runtime",
  objective:
    "Create local review checkpoints without staging or overwriting user changes.",
  acceptance: [
    "Preserve the real index and working tree.",
    "Advance the target ref only after all four gates pass.",
    "Journal enough state for restart diagnosis.",
  ],
  manifest: [
    {
      fileId: "file-rust-service",
      relativePath: "src-tauri/src/git_review/service.rs",
      changeKind: "added",
      ownership: "owned",
      beforeHash: null,
      afterHash: `sha256:${"7".repeat(64)}`,
      additions: 1042,
      deletions: 0,
      reasonCode: null,
    },
    {
      fileId: "file-rust-repository",
      relativePath: "src-tauri/src/git_review/repository.rs",
      changeKind: "added",
      ownership: "owned",
      beforeHash: null,
      afterHash: `sha256:${"8".repeat(64)}`,
      additions: 831,
      deletions: 0,
      reasonCode: null,
    },
  ],
  diffSummary: {
    filesChanged: 2,
    additions: 1873,
    deletions: 0,
    binaryFiles: 0,
    totalBytes: 71_420,
  },
  verification: [
    {
      evidenceId: "verify-rust-tests",
      check: "cargo test --lib git_review::",
      result: "passed",
      durationMs: 12_601,
      summary: "Disposable repository scenarios passed.",
      observedRepositoryFingerprint: fingerprint,
    },
  ],
  decisions: [
    {
      decisionId: "decision-temp-index",
      summary:
        "How should owned changes be committed without touching user staging?",
      answer: "Use an isolated temporary index and object directory.",
      rationale:
        "Prepared objects can be validated before promotion and the real index remains byte-for-byte stable.",
      reversible: false,
    },
  ],
  failedAttempts: [],
  risks: [
    {
      riskId: "risk-object-promotion",
      category: "git_objects",
      level: "low",
      summary: "Promoted objects may become unreachable if ref CAS fails.",
      mitigation:
        "Report the orphan explicitly; Git garbage collection can reclaim it safely.",
      resolved: true,
    },
  ],
  packDigest: `sha256:${"9".repeat(64)}`,
  historySequence: 31,
}

const packs = [currentPack, previousPack] as const

const summaries: readonly ReviewPackSummary[] = packs.map((pack) => ({
  checkpointId: pack.checkpoint.checkpointId,
  commitSha: pack.checkpoint.commitSha,
  workUnitId: pack.workUnitId,
  objective: pack.objective,
  operationState: pack.operationState,
  filesChanged: pack.diffSummary.filesChanged,
  verificationFailures: pack.verification.filter(
    (evidence) => evidence.result === "failed",
  ).length,
  unresolvedRisks: pack.risks.filter((risk) => !risk.resolved).length,
  createdAt: pack.checkpoint.createdAt,
  historySequence: pack.historySequence ?? 0,
}))

const baseline: GitBaseline = {
  schemaVersion: gitReviewSchemaVersion,
  baselineId: "baseline-demo",
  workspaceId: "workspace-demo",
  supportState: "ready",
  headSha: currentSha,
  headReference: "refs/heads/feature/git-review",
  branch: "feature/git-review",
  detached: false,
  indexFingerprint: `sha256:${"a".repeat(64)}`,
  statusFingerprint: `sha256:${"b".repeat(64)}`,
  repositoryFingerprint: fingerprint,
  preExisting: [],
  blockedReasons: [],
  capturedAt: "2026-07-18T08:44:00.000Z",
}

const diffs: Readonly<Record<string, string>> = {
  "file-store": `diff --git a/src/features/git-review/store.ts b/src/features/git-review/store.ts
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/src/features/git-review/store.ts
@@ -0,0 +1,8 @@
+export class GitReviewStore {
+  private current = initialSnapshot
+
+  async selectFile(fileId: string): Promise<void> {
+    // Only the explicitly selected file crosses the IPC boundary.
+    await this.transport.request("read_evidence_diff", { fileId })
+  }
+}`,
  "file-view": `diff --git a/src/features/git-review/EvidenceView.tsx b/src/features/git-review/EvidenceView.tsx
new file mode 100644
--- /dev/null
+++ b/src/features/git-review/EvidenceView.tsx
@@ -0,0 +1,7 @@
+export function EvidenceView({ store, locale }: EvidenceViewProps) {
+  const review = useGitReview(store)
+  return (
+    <main aria-label={copy.title}>
+      <GateSummary gates={review.detail?.gates ?? []} />
+    </main>
+  )
+}`,
  "file-transport": `diff --git a/src/features/git-review/transport.ts b/src/features/git-review/transport.ts
new file mode 100644
--- /dev/null
+++ b/src/features/git-review/transport.ts
@@ -0,0 +1,5 @@
+export class TauriGitReviewTransport {
+  async request(command, request) {
+    return parseGitReviewResponse(command, await invoke(command, { request }))
+  }
+}`,
  "file-shell": `diff --git a/src/features/workspace-view/WorkspaceShell.tsx b/src/features/workspace-view/WorkspaceShell.tsx
index 4444444..5555555 100644
--- a/src/features/workspace-view/WorkspaceShell.tsx
+++ b/src/features/workspace-view/WorkspaceShell.tsx
@@ -280,3 +280,3 @@
-  <EvidencePlaceholder />
+  <EvidenceView store={gitReviewStore} locale={locale} />`,
  "file-rust-service": `diff --git a/src-tauri/src/git_review/service.rs b/src-tauri/src/git_review/service.rs
new file mode 100644
--- /dev/null
+++ b/src-tauri/src/git_review/service.rs
@@ -0,0 +1,4 @@
+pub struct GitReviewService {
+    workspaces: Arc<WorkspaceService>,
+    history: Arc<WorkspaceHistoryService>,
+}`,
  "file-rust-repository": `diff --git a/src-tauri/src/git_review/repository.rs b/src-tauri/src/git_review/repository.rs
new file mode 100644
--- /dev/null
+++ b/src-tauri/src/git_review/repository.rs
@@ -0,0 +1,3 @@
+pub fn compare_and_swap_ref(expected: Oid, next: Oid) -> Result<()> {
+    // The target ref moves only when HEAD is still fresh.
+}`,
}

interface PendingRestore {
  readonly kind: RestoreKind
  readonly checkpointId: string
  readonly recoveryBranch: string | null
}

function reviewPack(checkpointId: string): ReviewPack {
  return (
    packs.find((pack) => pack.checkpoint.checkpointId === checkpointId) ??
    currentPack
  )
}

function diffView(checkpointId: string, fileId: string): FileDiffView {
  const pack = reviewPack(checkpointId)
  const file =
    pack.manifest.find((entry) => entry.fileId === fileId) ?? pack.manifest[0]
  if (file === undefined) throw new Error("Demo file not found")
  const content =
    diffs[file.fileId] ?? "[Sanitized diff is unavailable in demo mode.]"
  return {
    schemaVersion: gitReviewSchemaVersion,
    checkpointId: pack.checkpoint.checkpointId,
    fileId: file.fileId,
    relativePath: file.relativePath,
    changeKind: file.changeKind,
    ownership: file.ownership,
    content,
    truncated: false,
    byteCount: new TextEncoder().encode(content).byteLength,
  }
}

function comparison(
  fromCheckpointId: string,
  toCheckpointId: string,
): CompareCheckpointsView {
  const from = reviewPack(fromCheckpointId)
  const to = reviewPack(toCheckpointId)
  return {
    schemaVersion: gitReviewSchemaVersion,
    fromCommitSha: from.checkpoint.commitSha,
    toCommitSha: to.checkpoint.commitSha,
    diffSummary: to.diffSummary,
    files: to.manifest,
    verificationChanges: [
      "Added TypeScript contract and browser interaction verification.",
    ],
    decisionChanges: [
      "Moved UI state behind a workspace-scoped injectable store.",
      "Kept diff loading file-scoped and lazy.",
    ],
    riskChanges: ["Added stale-HEAD preflight before every restore."],
  }
}

export class DemoGitReviewTransport implements GitReviewTransport {
  readonly kind = "demo"
  private readonly pendingRestores = new Map<string, PendingRestore>()
  private tokenSequence = 0

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
      case gitReviewCommands.inspectBaseline:
        response = baseline
        break
      case gitReviewCommands.evaluateCheckpoint:
        response = {
          schemaVersion: gitReviewSchemaVersion,
          status: "review_ready",
          gates: currentPack.gates,
          manifest: currentPack.manifest,
          checkpoint: currentPack.checkpoint,
          reviewPack: currentPack,
          errorCode: null,
        }
        break
      case gitReviewCommands.listReviewPacks:
        response = {
          schemaVersion: gitReviewSchemaVersion,
          items: summaries,
          nextBeforeSequence: null,
        } satisfies ReviewPackPage
        break
      case gitReviewCommands.readReviewPack:
        response = reviewPack(
          (request as GitReviewRequestMap["read_git_review_pack"]).checkpointId,
        )
        break
      case gitReviewCommands.readFileDiff: {
        const input = request as GitReviewRequestMap["read_evidence_diff"]
        response = diffView(input.checkpointId, input.fileId)
        break
      }
      case gitReviewCommands.compareCheckpoints: {
        const input = request as GitReviewRequestMap["compare_checkpoints"]
        response = comparison(input.fromCheckpointId, input.toCheckpointId)
        break
      }
      case gitReviewCommands.previewRestore: {
        const input = request as GitReviewRequestMap["preview_git_restore"]
        const token = `demo-restore-${++this.tokenSequence}`
        this.pendingRestores.set(token, {
          kind: input.kind,
          checkpointId: input.checkpointId,
          recoveryBranch: input.recoveryBranch,
        })
        const pack = reviewPack(input.checkpointId)
        response = {
          schemaVersion: gitReviewSchemaVersion,
          status: "ready",
          kind: input.kind,
          checkpointId: input.checkpointId,
          impact: {
            targetCommitSha: pack.checkpoint.commitSha,
            currentHeadSha: currentSha,
            affectedFiles: pack.manifest.map((file) => file.relativePath),
            additions: pack.diffSummary.additions,
            deletions: pack.diffSummary.deletions,
            createsNewCommit: input.kind === "revert_commit",
            checksOutBranch: false,
          },
          confirmationToken: token,
          expiresAt: "2026-07-18T09:15:00.000Z",
          blockedReasons: [],
        } satisfies RestorePreview
        break
      }
      case gitReviewCommands.confirmRestore: {
        const input = request as GitReviewRequestMap["confirm_git_restore"]
        const pending = this.pendingRestores.get(input.confirmationToken)
        if (pending === undefined) throw new Error("Demo restore token expired")
        this.pendingRestores.delete(input.confirmationToken)
        response = {
          schemaVersion: gitReviewSchemaVersion,
          kind: pending.kind,
          checkpointId: pending.checkpointId,
          createdCommitSha:
            pending.kind === "revert_commit" ? "e".repeat(40) : null,
          createdReference:
            pending.kind === "recovery_branch"
              ? `refs/heads/${pending.recoveryBranch ?? "recovery/demo"}`
              : null,
          historySequence: 43,
          completedAt: "2026-07-18T08:46:00.000Z",
        } satisfies RestoreResult
        break
      }
      case gitReviewCommands.cancelRestore: {
        const input = request as GitReviewRequestMap["cancel_git_restore"]
        this.pendingRestores.delete(input.confirmationToken)
        response = null
        break
      }
    }

    return parseGitReviewResponse(command, response)
  }
}

export const demoGitReviewPacks = packs
