import { describe, expect, it, vi } from "vitest"

import { DemoGitReviewTransport } from "@/features/git-review/demo-transport"
import {
  GitReviewBoundaryError,
  TauriGitReviewTransport,
} from "@/features/git-review/transport"
import {
  gitReviewCommands,
  gitReviewSchemaVersion,
} from "@/lib/contracts/git-review"

describe("TauriGitReviewTransport", () => {
  it("passes only the typed request and parses the native response", async () => {
    const request = {
      schemaVersion: gitReviewSchemaVersion,
      workspaceId: "workspace-demo",
      workspaceGeneration: 1,
      cursor: null,
      limit: 50,
      filter: "all" as const,
      workUnitId: null,
    }
    const demo = new DemoGitReviewTransport(0)
    const page = await demo.request(
      gitReviewCommands.listCommitEvidence,
      request,
    )
    const invoker = vi.fn((_command, input) => {
      expect(input).toEqual(request)
      return Promise.resolve(page)
    })
    const transport = new TauriGitReviewTransport(invoker)

    await expect(
      transport.request(gitReviewCommands.listCommitEvidence, request),
    ).resolves.toEqual(page)
    expect(invoker).toHaveBeenCalledOnce()
  })

  it("normalizes malformed responses without exposing raw native errors", async () => {
    const request = {
      schemaVersion: gitReviewSchemaVersion,
      workspaceId: "workspace-demo",
      workspaceGeneration: 1,
      cursor: null,
      limit: 50,
      filter: "all" as const,
      workUnitId: null,
    }
    const malformed = new TauriGitReviewTransport(() =>
      Promise.resolve({ schemaVersion: 1, items: "not-an-array" }),
    )
    await expect(
      malformed.request(gitReviewCommands.listCommitEvidence, request),
    ).rejects.toMatchObject({
      code: "GIT-IPC-CONTRACT-MISMATCH",
      recoverable: false,
      detailRef: "git-review-v1",
    })

    const unavailable = new TauriGitReviewTransport(() =>
      Promise.reject(new Error("private native diagnostic")),
    )
    await expect(
      unavailable.request(gitReviewCommands.listCommitEvidence, request),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "GIT-IPC-UNAVAILABLE",
        operation: gitReviewCommands.listCommitEvidence,
      }),
    )
  })

  it("preserves a structured read-only observer error envelope", async () => {
    const nativeError = new GitReviewBoundaryError({
      code: "GIT-OBSERVATION-STALE",
      operation: gitReviewCommands.observeRepository,
      recoverable: true,
      userMessageKey: "gitReview.error.stale",
      detailRef: "observation-race",
    })
    const transport = new TauriGitReviewTransport(() =>
      Promise.reject(nativeError),
    )

    await expect(
      transport.request(gitReviewCommands.observeRepository, {
        schemaVersion: gitReviewSchemaVersion,
        clientRequestId: "observe-one",
        workspaceId: "workspace-demo",
        workspaceGeneration: 1,
        reason: "manual_refresh",
        workUnitId: null,
        sourceEventId: null,
      }),
    ).rejects.toEqual(expect.any(GitReviewBoundaryError))
    await expect(
      transport.request(gitReviewCommands.observeRepository, {
        schemaVersion: gitReviewSchemaVersion,
        clientRequestId: "observe-two",
        workspaceId: "workspace-demo",
        workspaceGeneration: 1,
        reason: "manual_refresh",
        workUnitId: null,
        sourceEventId: null,
      }),
    ).rejects.toMatchObject(nativeError)
  })
})

describe("DemoGitReviewTransport", () => {
  it("supports observation, list, detail, lazy diff, and pathless explanation", async () => {
    const transport = new DemoGitReviewTransport(0)
    const observation = await transport.request(
      gitReviewCommands.observeRepository,
      {
        schemaVersion: gitReviewSchemaVersion,
        clientRequestId: "observe-demo",
        workspaceId: "workspace-demo",
        workspaceGeneration: 1,
        reason: "active_view",
        workUnitId: null,
        sourceEventId: null,
      },
    )
    expect(observation.supportState).toBe("ready")

    const page = await transport.request(gitReviewCommands.listCommitEvidence, {
      schemaVersion: gitReviewSchemaVersion,
      workspaceId: "workspace-demo",
      workspaceGeneration: 1,
      cursor: null,
      limit: 50,
      filter: "all",
      workUnitId: null,
    })
    expect(page.items).toHaveLength(2)
    const current = page.items[0]
    if (current === undefined) throw new Error("Demo commit is missing")

    const detail = await transport.request(
      gitReviewCommands.readCommitEvidence,
      {
        schemaVersion: gitReviewSchemaVersion,
        workspaceId: "workspace-demo",
        workspaceGeneration: 1,
        commitEvidenceId: current.commitEvidenceId,
      },
    )
    const firstFile = detail.files[0]
    if (firstFile === undefined) throw new Error("Demo file is missing")
    await expect(
      transport.request(gitReviewCommands.readCommitDiffFile, {
        schemaVersion: gitReviewSchemaVersion,
        workspaceId: "workspace-demo",
        workspaceGeneration: 1,
        commitEvidenceId: current.commitEvidenceId,
        fileEvidenceId: firstFile.fileEvidenceId,
      }),
    ).resolves.toMatchObject({ relativePath: firstFile.relativePath })

    const evidence = await transport.request(
      gitReviewCommands.prepareCommitExplanationEvidence,
      {
        schemaVersion: gitReviewSchemaVersion,
        workspaceId: "workspace-demo",
        workspaceGeneration: 1,
        commitEvidenceId: current.commitEvidenceId,
        locale: "en",
        selectionVersion: 1,
      },
    )
    expect(JSON.stringify(evidence)).not.toContain("relativePath")
    expect(JSON.stringify(evidence)).not.toContain('"content"')
  })
})
