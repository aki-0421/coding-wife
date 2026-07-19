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
  type CommitExplanationPresentationRevokeReason,
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
  request: CommitExplanationRequestedV1
  readonly timers: Set<TimerHandle>
}

interface PresentationIntent {
  readonly epoch: number
  readonly request: CommitExplanationRequestedV1
  readonly commitSha: string
  readonly mode: CommitExplanationPresentationV1["mode"]
  readonly issuedAt: number
  presented: boolean
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
  locale: "ja" | "en",
): string {
  return JSON.stringify([
    workspaceId,
    workspaceGeneration,
    commitEvidenceId,
    locale,
  ])
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
export class DemoCommitExplanationRuntime
  implements CommitExplanationAppRuntime
{
  readonly #states = new Map<string, CommitExplanationControllerStateV1>()
  readonly #stateListeners = new Set<() => void>()
  readonly #narrationListeners = new Set<(event: unknown) => void>()
  readonly #timers = new Set<TimerHandle>()
  readonly #activeRequests = new Map<string, ActiveRequest>()
  readonly #generationHighWater = new Map<string, number>()
  readonly #runningDelayMs: number
  readonly #generatedDelayMs: number
  readonly #now: () => Date
  #scope: CommitExplanationScopeRequestedV1 | null = null
  #requestSequence = 0
  #started = false
  #presentationActivator: CommitExplanationPresentationActivator | null = null
  #presentationIntentEpoch = 0
  #presentationIntent: PresentationIntent | null = null

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
    this.resumeActiveRequests()
    return Promise.resolve()
  }

  dispose(): void {
    this.revokePresentationIntent("dispose")
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
        this.resumeActiveRequests()
        return
      }

      this.#generationHighWater.set(
        scope.workspaceId,
        scope.workspaceGeneration,
      )
      this.revokePresentationIntent("scope_change")
      this.#scope = scope
      const key = stateKey(
        scope.workspaceId,
        scope.workspaceGeneration,
        demoCurrentCommitEvidenceId,
        scope.locale,
      )
      const existing = this.#states.get(key)
      if (existing !== undefined) {
        this.resumeActiveRequests()
        return
      }
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
      this.beginRequest(request)
    })
  }

  revokePresentationIntent(
    reason: CommitExplanationPresentationRevokeReason,
  ): void {
    void reason
    ++this.#presentationIntentEpoch
    this.#presentationIntent = null
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
      this.issuePresentationIntent(dispatch.request, "show")

      const existing = this.#states.get(
        stateKey(
          dispatch.request.workspaceId,
          dispatch.request.workspaceGeneration,
          dispatch.request.commitEvidenceId,
          dispatch.request.locale,
        ),
      )
      if (existing?.status === "generated") {
        this.applyState(this.stateFor(dispatch.request, "generated"))
        return
      }
      if (existing?.status === "queued" || existing?.status === "running") {
        const key = this.requestKey(dispatch.request)
        const active = this.#activeRequests.get(key)
        if (active !== undefined) active.request = dispatch.request
        this.applyState(this.stateFor(dispatch.request, existing.status))
        this.resumeActiveRequests()
        return
      }
      if (
        existing !== undefined &&
        existing.status !== "not_generated" &&
        dispatch.request.trigger !== "user_retry"
      ) {
        this.applyState({
          ...existing,
          requestId: dispatch.request.requestId,
          locale: dispatch.request.locale,
          selectionVersion: dispatch.request.selectionVersion,
          trigger: dispatch.request.trigger,
          updatedAt: this.timestamp(),
        })
        return
      }
      this.beginRequest(dispatch.request)
    })
  }

  readonly cancel = (
    requestValue: CommitExplanationCancelRequestedV1,
  ): Promise<void> => {
    return runPromiseBoundary(() => {
      const request = createCommitExplanationCancelRequested(requestValue)
      const active = [...this.#activeRequests.values()].find(
        (candidate) =>
          candidate.request.requestId === request.requestId &&
          candidate.request.workspaceGeneration ===
            request.workspaceGeneration &&
          candidate.request.selectionVersion === request.selectionVersion,
      )
      const state =
        active === undefined
          ? undefined
          : this.#states.get(
              stateKey(
                active.request.workspaceId,
                active.request.workspaceGeneration,
                active.request.commitEvidenceId,
                active.request.locale,
              ),
            )
      if (
        active === undefined ||
        state === undefined ||
        (state.status !== "queued" && state.status !== "running")
      ) {
        throw boundaryError(
          "CODEX-SUPPORT-CANCEL-STALE",
          commitExplanationCommands.cancel,
          true,
        )
      }
      this.clearRequestTimers(active)
      this.#activeRequests.delete(this.requestKey(active.request))
      if (this.#presentationIntent?.request.requestId === request.requestId) {
        this.revokePresentationIntent("close")
      }
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
          scope?.locale ?? "ja",
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
      this.issuePresentationIntent(
        createCommitExplanationRequested({
          schemaVersion: gitReviewSchemaVersion,
          requestId: state.requestId,
          workspaceId: state.workspaceId,
          workspaceGeneration: state.workspaceGeneration,
          commitEvidenceId: state.commitEvidenceId,
          locale: state.locale,
          selectionVersion: state.selectionVersion,
          trigger: state.trigger,
          requestedAt: request.requestedAt,
        }),
        request.mode,
      )
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
    const scope = this.#scope
    if (
      scope === null ||
      scope.workspaceId !== workspaceId ||
      scope.workspaceGeneration !== workspaceGeneration
    ) {
      return null
    }
    const key = stateKey(
      workspaceId,
      workspaceGeneration,
      commitEvidenceId,
      scope.locale,
    )
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

  private issuePresentationIntent(
    request: CommitExplanationRequestedV1,
    mode: CommitExplanationPresentationV1["mode"],
  ): PresentationIntent {
    const commitSha = fullCommitSha(request.commitEvidenceId)
    if (commitSha === null) {
      throw boundaryError(
        "CODEX-SUPPORT-PRESENTATION-STALE",
        commitExplanationCommands.present,
        false,
      )
    }
    const parsedIssuedAt = Date.parse(request.requestedAt)
    const intent: PresentationIntent = {
      epoch: ++this.#presentationIntentEpoch,
      request,
      commitSha,
      mode,
      issuedAt: Number.isFinite(parsedIssuedAt)
        ? parsedIssuedAt
        : this.#now().getTime(),
      presented: false,
    }
    this.#presentationIntent = intent
    return intent
  }

  private isPresentationIntentCurrent(intent: PresentationIntent): boolean {
    return (
      this.#presentationIntent === intent &&
      this.#presentationIntentEpoch === intent.epoch
    )
  }

  private intentMatchesState(
    intent: PresentationIntent,
    state: CommitExplanationControllerStateV1,
  ): boolean {
    const request = intent.request
    return (
      state.workspaceId === request.workspaceId &&
      state.workspaceGeneration === request.workspaceGeneration &&
      state.commitEvidenceId === request.commitEvidenceId &&
      state.requestId === request.requestId &&
      state.locale === request.locale &&
      state.selectionVersion === request.selectionVersion &&
      state.trigger === request.trigger
    )
  }

  private presentMatchingIntent(
    state: CommitExplanationControllerStateV1,
  ): void {
    const intent = this.#presentationIntent
    if (
      intent === null ||
      intent.presented ||
      !this.isPresentationIntentCurrent(intent) ||
      !this.intentMatchesState(intent, state)
    ) {
      return
    }
    if (state.status !== "generated" || !state.presentationAvailable) {
      if (
        state.status === "failed" ||
        state.status === "unavailable" ||
        state.status === "canceled"
      ) {
        this.revokePresentationIntent("close")
      }
      return
    }
    this.publishPresentation(this.presentationFor(state, intent.mode))
  }

  private presentationFor(
    state: CommitExplanationControllerStateV1,
    mode: CommitExplanationPresentationV1["mode"],
  ): CommitExplanationPresentationV1 {
    if (
      state.requestId === null ||
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
    return parseCommitExplanationPresentation({
      schemaVersion: gitReviewSchemaVersion,
      workspaceId: state.workspaceId,
      workspaceGeneration: state.workspaceGeneration,
      commitEvidenceId: state.commitEvidenceId,
      requestId: state.requestId,
      selectionVersion: state.selectionVersion,
      trigger: state.trigger,
      locale: state.locale,
      mode,
      explanation: explanationFor(state.locale),
      usage: { inputTokens: 384, outputTokens: 146, totalTokens: 530 },
      latencyMs: this.#generatedDelayMs,
      presentedAt: this.timestamp(),
    })
  }

  private requestMatchesScope(request: CommitExplanationRequestedV1): boolean {
    return (
      this.#scope?.workspaceId === request.workspaceId &&
      this.#scope.workspaceGeneration === request.workspaceGeneration &&
      this.#scope.locale === request.locale
    )
  }

  private requestKey(request: CommitExplanationRequestedV1): string {
    return stateKey(
      request.workspaceId,
      request.workspaceGeneration,
      request.commitEvidenceId,
      request.locale,
    )
  }

  private beginRequest(request: CommitExplanationRequestedV1): void {
    const active: ActiveRequest = { request, timers: new Set() }
    this.#activeRequests.set(this.requestKey(request), active)
    this.applyState(this.stateFor(request, "queued"))
    this.resumeActiveRequest(active)
  }

  private resumeActiveRequests(): void {
    for (const active of this.#activeRequests.values()) {
      this.resumeActiveRequest(active)
    }
  }

  private resumeActiveRequest(active: ActiveRequest): void {
    if (!this.#started || active.timers.size > 0 || !this.isActive(active)) {
      return
    }
    const state = this.#states.get(
      stateKey(
        active.request.workspaceId,
        active.request.workspaceGeneration,
        active.request.commitEvidenceId,
        active.request.locale,
      ),
    )
    if (state?.status === "queued") {
      this.schedule(active, this.#runningDelayMs, () => {
        if (!this.isActive(active)) return
        this.applyState(this.stateFor(active.request, "running"))
      })
      this.schedule(active, this.#generatedDelayMs, () => {
        this.finishRequest(active)
      })
    } else if (state?.status === "running") {
      this.schedule(
        active,
        Math.max(0, this.#generatedDelayMs - this.#runningDelayMs),
        () => this.finishRequest(active),
      )
    }
  }

  private finishRequest(active: ActiveRequest): void {
    if (!this.isActive(active)) return
    this.#activeRequests.delete(this.requestKey(active.request))
    this.applyState(this.stateFor(active.request, "generated"))
  }

  private isActive(active: ActiveRequest): boolean {
    return (
      this.#started &&
      this.#activeRequests.get(this.requestKey(active.request)) === active
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
        state.locale ?? this.#scope?.locale ?? "ja",
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
    this.presentMatchingIntent(state)
  }

  private schedule(
    active: ActiveRequest,
    delayMs: number,
    action: () => void,
  ): void {
    const timer = setTimeout(() => {
      this.#timers.delete(timer)
      active.timers.delete(timer)
      action()
    }, delayMs)
    this.#timers.add(timer)
    active.timers.add(timer)
  }

  private clearRequestTimers(active: ActiveRequest): void {
    for (const timer of active.timers) {
      clearTimeout(timer)
      this.#timers.delete(timer)
    }
    active.timers.clear()
  }

  private clearTimers(): void {
    for (const timer of this.#timers) clearTimeout(timer)
    this.#timers.clear()
    for (const active of this.#activeRequests.values()) {
      active.timers.clear()
    }
  }

  private publishPresentation(
    presentation: CommitExplanationPresentationV1,
  ): void {
    const intent = this.#presentationIntent
    const commitSha = fullCommitSha(presentation.commitEvidenceId)
    const presentedAt = Date.parse(presentation.presentedAt)
    if (
      intent === null ||
      intent.presented ||
      !this.isPresentationIntentCurrent(intent) ||
      commitSha === null ||
      commitSha !== intent.commitSha ||
      presentation.workspaceId !== intent.request.workspaceId ||
      presentation.workspaceGeneration !== intent.request.workspaceGeneration ||
      presentation.commitEvidenceId !== intent.request.commitEvidenceId ||
      presentation.requestId !== intent.request.requestId ||
      presentation.selectionVersion !== intent.request.selectionVersion ||
      presentation.trigger !== intent.request.trigger ||
      presentation.locale !== intent.request.locale ||
      presentation.mode !== intent.mode ||
      !Number.isFinite(presentedAt) ||
      presentedAt < intent.issuedAt ||
      !this.requestMatchesScope(intent.request)
    ) {
      return
    }
    intent.presented = true
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
      if (!this.isPresentationIntentCurrent(intent)) return
      for (const listener of [...this.#narrationListeners]) {
        if (!this.isPresentationIntentCurrent(intent)) return
        try {
          listener(event)
        } catch {
          // A narration subscriber cannot corrupt deterministic delivery.
        }
      }
    }

    const activator = this.#presentationActivator
    if (activator === null || !this.isPresentationIntentCurrent(intent)) return
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
