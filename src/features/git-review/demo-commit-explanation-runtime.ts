import {
  parseCommitNarrationConsumerEvent,
  type CommitNarrationConsumerEventV1,
  type CommitNarrationConsumerPort,
  type CommitNarrationSourceKey,
} from "@/features/narration/contracts"
import {
  CommitExplanationBoundaryError,
  type CommitExplanationAppRuntime,
  type CommitExplanationPresentationActivator,
} from "@/features/git-review/commit-explanation-adapter"
import { demoCurrentCommitEvidenceId } from "@/features/git-review/demo-transport"
import {
  commitExplanationCommands,
  createCommitExplanationCancelRequested,
  createCommitExplanationDispatch,
  createCommitExplanationPresentationRequested,
  createCommitExplanationRequested,
  createCommitExplanationScopeRequested,
  createCommitExplanationStateRequested,
  gitReviewSchemaVersion,
  parseCommitExplanationControllerState,
  parseCommitExplanationPresentation,
  type CommitExplanationCancelRequestedV1,
  type CommitExplanationControllerStateV1,
  type CommitExplanationDispatchV1,
  type CommitExplanationPresentationRequestedV1,
  type CommitExplanationPresentationV1,
  type CommitExplanationRequestedV1,
  type CommitExplanationScopeRequestedV1,
} from "@/lib/contracts/git-review"

type TimerHandle = ReturnType<typeof setTimeout>

interface ActiveRequest {
  readonly request: CommitExplanationRequestedV1
  readonly scopeEpoch: number
}

export interface DemoCommitExplanationRuntimeOptions {
  readonly runningDelayMs?: number
  readonly generatedDelayMs?: number
  readonly now?: () => Date
}

const defaultRunningDelayMs = 90
const defaultGeneratedDelayMs = 220

function stateKey(
  workspaceId: string,
  workspaceGeneration: number,
  commitEvidenceId: string,
): string {
  return JSON.stringify([workspaceId, workspaceGeneration, commitEvidenceId])
}

function sameScope(
  left: CommitExplanationScopeRequestedV1 | null,
  right: CommitExplanationScopeRequestedV1,
): boolean {
  return (
    left?.workspaceId === right.workspaceId &&
    left.workspaceGeneration === right.workspaceGeneration &&
    left.locale === right.locale
  )
}

function fullCommitSha(commitEvidenceId: string): string | null {
  const value = commitEvidenceId.startsWith("commit-")
    ? commitEvidenceId.slice("commit-".length)
    : ""
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value) ? value : null
}

function boundaryError(
  code: string,
  operation: string,
  recoverable: boolean,
): CommitExplanationBoundaryError {
  return new CommitExplanationBoundaryError({
    code,
    operation,
    recoverable,
    userMessageKey: "gitReview.error.commitExplanation",
  })
}

function runPromiseBoundary(action: () => void): Promise<void> {
  try {
    action()
    return Promise.resolve()
  } catch (error) {
    return Promise.reject(
      error instanceof Error
        ? error
        : new Error("Commit explanation demo boundary failed"),
    )
  }
}

function explanationFor(
  locale: "ja" | "en",
): CommitExplanationPresentationV1["explanation"] {
  if (locale === "ja") {
    return {
      schemaVersion: gitReviewSchemaVersion,
      locale,
      summary:
        "このコミットは、検証済みの作業を読み取り専用の証跡として確認できるようにします。",
      changes: [
        "コミットの識別情報、変更要約、検証結果を一つの画面にまとめました。",
      ],
      reasons: [
        "メインの作業履歴を変更せず、完成した変更の意図を確認できるようにするためです。",
      ],
      verification: [
        "型検査と対象テストを通過した結果がコミット証跡に関連付けられています。",
      ],
      impact: [
        "利用者は変更内容と検証状況をチャット履歴とは独立して確認できます。",
      ],
      cautions: [
        "説明の生成結果は補助情報であり、表示中もGitやメインセッションへ書き込みません。",
      ],
      howToReadNext: [
        "変更タブで対象ファイルを選び、必要な差分だけを確認してください。",
      ],
      narrationChunks: [
        {
          sequence: 1,
          section: "summary",
          text: "このコミットは、検証済みの作業を読み取り専用の証跡として確認できるようにします。",
        },
        {
          sequence: 2,
          section: "verification",
          text: "型検査と対象テストを通過した結果が、コミット証跡に関連付けられています。",
        },
        {
          sequence: 3,
          section: "howToReadNext",
          text: "変更タブで対象ファイルを選び、必要な差分だけを確認してください。",
        },
      ],
    }
  }

  return {
    schemaVersion: gitReviewSchemaVersion,
    locale,
    summary:
      "This commit makes verified work understandable through read-only evidence.",
    changes: [
      "It brings commit identity, change summaries, and verification results into one view.",
    ],
    reasons: [
      "The evidence explains completed work without changing the main session history.",
    ],
    verification: [
      "The commit evidence correlates successful type checks and focused tests.",
    ],
    impact: [
      "People can inspect the change and its verification independently from chat history.",
    ],
    cautions: [
      "The explanation is supporting information and never writes to Git or the main session.",
    ],
    howToReadNext: [
      "Open Changes, select a file, and inspect only the diff you need.",
    ],
    narrationChunks: [
      {
        sequence: 1,
        section: "summary",
        text: "This commit makes verified work understandable through read-only evidence.",
      },
      {
        sequence: 2,
        section: "verification",
        text: "The commit evidence correlates successful type checks and focused tests.",
      },
      {
        sequence: 3,
        section: "howToReadNext",
        text: "Open Changes, select a file, and inspect only the diff you need.",
      },
    ],
  }
}

/**
 * Deterministic, development-only support fixture. App composition owns the
 * explicit query gate; this runtime itself has no native, Git, or history port.
 */
export class DemoCommitExplanationRuntime implements CommitExplanationAppRuntime {
  readonly #states = new Map<string, CommitExplanationControllerStateV1>()
  readonly #stateListeners = new Set<() => void>()
  readonly #narrationListeners = new Set<(event: unknown) => void>()
  readonly #timers = new Set<TimerHandle>()
  readonly #generationHighWater = new Map<string, number>()
  readonly #runningDelayMs: number
  readonly #generatedDelayMs: number
  readonly #now: () => Date
  #scope: CommitExplanationScopeRequestedV1 | null = null
  #scopeEpoch = 0
  #requestSequence = 0
  #activeRequest: ActiveRequest | null = null
  #started = false
  #presentationActivator: CommitExplanationPresentationActivator | null = null

  readonly narrationSource: CommitNarrationConsumerPort = {
    subscribe: (listener) => {
      this.#narrationListeners.add(listener)
      return () => this.#narrationListeners.delete(listener)
    },
  }

  constructor(options: DemoCommitExplanationRuntimeOptions = {}) {
    this.#runningDelayMs = Math.max(
      0,
      options.runningDelayMs ?? defaultRunningDelayMs,
    )
    this.#generatedDelayMs = Math.max(
      this.#runningDelayMs,
      options.generatedDelayMs ?? defaultGeneratedDelayMs,
    )
    this.#now = options.now ?? (() => new Date())
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#stateListeners.add(listener)
    return () => this.#stateListeners.delete(listener)
  }

  setPresentationActivator(
    activator: CommitExplanationPresentationActivator | null,
  ): void {
    this.#presentationActivator = activator
  }

  start(): Promise<void> {
    this.#started = true
    this.resumeActiveRequest()
    return Promise.resolve()
  }

  dispose(): void {
    this.#started = false
    this.clearTimers()
  }

  setScope(scopeValue: CommitExplanationScopeRequestedV1): Promise<void> {
    return runPromiseBoundary(() => {
      const scope = createCommitExplanationScopeRequested(scopeValue)
      const highest = this.#generationHighWater.get(scope.workspaceId)
      if (highest !== undefined && scope.workspaceGeneration < highest) {
        throw boundaryError(
          "CODEX-SUPPORT-WORKSPACE-STALE",
          commitExplanationCommands.setScope,
          false,
        )
      }
      if (sameScope(this.#scope, scope)) {
        this.resumeActiveRequest()
        return
      }

      this.#generationHighWater.set(
        scope.workspaceId,
        scope.workspaceGeneration,
      )
      this.clearTimers()
      const scopeEpoch = ++this.#scopeEpoch
      this.#scope = scope
      const request = createCommitExplanationRequested({
        schemaVersion: gitReviewSchemaVersion,
        requestId: `demo-auto-${scope.workspaceGeneration}-${++this.#requestSequence}`,
        workspaceId: scope.workspaceId,
        workspaceGeneration: scope.workspaceGeneration,
        commitEvidenceId: demoCurrentCommitEvidenceId,
        locale: scope.locale,
        selectionVersion: 1,
        trigger: "auto_verified_commit",
        requestedAt: this.timestamp(),
      })
      this.beginRequest(request, scopeEpoch)
    })
  }

  readonly request = (
    dispatchValue: CommitExplanationDispatchV1,
  ): Promise<void> => {
    return runPromiseBoundary(() => {
      const dispatch = createCommitExplanationDispatch(dispatchValue)
      if (dispatch.request.trigger === "auto_verified_commit") {
        throw boundaryError(
          "CODEX-SUPPORT-AUTO-TRIGGER-FORBIDDEN",
          commitExplanationCommands.request,
          false,
        )
      }
      if (!this.requestMatchesScope(dispatch.request)) {
        throw boundaryError(
          "CODEX-SUPPORT-WORKSPACE-STALE",
          commitExplanationCommands.request,
          true,
        )
      }

      const existing = this.#states.get(
        stateKey(
          dispatch.request.workspaceId,
          dispatch.request.workspaceGeneration,
          dispatch.request.commitEvidenceId,
        ),
      )
      if (existing?.status === "generated") {
        this.clearTimers()
        this.#activeRequest = null
        this.applyState(this.stateFor(dispatch.request, "generated"))
        return
      }
      this.clearTimers()
      this.beginRequest(dispatch.request, this.#scopeEpoch)
    })
  }

  readonly cancel = (
    requestValue: CommitExplanationCancelRequestedV1,
  ): Promise<void> => {
    return runPromiseBoundary(() => {
      const request = createCommitExplanationCancelRequested(requestValue)
      const active = this.#activeRequest
      const state =
        active === null
          ? undefined
          : this.#states.get(
              stateKey(
                active.request.workspaceId,
                active.request.workspaceGeneration,
                active.request.commitEvidenceId,
              ),
            )
      if (
        active === null ||
        state === undefined ||
        active.request.requestId !== request.requestId ||
        active.request.workspaceGeneration !== request.workspaceGeneration ||
        active.request.selectionVersion !== request.selectionVersion ||
        (state.status !== "queued" && state.status !== "running")
      ) {
        throw boundaryError(
          "CODEX-SUPPORT-CANCEL-STALE",
          commitExplanationCommands.cancel,
          true,
        )
      }
      this.clearTimers()
      this.#activeRequest = null
      this.applyState(
        this.stateFor(active.request, "canceled", "CODEX-SUPPORT-CANCELED"),
      )
    })
  }

  readonly present = (
    requestValue: CommitExplanationPresentationRequestedV1,
  ): Promise<void> => {
    return runPromiseBoundary(() => {
      const request = createCommitExplanationPresentationRequested(requestValue)
      const scope = this.#scope
      const state = this.#states.get(
        stateKey(
          request.workspaceId,
          request.workspaceGeneration,
          request.commitEvidenceId,
        ),
      )
      if (
        scope === null ||
        state === undefined ||
        scope.workspaceId !== request.workspaceId ||
        scope.workspaceGeneration !== request.workspaceGeneration ||
        state.status !== "generated" ||
        !state.presentationAvailable ||
        state.requestId !== request.requestId ||
        state.locale !== scope.locale ||
        state.locale === null ||
        state.selectionVersion === null ||
        state.trigger === null
      ) {
        throw boundaryError(
          "CODEX-SUPPORT-PRESENTATION-STALE",
          commitExplanationCommands.present,
          true,
        )
      }

      const presentation = parseCommitExplanationPresentation({
        schemaVersion: gitReviewSchemaVersion,
        workspaceId: request.workspaceId,
        workspaceGeneration: request.workspaceGeneration,
        commitEvidenceId: request.commitEvidenceId,
        requestId: request.requestId,
        selectionVersion: state.selectionVersion,
        trigger: state.trigger,
        locale: state.locale,
        mode: request.mode,
        explanation: explanationFor(state.locale),
        usage: { inputTokens: 384, outputTokens: 146, totalTokens: 530 },
        latencyMs: this.#generatedDelayMs,
        presentedAt: this.timestamp(),
      })
      this.publishPresentation(presentation)
    })
  }

  readonly getState = (
    workspaceId: string,
    workspaceGeneration: number,
    commitEvidenceId: string,
  ): CommitExplanationControllerStateV1 | null => {
    try {
      createCommitExplanationStateRequested({
        schemaVersion: gitReviewSchemaVersion,
        workspaceId,
        workspaceGeneration,
        commitEvidenceId,
      })
    } catch {
      return null
    }
    const key = stateKey(workspaceId, workspaceGeneration, commitEvidenceId)
    const existing = this.#states.get(key)
    if (existing !== undefined) return existing
    const state = parseCommitExplanationControllerState({
      schemaVersion: gitReviewSchemaVersion,
      workspaceId,
      workspaceGeneration,
      commitEvidenceId,
      requestId: null,
      locale: null,
      selectionVersion: null,
      status: "not_generated",
      trigger: null,
      retryable: false,
      presentationAvailable: false,
      errorCode: null,
      updatedAt: this.timestamp(),
    })
    this.#states.set(key, state)
    return state
  }

  private timestamp(): string {
    return this.#now().toISOString()
  }

  private requestMatchesScope(request: CommitExplanationRequestedV1): boolean {
    return (
      this.#scope?.workspaceId === request.workspaceId &&
      this.#scope.workspaceGeneration === request.workspaceGeneration &&
      this.#scope.locale === request.locale
    )
  }

  private beginRequest(
    request: CommitExplanationRequestedV1,
    scopeEpoch: number,
  ): void {
    this.#activeRequest = { request, scopeEpoch }
    this.applyState(this.stateFor(request, "queued"))
    this.resumeActiveRequest()
  }

  private resumeActiveRequest(): void {
    const active = this.#activeRequest
    if (!this.#started || active === null || this.#timers.size > 0) return
    const state = this.#states.get(
      stateKey(
        active.request.workspaceId,
        active.request.workspaceGeneration,
        active.request.commitEvidenceId,
      ),
    )
    if (state?.status === "queued") {
      this.schedule(this.#runningDelayMs, () => {
        if (!this.isActive(active)) return
        this.applyState(this.stateFor(active.request, "running"))
      })
      this.schedule(this.#generatedDelayMs, () => {
        this.finishRequest(active)
      })
    } else if (state?.status === "running") {
      this.schedule(
        Math.max(0, this.#generatedDelayMs - this.#runningDelayMs),
        () => this.finishRequest(active),
      )
    }
  }

  private finishRequest(active: ActiveRequest): void {
    if (!this.isActive(active)) return
    this.#activeRequest = null
    this.applyState(this.stateFor(active.request, "generated"))
  }

  private isActive(active: ActiveRequest): boolean {
    return (
      this.#started &&
      this.#activeRequest === active &&
      this.#scopeEpoch === active.scopeEpoch &&
      this.requestMatchesScope(active.request)
    )
  }

  private stateFor(
    request: CommitExplanationRequestedV1,
    status: "queued" | "running" | "generated" | "canceled",
    errorCode: string | null = null,
  ): CommitExplanationControllerStateV1 {
    return parseCommitExplanationControllerState({
      schemaVersion: gitReviewSchemaVersion,
      workspaceId: request.workspaceId,
      workspaceGeneration: request.workspaceGeneration,
      commitEvidenceId: request.commitEvidenceId,
      requestId: request.requestId,
      locale: request.locale,
      selectionVersion: request.selectionVersion,
      status,
      trigger: request.trigger,
      retryable: status === "canceled",
      presentationAvailable: status === "generated",
      errorCode,
      updatedAt: this.timestamp(),
    })
  }

  private applyState(state: CommitExplanationControllerStateV1): void {
    this.#states.set(
      stateKey(
        state.workspaceId,
        state.workspaceGeneration,
        state.commitEvidenceId,
      ),
      state,
    )
    for (const listener of [...this.#stateListeners]) {
      try {
        listener()
      } catch {
        // A demo view subscriber cannot interrupt the deterministic fixture.
      }
    }
  }

  private schedule(delayMs: number, action: () => void): void {
    const timer = setTimeout(() => {
      this.#timers.delete(timer)
      action()
    }, delayMs)
    this.#timers.add(timer)
  }

  private clearTimers(): void {
    for (const timer of this.#timers) clearTimeout(timer)
    this.#timers.clear()
  }

  private publishPresentation(
    presentation: CommitExplanationPresentationV1,
  ): void {
    const commitSha = fullCommitSha(presentation.commitEvidenceId)
    if (commitSha === null) return
    const base = {
      schemaVersion: gitReviewSchemaVersion,
      source: "background_support" as const,
      trigger: presentation.trigger,
      workspaceId: presentation.workspaceId,
      workspaceGeneration: presentation.workspaceGeneration,
      commitSha,
      requestId: presentation.requestId,
      locale: presentation.locale,
    }
    const events: CommitNarrationConsumerEventV1[] = [
      parseCommitNarrationConsumerEvent({ ...base, kind: "started" }),
      ...presentation.explanation.narrationChunks.map((chunk) =>
        parseCommitNarrationConsumerEvent({
          ...base,
          kind: "chunk",
          sequence: chunk.sequence - 1,
          text: chunk.text,
        }),
      ),
      parseCommitNarrationConsumerEvent({
        ...base,
        kind: "terminal",
        status: "completed",
        errorCode: null,
      }),
    ]
    for (const event of events) {
      for (const listener of [...this.#narrationListeners]) {
        try {
          listener(event)
        } catch {
          // A narration subscriber cannot corrupt deterministic delivery.
        }
      }
    }

    const activator = this.#presentationActivator
    if (activator === null) return
    const key: CommitNarrationSourceKey = {
      workspaceId: presentation.workspaceId,
      workspaceGeneration: presentation.workspaceGeneration,
      commitSha,
      requestId: presentation.requestId,
      locale: presentation.locale,
    }
    try {
      void Promise.resolve(activator(key)).catch(() => undefined)
    } catch {
      // Presentation activation cannot break the demo runtime boundary.
    }
  }
}
