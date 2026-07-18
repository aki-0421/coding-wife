import { describe, expect, it, vi } from "vitest"

import {
  TauriCommitExplanationAdapter,
  type CommitExplanationEventListener,
  type CommitExplanationInvoker,
} from "@/features/git-review/commit-explanation-adapter"
import {
  commitExplanationCommands,
  commitExplanationEventChannels,
  gitReviewSchemaVersion,
  type CommitExplanationControllerStateV1,
  type CommitExplanationDispatchV1,
  type CommitExplanationPresentationV1,
} from "@/lib/contracts/git-review"

const sha = "a".repeat(40)
const commitEvidenceId = `commit-${sha}`

function dispatch(
  trigger:
    "auto_verified_commit" | "user_request" | "user_retry" = "user_request",
  selectionVersion = 2,
  locale: "ja" | "en" = "ja",
): CommitExplanationDispatchV1 {
  return {
    request: {
      schemaVersion: gitReviewSchemaVersion,
      requestId: `request-${locale}-${selectionVersion}`,
      workspaceId: "workspace-one",
      workspaceGeneration: 3,
      commitEvidenceId,
      locale,
      selectionVersion,
      trigger,
      requestedAt: "2026-07-18T01:00:00.000Z",
    },
    evidence: {
      schemaVersion: gitReviewSchemaVersion,
      commitId: commitEvidenceId,
      subject: "feat: explain a verified commit",
      body: "Keep the support boundary isolated.",
      changes: [
        {
          changeKind: "modified",
          fileCount: 1,
          additions: 8,
          deletions: 2,
          binaryFiles: 0,
        },
      ],
      diffSummary: {
        filesChanged: 1,
        additions: 8,
        deletions: 2,
        binaryFiles: 0,
      },
      verification: [],
      decisions: [],
      risks: [],
      locale,
      workspaceGeneration: 3,
      selectionVersion,
    },
  }
}

function state(
  overrides: Partial<CommitExplanationControllerStateV1> = {},
): CommitExplanationControllerStateV1 {
  return {
    schemaVersion: gitReviewSchemaVersion,
    workspaceId: "workspace-one",
    workspaceGeneration: 3,
    commitEvidenceId,
    requestId: "request-ja-2",
    locale: "ja",
    selectionVersion: 2,
    status: "generated",
    trigger: "user_request",
    retryable: false,
    presentationAvailable: true,
    errorCode: null,
    updatedAt: "2026-07-18T01:00:02.000Z",
    ...overrides,
  }
}

function presentation(
  overrides: Partial<CommitExplanationPresentationV1> = {},
): CommitExplanationPresentationV1 {
  return {
    schemaVersion: gitReviewSchemaVersion,
    workspaceId: "workspace-one",
    workspaceGeneration: 3,
    commitEvidenceId,
    requestId: "request-ja-2",
    selectionVersion: 2,
    trigger: "user_request",
    locale: "ja",
    mode: "show",
    explanation: {
      schemaVersion: gitReviewSchemaVersion,
      locale: "ja",
      summary: "検証済みコミットの説明です。",
      changes: ["読み取り専用の証跡を追加しました。"],
      reasons: ["変更の根拠を確認できるようにするためです。"],
      verification: ["テストが成功しました。"],
      impact: ["コミット画面から確認できます。"],
      cautions: ["既知の注意事項はありません。"],
      howToReadNext: ["検証結果を確認してください。"],
      narrationChunks: [
        { sequence: 1, section: "summary", text: "検証済みです。" },
        { sequence: 2, section: "changes", text: "証跡を追加しました。" },
      ],
    },
    usage: { inputTokens: 80, outputTokens: 30, totalTokens: 110 },
    latencyMs: 240,
    presentedAt: "2026-07-18T01:00:03.000Z",
    ...overrides,
  }
}

class FakeNativeEvents {
  readonly listeners = new Map<string, Set<(payload: unknown) => void>>()
  readonly disposers: Array<ReturnType<typeof vi.fn>> = []

  readonly listen: CommitExplanationEventListener = (channel, listener) => {
    const listeners = this.listeners.get(channel) ?? new Set()
    listeners.add(listener)
    this.listeners.set(channel, listeners)
    const dispose = vi.fn(() => listeners.delete(listener))
    this.disposers.push(dispose)
    return Promise.resolve(dispose)
  }

  emit(channel: string, payload: unknown): void {
    for (const listener of this.listeners.get(channel) ?? []) listener(payload)
  }
}

function adapterHarness(
  response: (
    command: Parameters<CommitExplanationInvoker>[0],
    argument: Parameters<CommitExplanationInvoker>[1],
  ) => unknown = () => null,
) {
  const events = new FakeNativeEvents()
  const invoke = vi.fn<CommitExplanationInvoker>((command, argument) =>
    Promise.resolve(response(command, argument)),
  )
  const adapter = new TauriCommitExplanationAdapter({
    invoke,
    listen: events.listen,
  })
  return { adapter, events, invoke }
}

async function setJapaneseScope(
  adapter: TauriCommitExplanationAdapter,
): Promise<void> {
  await adapter.setScope({
    schemaVersion: gitReviewSchemaVersion,
    workspaceId: "workspace-one",
    workspaceGeneration: 3,
    locale: "ja",
  })
}

describe("TauriCommitExplanationAdapter", () => {
  it("owns exactly two reconnectable native listeners and disposes a pending start", async () => {
    let releaseFirst: (() => void) | undefined
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const events = new FakeNativeEvents()
    let registrations = 0
    const listen = vi.fn<CommitExplanationEventListener>(
      async (channel, listener) => {
        registrations += 1
        if (registrations <= 2) await firstGate
        return events.listen(channel, listener)
      },
    )
    const adapter = new TauriCommitExplanationAdapter({
      invoke: vi.fn<CommitExplanationInvoker>(() => Promise.resolve(null)),
      listen,
    })

    const pending = adapter.start()
    adapter.dispose()
    releaseFirst?.()
    await pending
    expect(events.disposers.slice(0, 2)).toHaveLength(2)
    expect(
      events.disposers
        .slice(0, 2)
        .every((dispose) => dispose.mock.calls.length === 1),
    ).toBe(true)

    await adapter.start()
    expect(listen).toHaveBeenCalledTimes(4)
    adapter.dispose()
    expect(
      events.disposers.every((dispose) => dispose.mock.calls.length === 1),
    ).toBe(true)
  })

  it("rejects the trusted-only auto trigger before invoke and caches user state before resolving", async () => {
    const queued = state({
      status: "queued",
      presentationAvailable: false,
      updatedAt: "2026-07-18T01:00:01.000Z",
    })
    const { adapter, invoke } = adapterHarness((command) =>
      command === commitExplanationCommands.request ? queued : null,
    )
    await setJapaneseScope(adapter)
    vi.mocked(invoke).mockClear()

    await expect(
      adapter.request(dispatch("auto_verified_commit")),
    ).rejects.toMatchObject({
      code: "CODEX-SUPPORT-AUTO-TRIGGER-FORBIDDEN",
    })
    expect(invoke).not.toHaveBeenCalled()

    let observed: CommitExplanationControllerStateV1 | null = null
    adapter.subscribe(() => {
      observed = adapter.getState("workspace-one", 3, commitEvidenceId)
    })
    await adapter.request(dispatch())
    expect(invoke).toHaveBeenCalledWith(commitExplanationCommands.request, {
      dispatch: dispatch(),
    })
    expect(observed).toEqual(queued)
  })

  it("presents a generated cache hit during the first user request", async () => {
    const { adapter, invoke } = adapterHarness((command) => {
      if (command === commitExplanationCommands.request) return state()
      if (command === commitExplanationCommands.present) return presentation()
      return null
    })
    await setJapaneseScope(adapter)
    const narrated: unknown[] = []
    adapter.narrationSource.subscribe((event) => narrated.push(event))
    vi.mocked(invoke).mockClear()

    await adapter.request(dispatch())

    expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
      commitExplanationCommands.request,
      commitExplanationCommands.present,
    ])
    expect(narrated).toEqual([
      expect.objectContaining({ kind: "started", requestId: "request-ja-2" }),
      expect.objectContaining({ kind: "chunk", sequence: 0 }),
      expect.objectContaining({ kind: "chunk", sequence: 1 }),
      expect.objectContaining({ kind: "terminal", status: "completed" }),
    ])
  })

  it("keeps a completed job state but drops presentation that arrives after intent revocation", async () => {
    let resolvePresentation:
      ((value: CommitExplanationPresentationV1) => void) | undefined
    const pendingPresentation = new Promise<CommitExplanationPresentationV1>(
      (resolve) => {
        resolvePresentation = resolve
      },
    )
    const queued = state({
      status: "queued",
      presentationAvailable: false,
      updatedAt: "2026-07-18T01:00:01.000Z",
    })
    const { adapter, events, invoke } = adapterHarness((command) => {
      if (command === commitExplanationCommands.request) return queued
      if (command === commitExplanationCommands.present) {
        return pendingPresentation
      }
      return null
    })
    await adapter.start()
    await setJapaneseScope(adapter)
    const narrated: unknown[] = []
    adapter.narrationSource.subscribe((event) => narrated.push(event))

    await adapter.request(dispatch())
    events.emit(commitExplanationEventChannels.state, state())
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        commitExplanationCommands.present,
        expect.anything(),
      ),
    )
    adapter.revokePresentationIntent("selection_change")
    events.emit(commitExplanationEventChannels.presentation, presentation())
    resolvePresentation?.(presentation())
    await Promise.resolve()
    await Promise.resolve()

    expect(narrated).toEqual([])
    expect(adapter.getState("workspace-one", 3, commitEvidenceId)).toEqual(
      state(),
    )
  })

  it("serializes scope writes, coalesces intermediate desires, and closes the stale event gate", async () => {
    const events = new FakeNativeEvents()
    const scopes: Array<{
      workspaceId: string
      workspaceGeneration: number
      locale: "ja" | "en"
    }> = []
    const releases: Array<(value: null) => void> = []
    const invoke = vi.fn<CommitExplanationInvoker>((command, argument) => {
      if (command !== commitExplanationCommands.setScope) {
        return Promise.resolve(null)
      }
      if (!("request" in argument)) return Promise.resolve(null)
      const request = argument.request
      if (!("locale" in request)) return Promise.resolve(null)
      scopes.push(request)
      return new Promise<null>((resolve) => releases.push(resolve))
    })
    const adapter = new TauriCommitExplanationAdapter({
      invoke,
      listen: events.listen,
    })
    await adapter.start()
    const narrated: unknown[] = []
    adapter.narrationSource.subscribe((event) => narrated.push(event))

    const first = adapter.setScope({
      schemaVersion: 1,
      workspaceId: "workspace-one",
      workspaceGeneration: 3,
      locale: "ja",
    })
    const intermediate = adapter.setScope({
      schemaVersion: 1,
      workspaceId: "workspace-one",
      workspaceGeneration: 3,
      locale: "en",
    })
    const latest = adapter.setScope({
      schemaVersion: 1,
      workspaceId: "workspace-two",
      workspaceGeneration: 1,
      locale: "ja",
    })

    expect(scopes).toEqual([
      expect.objectContaining({ workspaceId: "workspace-one", locale: "ja" }),
    ])
    const stateChanges = vi.fn()
    adapter.subscribe(stateChanges)
    events.emit(commitExplanationEventChannels.state, state())
    events.emit(commitExplanationEventChannels.presentation, presentation())
    expect(stateChanges).not.toHaveBeenCalled()
    expect(narrated).toEqual([])

    releases[0]?.(null)
    await first
    await vi.waitFor(() => expect(scopes).toHaveLength(2))
    expect(scopes[1]).toEqual(
      expect.objectContaining({ workspaceId: "workspace-two", locale: "ja" }),
    )
    expect(scopes).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspaceId: "workspace-one",
          locale: "en",
        }),
      ]),
    )

    releases[1]?.(null)
    await expect(Promise.all([intermediate, latest])).resolves.toEqual([
      undefined,
      undefined,
    ])
    stateChanges.mockClear()
    events.emit(commitExplanationEventChannels.state, state())
    expect(stateChanges).not.toHaveBeenCalled()
    events.emit(
      commitExplanationEventChannels.state,
      state({
        workspaceId: "workspace-two",
        workspaceGeneration: 1,
      }),
    )
    expect(stateChanges).toHaveBeenCalledOnce()
  })

  it("rejects generation rollback before native invoke and retries a failed latest scope without reopening the old gate", async () => {
    let rejectEnglish = true
    const { adapter, events, invoke } = adapterHarness((command, argument) => {
      if (
        command === commitExplanationCommands.setScope &&
        "request" in argument &&
        "locale" in argument.request &&
        argument.request.locale === "en" &&
        rejectEnglish
      ) {
        throw new Error("scope unavailable")
      }
      return null
    })
    await adapter.start()
    await adapter.setScope({
      schemaVersion: 1,
      workspaceId: "workspace-one",
      workspaceGeneration: 4,
      locale: "ja",
    })
    const callsBeforeRollback = vi.mocked(invoke).mock.calls.length
    await expect(
      adapter.setScope({
        schemaVersion: 1,
        workspaceId: "workspace-one",
        workspaceGeneration: 3,
        locale: "ja",
      }),
    ).rejects.toMatchObject({ code: "CODEX-SUPPORT-WORKSPACE-STALE" })
    expect(invoke).toHaveBeenCalledTimes(callsBeforeRollback)

    await expect(
      adapter.setScope({
        schemaVersion: 1,
        workspaceId: "workspace-one",
        workspaceGeneration: 4,
        locale: "en",
      }),
    ).rejects.toMatchObject({ code: "CODEX-SUPPORT-IPC-UNAVAILABLE" })
    const stateChanges = vi.fn()
    adapter.subscribe(stateChanges)
    events.emit(
      commitExplanationEventChannels.state,
      state({ workspaceGeneration: 4 }),
    )
    expect(stateChanges).not.toHaveBeenCalled()

    rejectEnglish = false
    await adapter.setScope({
      schemaVersion: 1,
      workspaceId: "workspace-one",
      workspaceGeneration: 4,
      locale: "en",
    })
    stateChanges.mockClear()
    events.emit(
      commitExplanationEventChannels.state,
      state({
        workspaceGeneration: 4,
        locale: "en",
      }),
    )
    expect(stateChanges).toHaveBeenCalledOnce()
  })

  it("terminates pending scope waiters on dispose and never starts a coalesced native write afterward", async () => {
    let releaseFirst: ((value: null) => void) | undefined
    const scopes: string[] = []
    const invoke = vi.fn<CommitExplanationInvoker>((command, argument) => {
      if (
        command !== commitExplanationCommands.setScope ||
        !("request" in argument) ||
        !("locale" in argument.request)
      ) {
        return Promise.resolve(null)
      }
      scopes.push(argument.request.locale)
      return new Promise<null>((resolve) => {
        releaseFirst = resolve
      })
    })
    const adapter = new TauriCommitExplanationAdapter({ invoke })
    const first = adapter.setScope({
      schemaVersion: 1,
      workspaceId: "workspace-one",
      workspaceGeneration: 3,
      locale: "ja",
    })
    const latest = adapter.setScope({
      schemaVersion: 1,
      workspaceId: "workspace-one",
      workspaceGeneration: 3,
      locale: "en",
    })
    const firstRejection = expect(first).rejects.toMatchObject({
      code: "CODEX-SUPPORT-SCOPE-DISPOSED",
    })
    const latestRejection = expect(latest).rejects.toMatchObject({
      code: "CODEX-SUPPORT-SCOPE-DISPOSED",
    })

    adapter.dispose()
    await firstRejection
    await latestRejection
    releaseFirst?.(null)
    await Promise.resolve()
    await Promise.resolve()
    expect(scopes).toEqual(["ja"])
  })

  it("hydrates getState before subscription and never lets its late snapshot overwrite an event", async () => {
    let resolveSnapshot: ((value: unknown) => void) | undefined
    const snapshot = new Promise<unknown>((resolve) => {
      resolveSnapshot = resolve
    })
    const { adapter, events, invoke } = adapterHarness((command) =>
      command === commitExplanationCommands.getState ? snapshot : null,
    )
    await adapter.start()
    await setJapaneseScope(adapter)

    expect(adapter.getState("workspace-one", 3, commitEvidenceId)).toBeNull()
    expect(invoke).toHaveBeenCalledWith(commitExplanationCommands.getState, {
      request: {
        schemaVersion: gitReviewSchemaVersion,
        workspaceId: "workspace-one",
        workspaceGeneration: 3,
        commitEvidenceId,
      },
    })

    const generated = state()
    events.emit(commitExplanationEventChannels.state, generated)
    resolveSnapshot?.(
      state({
        status: "queued",
        presentationAvailable: false,
        updatedAt: "2026-07-18T01:00:01.000Z",
      }),
    )
    await snapshot
    await Promise.resolve()
    expect(adapter.getState("workspace-one", 3, commitEvidenceId)).toEqual(
      generated,
    )
  })

  it("publishes exact presentation events once and drops stale selection, locale, and malformed events", async () => {
    const englishPresentation = presentation({
      requestId: "request-en-3",
      locale: "en",
      selectionVersion: 3,
      explanation: {
        ...presentation().explanation,
        locale: "en",
        summary: "Verified commit explanation.",
        changes: ["Added read-only evidence."],
        reasons: ["To keep the change auditable."],
        verification: ["Tests passed."],
        impact: ["Available from the commit view."],
        cautions: ["No known caution."],
        howToReadNext: ["Review verification evidence."],
        narrationChunks: [
          { sequence: 1, section: "summary", text: "Verified commit." },
        ],
      },
      presentedAt: "2026-07-18T01:00:08.000Z",
    })
    const { adapter, events } = adapterHarness((command, argument) => {
      if (
        command === commitExplanationCommands.present &&
        "request" in argument &&
        "mode" in argument.request
      ) {
        return argument.request.requestId === "request-en-3"
          ? englishPresentation
          : presentation({ mode: argument.request.mode })
      }
      return null
    })
    const activatePresentation = vi.fn(() => Promise.resolve(true))
    adapter.setPresentationActivator(activatePresentation)
    await adapter.start()
    await setJapaneseScope(adapter)
    events.emit(commitExplanationEventChannels.state, state())
    events.emit(
      commitExplanationEventChannels.state,
      state({
        requestId: "late-selection-one",
        selectionVersion: 1,
        updatedAt: "2026-07-18T01:00:09.000Z",
      }),
    )
    expect(adapter.getState("workspace-one", 3, commitEvidenceId)).toEqual(
      state(),
    )
    const narrated: unknown[] = []
    adapter.narrationSource.subscribe((event) => narrated.push(event))

    const valid = presentation()
    events.emit(commitExplanationEventChannels.presentation, valid)
    events.emit(commitExplanationEventChannels.presentation, valid)
    expect(narrated).toEqual([])
    expect(activatePresentation).not.toHaveBeenCalled()

    await adapter.present({
      schemaVersion: 1,
      workspaceId: "workspace-one",
      workspaceGeneration: 3,
      commitEvidenceId,
      requestId: "request-ja-2",
      mode: "show",
      requestedAt: "2026-07-18T01:00:02.000Z",
    })
    events.emit(commitExplanationEventChannels.presentation, valid)
    expect(narrated).toEqual([
      {
        schemaVersion: 1,
        source: "background_support",
        trigger: "user_request",
        kind: "started",
        workspaceId: "workspace-one",
        workspaceGeneration: 3,
        commitSha: sha,
        requestId: "request-ja-2",
        locale: "ja",
      },
      expect.objectContaining({
        kind: "chunk",
        sequence: 0,
        text: "検証済みです。",
      }),
      expect.objectContaining({
        kind: "chunk",
        sequence: 1,
        text: "証跡を追加しました。",
      }),
      expect.objectContaining({
        kind: "terminal",
        status: "completed",
        errorCode: null,
      }),
    ])
    expect(activatePresentation).toHaveBeenCalledOnce()
    expect(activatePresentation).toHaveBeenCalledWith({
      workspaceId: "workspace-one",
      workspaceGeneration: 3,
      commitSha: sha,
      requestId: "request-ja-2",
      locale: "ja",
    })

    events.emit(
      commitExplanationEventChannels.presentation,
      presentation({
        selectionVersion: 1,
        presentedAt: "2026-07-18T01:00:04.000Z",
      }),
    )
    events.emit(commitExplanationEventChannels.presentation, {
      ...presentation({ presentedAt: "2026-07-18T01:00:05.000Z" }),
      unknown: true,
    })
    expect(narrated).toHaveLength(4)

    await adapter.setScope({
      schemaVersion: gitReviewSchemaVersion,
      workspaceId: "workspace-one",
      workspaceGeneration: 3,
      locale: "en",
    })
    events.emit(
      commitExplanationEventChannels.presentation,
      presentation({ presentedAt: "2026-07-18T01:00:06.000Z" }),
    )
    expect(narrated).toHaveLength(4)

    events.emit(
      commitExplanationEventChannels.state,
      state({
        requestId: "request-en-3",
        locale: "en",
        selectionVersion: 3,
        updatedAt: "2026-07-18T01:00:07.000Z",
      }),
    )
    events.emit(
      commitExplanationEventChannels.presentation,
      englishPresentation,
    )
    expect(narrated).toHaveLength(4)
    await adapter.present({
      schemaVersion: 1,
      workspaceId: "workspace-one",
      workspaceGeneration: 3,
      commitEvidenceId,
      requestId: "request-en-3",
      mode: "show",
      requestedAt: "2026-07-18T01:00:07.000Z",
    })
    expect(narrated.slice(4)).toEqual([
      expect.objectContaining({ kind: "started", locale: "en" }),
      expect.objectContaining({
        kind: "chunk",
        sequence: 0,
        text: "Verified commit.",
      }),
      expect.objectContaining({ kind: "terminal", status: "completed" }),
    ])
    expect(activatePresentation).toHaveBeenCalledTimes(2)
  })

  it("deduplicates the presentation event emitted during the matching present response", async () => {
    const events = new FakeNativeEvents()
    const valid = presentation({
      mode: "replay_narration",
      presentedAt: "2026-07-18T01:00:10.000Z",
    })
    const invoke = vi.fn<CommitExplanationInvoker>((command) => {
      if (command === commitExplanationCommands.present) {
        events.emit(commitExplanationEventChannels.presentation, valid)
        return Promise.resolve(valid)
      }
      return Promise.resolve(null)
    })
    const adapter = new TauriCommitExplanationAdapter({
      invoke,
      listen: events.listen,
    })
    await adapter.start()
    await setJapaneseScope(adapter)
    events.emit(commitExplanationEventChannels.state, state())
    const narrated: unknown[] = []
    adapter.narrationSource.subscribe((event) => narrated.push(event))

    await adapter.present({
      schemaVersion: 1,
      workspaceId: "workspace-one",
      workspaceGeneration: 3,
      commitEvidenceId,
      requestId: "request-ja-2",
      mode: "replay_narration",
      requestedAt: "2026-07-18T01:00:09.000Z",
    })
    expect(narrated).toHaveLength(4)
    expect(vi.mocked(invoke).mock.calls.at(-1)?.[1]).toEqual({
      request: {
        schemaVersion: 1,
        workspaceId: "workspace-one",
        workspaceGeneration: 3,
        commitEvidenceId,
        requestId: "request-ja-2",
        mode: "replay_narration",
        requestedAt: "2026-07-18T01:00:09.000Z",
      },
    })
  })
})
