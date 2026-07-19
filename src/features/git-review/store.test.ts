import { describe, expect, it, vi } from "vitest"

import { DemoGitReviewTransport } from "@/features/git-review/demo-transport"
import { GitReviewStore } from "@/features/git-review/store"
import type { GitReviewTransport } from "@/features/git-review/transport"
import {
  gitReviewCommands,
  type CommitEvidencePage,
  type CommitExplanationController,
  type CommitExplanationControllerStateV1,
  type GitReviewCommand,
  type GitReviewRequestMap,
  type GitReviewResponseMap,
  type ListCommitEvidenceRequest,
} from "@/lib/contracts/git-review"

interface RecordedCall {
  readonly command: GitReviewCommand
  readonly request: unknown
}

class RecordingTransport implements GitReviewTransport {
  readonly kind = "demo"
  readonly calls: RecordedCall[] = []

  constructor(readonly delegate = new DemoGitReviewTransport(0)) {}

  request<K extends GitReviewCommand>(
    command: K,
    request: GitReviewRequestMap[K],
  ): Promise<GitReviewResponseMap[K]> {
    this.calls.push({ command, request })
    return this.delegate.request(command, request)
  }
}

describe("GitReviewStore", () => {
  it("does not observe while hidden and lazily loads only the selected diff", async () => {
    const transport = new RecordingTransport()
    const store = new GitReviewStore("workspace-demo", transport)

    expect(store.snapshot().active).toBe(false)
    expect(transport.calls).toHaveLength(0)
    store.deactivate()
    expect(transport.calls).toHaveLength(0)

    await store.activate()
    expect(store.snapshot()).toMatchObject({
      active: true,
      observationStatus: "ready",
      collectionStatus: "ready",
      detailStatus: "ready",
      diffStatus: "idle",
    })
    expect(transport.calls.map((call) => call.command)).toEqual([
      gitReviewCommands.observeRepository,
      gitReviewCommands.listCommitEvidence,
      gitReviewCommands.readCommitEvidence,
    ])

    const firstFile = store.snapshot().detail?.files[0]
    if (firstFile === undefined) throw new Error("Demo file is missing")
    await store.selectFile(firstFile.fileEvidenceId)
    expect(store.snapshot()).toMatchObject({
      selectedFileEvidenceId: firstFile.fileEvidenceId,
      diffStatus: "ready",
    })
    expect(transport.calls.at(-1)?.command).toBe(
      gitReviewCommands.readCommitDiffFile,
    )
  })

  it("routes user explanation requests only to the app-owned controller", async () => {
    const request = vi.fn<CommitExplanationController["request"]>()
    const cancel = vi.fn<CommitExplanationController["cancel"]>()
    const controller: CommitExplanationController = {
      request,
      cancel,
      present: vi.fn(),
      getState: () => null,
      subscribe: () => () => {},
    }
    const transport = new RecordingTransport()
    const store = new GitReviewStore("workspace-demo", transport, {
      commitExplanationController: controller,
      now: () => new Date("2026-07-18T09:00:00.000Z"),
    })
    await store.activate()

    expect(request).not.toHaveBeenCalled()
    await store.requestExplanation("ja", "user_request")
    expect(request).toHaveBeenCalledOnce()
    const dispatch = request.mock.calls[0]?.[0]
    expect(dispatch?.request).toMatchObject({
      locale: "ja",
      selectionVersion: store.snapshot().selectionVersion,
      trigger: "user_request",
    })
    const serialized = JSON.stringify(dispatch?.evidence)
    expect(serialized).not.toContain("relativePath")
    expect(serialized).not.toContain('"content"')

    const second = store.snapshot().items[1]
    if (second === undefined) throw new Error("Second demo commit is missing")
    await store.selectCommitEvidence(second.commitEvidenceId)
    expect(cancel).not.toHaveBeenCalled()
  })

  it("cancels a running explanation only after the user action", async () => {
    const cancel = vi.fn<CommitExplanationController["cancel"]>()
    const controller: CommitExplanationController = {
      request: vi.fn(),
      cancel,
      present: vi.fn(),
      getState: () => null,
      subscribe: () => () => {},
    }
    const store = new GitReviewStore(
      "workspace-demo",
      new RecordingTransport(),
      {
        commitExplanationController: controller,
        now: () => new Date("2026-07-18T09:00:00.000Z"),
      },
    )
    await store.activate()
    const commitEvidenceId = store.snapshot().selectedCommitEvidenceId
    if (commitEvidenceId === null) throw new Error("Demo commit is missing")
    const state: CommitExplanationControllerStateV1 = {
      schemaVersion: 1,
      workspaceId: "workspace-demo",
      workspaceGeneration: 1,
      commitEvidenceId,
      requestId: "auto-explanation-one",
      locale: "en",
      selectionVersion: store.snapshot().selectionVersion,
      status: "running",
      trigger: "auto_verified_commit",
      retryable: false,
      presentationAvailable: false,
      errorCode: null,
      updatedAt: "2026-07-18T09:00:00.000Z",
    }

    await store.cancelExplanation(state)
    expect(cancel).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "auto-explanation-one",
        reason: "user",
      }),
    )
  })

  it("rejects cancel and presentation actions from a stale selection version", async () => {
    const cancel = vi.fn<CommitExplanationController["cancel"]>()
    const present = vi.fn<CommitExplanationController["present"]>()
    const controller: CommitExplanationController = {
      request: vi.fn(),
      cancel,
      present,
      getState: () => null,
      subscribe: () => () => {},
    }
    const store = new GitReviewStore(
      "workspace-demo",
      new RecordingTransport(),
      { commitExplanationController: controller },
    )
    await store.activate()
    const commitEvidenceId = store.snapshot().selectedCommitEvidenceId
    if (commitEvidenceId === null) throw new Error("Demo commit is missing")
    const stale: CommitExplanationControllerStateV1 = {
      schemaVersion: 1,
      workspaceId: "workspace-demo",
      workspaceGeneration: 1,
      commitEvidenceId,
      requestId: "stale-selection",
      locale: "en",
      selectionVersion: store.snapshot().selectionVersion + 1,
      status: "running",
      trigger: "user_request",
      retryable: false,
      presentationAvailable: false,
      errorCode: null,
      updatedAt: "2026-07-18T09:00:00.000Z",
    }

    await store.cancelExplanation(stale)
    await store.presentExplanation(
      { ...stale, status: "generated", presentationAvailable: true },
      "show",
    )
    expect(cancel).not.toHaveBeenCalled()
    expect(present).not.toHaveBeenCalled()
  })

  it("discards a presentation failure after the commit selection changes", async () => {
    let rejectPresentation: ((error: Error) => void) | undefined
    const presentation = new Promise<void>((_resolve, reject) => {
      rejectPresentation = reject
    })
    let controllerState: CommitExplanationControllerStateV1 | null = null
    const controller: CommitExplanationController = {
      request: vi.fn(),
      cancel: vi.fn(),
      present: vi.fn(() => presentation),
      getState: () => controllerState,
      subscribe: () => () => {},
    }
    const store = new GitReviewStore(
      "workspace-demo",
      new RecordingTransport(),
      { commitExplanationController: controller },
    )
    await store.activate()
    const [current, previous] = store.snapshot().items
    if (current === undefined || previous === undefined) {
      throw new Error("Demo commits are missing")
    }
    controllerState = {
      schemaVersion: 1,
      workspaceId: "workspace-demo",
      workspaceGeneration: 1,
      commitEvidenceId: current.commitEvidenceId,
      requestId: "presentation-one",
      locale: "en",
      selectionVersion: store.snapshot().selectionVersion,
      status: "generated",
      trigger: "auto_verified_commit",
      retryable: false,
      presentationAvailable: true,
      errorCode: null,
      updatedAt: "2026-07-18T09:00:00.000Z",
    }

    const stale = store.presentExplanation(controllerState, "show")
    await Promise.resolve()
    await store.selectCommitEvidence(previous.commitEvidenceId)
    rejectPresentation?.(new Error("stale presentation failed"))
    await stale

    expect(store.snapshot()).toMatchObject({
      selectedCommitEvidenceId: previous.commitEvidenceId,
      explanation: { status: "idle", requestId: null, error: null },
    })
  })

  it("discards a presentation failure after the controller request changes", async () => {
    let rejectPresentation: ((error: Error) => void) | undefined
    const presentation = new Promise<void>((_resolve, reject) => {
      rejectPresentation = reject
    })
    let controllerState: CommitExplanationControllerStateV1 | null = null
    const controller: CommitExplanationController = {
      request: vi.fn(),
      cancel: vi.fn(),
      present: vi.fn(() => presentation),
      getState: () => controllerState,
      subscribe: () => () => {},
    }
    const store = new GitReviewStore(
      "workspace-demo",
      new RecordingTransport(),
      { commitExplanationController: controller },
    )
    await store.activate()
    const commitEvidenceId = store.snapshot().selectedCommitEvidenceId
    if (commitEvidenceId === null) throw new Error("Demo commit is missing")
    controllerState = {
      schemaVersion: 1,
      workspaceId: "workspace-demo",
      workspaceGeneration: 1,
      commitEvidenceId,
      requestId: "presentation-one",
      locale: "en",
      selectionVersion: store.snapshot().selectionVersion,
      status: "generated",
      trigger: "auto_verified_commit",
      retryable: false,
      presentationAvailable: true,
      errorCode: null,
      updatedAt: "2026-07-18T09:00:00.000Z",
    }

    const stale = store.presentExplanation(controllerState, "show")
    await Promise.resolve()
    controllerState = { ...controllerState, requestId: "presentation-two" }
    rejectPresentation?.(new Error("superseded presentation failed"))
    await stale

    expect(store.snapshot().explanation).toEqual({
      status: "idle",
      requestId: null,
      error: null,
    })
  })

  it("discards a stale detail response after a rapid selection change", async () => {
    const delegate = new DemoGitReviewTransport(0)
    let release: (() => void) | undefined
    const delayed = new Promise<void>((resolve) => {
      release = resolve
    })
    const transport: GitReviewTransport = {
      kind: "demo",
      async request<K extends GitReviewCommand>(
        command: K,
        request: GitReviewRequestMap[K],
      ): Promise<GitReviewResponseMap[K]> {
        if (
          command === gitReviewCommands.readCommitEvidence &&
          (
            request as GitReviewRequestMap["read_commit_evidence"]
          ).commitEvidenceId.endsWith("b".repeat(40))
        ) {
          await delayed
        }
        return delegate.request(command, request)
      },
    }
    const store = new GitReviewStore("workspace-demo", transport)
    await store.activate()
    const [current, previous] = store.snapshot().items
    if (current === undefined || previous === undefined) {
      throw new Error("Demo commits are missing")
    }

    const stale = store.selectCommitEvidence(previous.commitEvidenceId)
    await Promise.resolve()
    await store.selectCommitEvidence(current.commitEvidenceId)
    release?.()
    await stale

    expect(store.snapshot().selectedCommitEvidenceId).toBe(
      current.commitEvidenceId,
    )
    expect(store.snapshot().detail?.commitEvidenceId).toBe(
      current.commitEvidenceId,
    )
  })

  it("clears a missing selection on refresh without choosing a replacement", async () => {
    const delegate = new DemoGitReviewTransport(0)
    let omitSelected = false
    const transport: GitReviewTransport = {
      kind: "demo",
      async request<K extends GitReviewCommand>(
        command: K,
        request: GitReviewRequestMap[K],
      ): Promise<GitReviewResponseMap[K]> {
        if (command === gitReviewCommands.listCommitEvidence && omitSelected) {
          const page = await delegate.request(
            gitReviewCommands.listCommitEvidence,
            request as ListCommitEvidenceRequest,
          )
          const withoutSelected: CommitEvidencePage = {
            ...page,
            items: page.items.slice(1),
          }
          return withoutSelected as GitReviewResponseMap[K]
        }
        return delegate.request(command, request)
      },
    }
    const store = new GitReviewStore("workspace-demo", transport)
    await store.activate()
    expect(store.snapshot().selectedCommitEvidenceId).not.toBeNull()

    omitSelected = true
    await store.refresh()
    expect(store.snapshot().items).toHaveLength(1)
    expect(store.snapshot().selectedCommitEvidenceId).toBeNull()
    expect(store.snapshot().detail).toBeNull()
  })

  it("keeps an empty filtered page reachable when an earlier cursor exists", async () => {
    const delegate = new DemoGitReviewTransport(0)
    const transport: GitReviewTransport = {
      kind: "demo",
      async request<K extends GitReviewCommand>(
        command: K,
        request: GitReviewRequestMap[K],
      ): Promise<GitReviewResponseMap[K]> {
        if (command === gitReviewCommands.listCommitEvidence) {
          const listRequest = request as ListCommitEvidenceRequest
          if (listRequest.cursor === null) {
            return {
              schemaVersion: 1,
              items: [],
              nextCursor: "offset-50",
            } as unknown as GitReviewResponseMap[K]
          }
        }
        return delegate.request(command, request)
      },
    }
    const store = new GitReviewStore("workspace-demo", transport)

    await store.activate()
    expect(store.snapshot()).toMatchObject({
      collectionStatus: "ready",
      items: [],
      nextCursor: "offset-50",
    })

    await store.loadMore()
    expect(store.snapshot().collectionStatus).toBe("ready")
    expect(store.snapshot().items.length).toBeGreaterThan(0)
  })
})
