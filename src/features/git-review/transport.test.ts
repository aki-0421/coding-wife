import { describe, expect, it, vi } from "vitest"

import { DemoGitReviewTransport } from "@/features/git-review/demo-transport"
import {
  GitReviewBoundaryError,
  TauriGitReviewTransport,
} from "@/features/git-review/transport"
import { gitReviewCommands } from "@/lib/contracts/git-review"

describe("TauriGitReviewTransport", () => {
  it("passes only the typed request and parses the native response", async () => {
    const demo = new DemoGitReviewTransport(0)
    const page = await demo.request(gitReviewCommands.listReviewPacks, {
      workspaceId: "workspace-demo",
      beforeSequence: null,
      limit: 50,
    })
    const invoker = vi.fn((_command, request) => {
      expect(request).toEqual({
        workspaceId: "workspace-demo",
        beforeSequence: null,
        limit: 50,
      })
      return Promise.resolve(page)
    })
    const transport = new TauriGitReviewTransport(invoker)

    await expect(
      transport.request(gitReviewCommands.listReviewPacks, {
        workspaceId: "workspace-demo",
        beforeSequence: null,
        limit: 50,
      }),
    ).resolves.toEqual(page)
    expect(invoker).toHaveBeenCalledOnce()
  })

  it("normalizes malformed responses without leaking raw native errors", async () => {
    const malformed = new TauriGitReviewTransport(() =>
      Promise.resolve({ schemaVersion: 1, items: "not-an-array" }),
    )
    await expect(
      malformed.request(gitReviewCommands.listReviewPacks, {
        workspaceId: "workspace-demo",
        beforeSequence: null,
        limit: 50,
      }),
    ).rejects.toMatchObject({
      code: "GIT-IPC-CONTRACT-MISMATCH",
      recoverable: false,
      detailRef: "git-review-v1",
    })

    const unavailable = new TauriGitReviewTransport(() =>
      Promise.reject(new Error("/Users/private token=secret")),
    )
    await expect(
      unavailable.request(gitReviewCommands.inspectBaseline, {
        workspaceId: "workspace-demo",
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "GIT-IPC-UNAVAILABLE",
        operation: gitReviewCommands.inspectBaseline,
      }),
    )
  })

  it("preserves a structured Rust error envelope", async () => {
    const nativeError = Object.assign(new Error("Structured Git failure"), {
      code: "GIT-RESTORE-STALE-HEAD",
      operation: gitReviewCommands.previewRestore,
      recoverable: true,
      userMessageKey: "gitReview.error.staleHead",
      detailRef: "restore-preflight",
    })
    const transport = new TauriGitReviewTransport(() =>
      Promise.reject(nativeError),
    )

    await expect(
      transport.request(gitReviewCommands.previewRestore, {
        workspaceId: "workspace-demo",
        checkpointId: "checkpoint-git-review-ui",
        kind: "revert_commit",
        recoveryBranch: null,
      }),
    ).rejects.toEqual(expect.any(GitReviewBoundaryError))
    await expect(
      transport.request(gitReviewCommands.previewRestore, {
        workspaceId: "workspace-demo",
        checkpointId: "checkpoint-git-review-ui",
        kind: "revert_commit",
        recoveryBranch: null,
      }),
    ).rejects.toMatchObject({
      code: "GIT-RESTORE-STALE-HEAD",
      recoverable: true,
      detailRef: "restore-preflight",
    })
  })
})

describe("DemoGitReviewTransport", () => {
  it("supports list, lazy diff, compare, cancel, and confirmed restore", async () => {
    const transport = new DemoGitReviewTransport(0)
    const page = await transport.request(gitReviewCommands.listReviewPacks, {
      workspaceId: "workspace-demo",
      beforeSequence: null,
      limit: 50,
    })
    expect(page.items).toHaveLength(2)

    const [current, previous] = page.items
    if (current === undefined || previous === undefined) {
      throw new Error("Demo checkpoints are missing")
    }
    const pack = await transport.request(gitReviewCommands.readReviewPack, {
      workspaceId: "workspace-demo",
      checkpointId: current.checkpointId,
    })
    const firstFile = pack.manifest[0]
    if (firstFile === undefined) throw new Error("Demo manifest is missing")

    await expect(
      transport.request(gitReviewCommands.readFileDiff, {
        workspaceId: "workspace-demo",
        checkpointId: current.checkpointId,
        fileId: firstFile.fileId,
      }),
    ).resolves.toMatchObject({ relativePath: firstFile.relativePath })
    await expect(
      transport.request(gitReviewCommands.compareCheckpoints, {
        workspaceId: "workspace-demo",
        fromCheckpointId: previous.checkpointId,
        toCheckpointId: current.checkpointId,
      }),
    ).resolves.toMatchObject({
      toCommitSha: current.commitSha,
    })

    const canceled = await transport.request(gitReviewCommands.previewRestore, {
      workspaceId: "workspace-demo",
      checkpointId: current.checkpointId,
      kind: "revert_commit",
      recoveryBranch: null,
    })
    if (canceled.confirmationToken === null) throw new Error("Token is missing")
    await expect(
      transport.request(gitReviewCommands.cancelRestore, {
        workspaceId: "workspace-demo",
        confirmationToken: canceled.confirmationToken,
      }),
    ).resolves.toBeNull()

    const confirmed = await transport.request(
      gitReviewCommands.previewRestore,
      {
        workspaceId: "workspace-demo",
        checkpointId: current.checkpointId,
        kind: "recovery_branch",
        recoveryBranch: "recovery/demo-checkpoint",
      },
    )
    if (confirmed.confirmationToken === null)
      throw new Error("Token is missing")
    await expect(
      transport.request(gitReviewCommands.confirmRestore, {
        workspaceId: "workspace-demo",
        confirmationToken: confirmed.confirmationToken,
      }),
    ).resolves.toMatchObject({
      kind: "recovery_branch",
      createdReference: "refs/heads/recovery/demo-checkpoint",
    })
  })
})
