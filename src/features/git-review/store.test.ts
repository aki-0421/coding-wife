import { describe, expect, it } from "vitest"

import { DemoGitReviewTransport } from "@/features/git-review/demo-transport"
import { GitReviewStore } from "@/features/git-review/store"
import type { GitReviewTransport } from "@/features/git-review/transport"
import {
  gitReviewCommands,
  type GitReviewCommand,
  type GitReviewRequestMap,
  type GitReviewResponseMap,
} from "@/lib/contracts/git-review"

class RecordingTransport implements GitReviewTransport {
  readonly kind = "demo"
  readonly calls: GitReviewCommand[] = []

  constructor(private readonly delegate = new DemoGitReviewTransport(0)) {}

  request<K extends GitReviewCommand>(
    command: K,
    request: GitReviewRequestMap[K],
  ): Promise<GitReviewResponseMap[K]> {
    this.calls.push(command)
    return this.delegate.request(command, request)
  }
}

describe("GitReviewStore", () => {
  it("loads baseline, list, and selected detail without eagerly loading diffs", async () => {
    const transport = new RecordingTransport()
    const store = new GitReviewStore("workspace-demo", transport)

    await store.initialize()

    expect(store.snapshot()).toMatchObject({
      collectionStatus: "ready",
      baselineStatus: "ready",
      detailStatus: "ready",
    })
    expect(store.snapshot().items).toHaveLength(2)
    expect(store.snapshot().detail?.checkpoint.checkpointId).toBe(
      store.snapshot().selectedCheckpointId,
    )
    expect(transport.calls).toContain(gitReviewCommands.inspectBaseline)
    expect(transport.calls).toContain(gitReviewCommands.listReviewPacks)
    expect(transport.calls).toContain(gitReviewCommands.readReviewPack)
    expect(transport.calls).not.toContain(gitReviewCommands.readFileDiff)

    const firstFile = store.snapshot().detail?.manifest[0]
    if (firstFile === undefined) throw new Error("Demo file is missing")
    await store.selectFile(firstFile.fileId)
    expect(store.snapshot()).toMatchObject({
      selectedFileId: firstFile.fileId,
      diffStatus: "ready",
    })
    expect(transport.calls).toContain(gitReviewCommands.readFileDiff)
  })

  it("compares two checkpoints and completes both restore flows", async () => {
    const store = new GitReviewStore(
      "workspace-demo",
      new DemoGitReviewTransport(0),
    )
    await store.initialize()

    await store.compareCheckpoints()
    expect(store.snapshot().compare.status).toBe("ready")
    expect(
      Array.isArray(store.snapshot().compare.result?.verificationChanges),
    ).toBe(true)

    await store.previewRestore("revert_commit", null)
    expect(store.snapshot().restore).toMatchObject({
      kind: "revert_commit",
      status: "ready",
      preview: { status: "ready" },
    })
    await store.cancelRestore()
    expect(store.snapshot().restore.status).toBe("idle")

    await store.previewRestore("recovery_branch", "recovery/store-test")
    await store.confirmRestore()
    expect(store.snapshot().restore).toMatchObject({
      kind: "recovery_branch",
      status: "succeeded",
      result: { createdReference: "refs/heads/recovery/store-test" },
    })
  })

  it("ignores a stale detail response after the selection changes", async () => {
    const delegate = new DemoGitReviewTransport(0)
    let releasePrevious: (() => void) | null = null
    const previousGate = new Promise<void>((resolve) => {
      releasePrevious = resolve
    })
    const transport: GitReviewTransport = {
      kind: "demo",
      async request<K extends GitReviewCommand>(
        command: K,
        request: GitReviewRequestMap[K],
      ): Promise<GitReviewResponseMap[K]> {
        if (
          command === gitReviewCommands.readReviewPack &&
          (request as GitReviewRequestMap["read_git_review_pack"])
            .checkpointId === "checkpoint-git-runtime"
        ) {
          await previousGate
        }
        return delegate.request(command, request)
      },
    }
    const store = new GitReviewStore("workspace-demo", transport)
    await store.initialize()

    const stale = store.selectCheckpoint("checkpoint-git-runtime")
    await Promise.resolve()
    await store.selectCheckpoint("checkpoint-git-review-ui")
    const release = releasePrevious as (() => void) | null
    release?.()
    await stale

    expect(store.snapshot().selectedCheckpointId).toBe(
      "checkpoint-git-review-ui",
    )
    expect(store.snapshot().detail?.checkpoint.checkpointId).toBe(
      "checkpoint-git-review-ui",
    )
  })
})
