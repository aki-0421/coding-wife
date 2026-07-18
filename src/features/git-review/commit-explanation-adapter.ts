import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"

import {
  parseCommitNarrationConsumerEvent,
  type CommitNarrationConsumerPort,
  type CommitNarrationConsumerEventV1,
  type CommitNarrationSourceKey,
} from "@/features/narration/contracts"
import {
  commitExplanationCommands,
  commitExplanationEventChannels,
  createCommitExplanationCancelRequested,
  createCommitExplanationDispatch,
  createCommitExplanationPresentationRequested,
  createCommitExplanationScopeRequested,
  createCommitExplanationStateRequested,
  GitReviewContractError,
  gitReviewSchemaVersion,
  parseCommitExplanationControllerError,
  parseCommitExplanationControllerState,
  parseCommitExplanationPresentation,
  type CommitExplanationCancelRequestedV1,
  type CommitExplanationCommand,
  type CommitExplanationController,
  type CommitExplanationControllerErrorEnvelope,
  type CommitExplanationControllerStateV1,
  type CommitExplanationDispatchV1,
  type CommitExplanationPresentationRequestedV1,
  type CommitExplanationPresentationV1,
  type CommitExplanationScopeRequestedV1,
  type CommitExplanationStateRequestedV1,
} from "@/lib/contracts/git-review"

type StateListener = () => void
type NarrationListener = (event: unknown) => void
type ScopeWaiter = {
  readonly revision: number
  readonly resolve: () => void
  readonly reject: (error: CommitExplanationBoundaryError) => void
}
type ScopeWriter = {
  readonly identity: number
  readonly lifecycleEpoch: number
  readonly operation: Promise<void>
  readonly cancel: () => void
}
type ScopeWriteOutcome =
  | { readonly kind: "response"; readonly value: unknown }
  | { readonly kind: "failure"; readonly error: unknown }
  | { readonly kind: "canceled" }
type PresentationIntent = {
  readonly epoch: number
  readonly workspaceId: string
  readonly workspaceGeneration: number
  readonly commitEvidenceId: string
  readonly commitSha: string
  readonly requestId: string
  readonly selectionVersion: number
  readonly trigger: CommitExplanationPresentationV1["trigger"]
  readonly locale: CommitExplanationPresentationV1["locale"]
  readonly mode: CommitExplanationPresentationV1["mode"]
  readonly issuedAt: number
  presentation: Promise<void> | null
}
type NativeArgument =
  | { readonly dispatch: CommitExplanationDispatchV1 }
  | {
      readonly request:
        | CommitExplanationCancelRequestedV1
        | CommitExplanationPresentationRequestedV1
        | CommitExplanationScopeRequestedV1
        | CommitExplanationStateRequestedV1
    }

export type CommitExplanationInvoker = (
  command: CommitExplanationCommand,
  argument: NativeArgument,
) => Promise<unknown>

export type CommitExplanationEventListener = (
  channel: string,
  listener: (payload: unknown) => void,
) => Promise<() => void>

export interface TauriCommitExplanationAdapterDependencies {
  readonly invoke?: CommitExplanationInvoker
  readonly listen?: CommitExplanationEventListener
}

export interface ScopedCommitExplanationController extends CommitExplanationController {
  setScope(scope: CommitExplanationScopeRequestedV1): Promise<void>
  revokePresentationIntent(
    reason: CommitExplanationPresentationRevokeReason,
  ): void
}

export type CommitExplanationPresentationRevokeReason =
  "scope_change" | "selection_change" | "turn_stop" | "close" | "dispose"

export type CommitExplanationPresentationActivator = (
  key: CommitNarrationSourceKey,
) => boolean | void | Promise<boolean | void>

export interface CommitExplanationAppRuntime extends ScopedCommitExplanationController {
  readonly narrationSource: CommitNarrationConsumerPort
  start(): Promise<void>
  dispose(): void
  setPresentationActivator(
    activator: CommitExplanationPresentationActivator | null,
  ): void
}

export class CommitExplanationBoundaryError
  extends Error
  implements CommitExplanationControllerErrorEnvelope
{
  readonly code: string
  readonly operation: string
  readonly recoverable: boolean
  readonly userMessageKey: string

  constructor(error: CommitExplanationControllerErrorEnvelope) {
    super(error.code)
    this.name = "CommitExplanationBoundaryError"
    this.code = error.code
    this.operation = error.operation
    this.recoverable = error.recoverable
    this.userMessageKey = error.userMessageKey
  }
}

const invokeTauri: CommitExplanationInvoker = (command, argument) =>
  invoke(command, argument)

const listenTauri: CommitExplanationEventListener = async (channel, listener) =>
  listen(channel, (event) => listener(event.payload))

function boundaryError(
  code: string,
  operation: CommitExplanationCommand,
  recoverable: boolean,
): CommitExplanationBoundaryError {
  return new CommitExplanationBoundaryError({
    code,
    operation,
    recoverable,
    userMessageKey: "gitReview.error.commitExplanation",
  })
}

function normalizeError(
  operation: CommitExplanationCommand,
  error: unknown,
): CommitExplanationBoundaryError {
  if (error instanceof CommitExplanationBoundaryError) return error
  try {
    return new CommitExplanationBoundaryError(
      parseCommitExplanationControllerError(error),
    )
  } catch {
    return boundaryError("CODEX-SUPPORT-IPC-UNAVAILABLE", operation, true)
  }
}

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

function stateMatchesScope(
  state: CommitExplanationControllerStateV1,
  scope: CommitExplanationScopeRequestedV1 | null,
): boolean {
  return (
    scope !== null &&
    state.workspaceId === scope.workspaceId &&
    state.workspaceGeneration === scope.workspaceGeneration &&
    (state.locale === null || state.locale === scope.locale)
  )
}

function fullCommitSha(commitEvidenceId: string): string | null {
  const value = commitEvidenceId.startsWith("commit-")
    ? commitEvidenceId.slice("commit-".length)
    : ""
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value) ? value : null
}

function sameState(
  left: CommitExplanationControllerStateV1 | undefined,
  right: CommitExplanationControllerStateV1,
): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right)
}

const maximumPresentationDedupeEntries = 64
const terminalPresentationCopy = {
  ja: {
    unavailable:
      "コミット説明を表示できませんでした。コミット証拠は引き続き確認できます。",
    canceled:
      "コミット説明はキャンセルされました。コミット証拠は引き続き確認できます。",
  },
  en: {
    unavailable:
      "The commit explanation could not be shown. Commit evidence remains available.",
    canceled:
      "The commit explanation was canceled. Commit evidence remains available.",
  },
} as const

/**
 * App-lifetime owner of the five native commit-explanation commands and two
 * dedicated event channels. It never writes to the main Codex event stream.
 */
export class TauriCommitExplanationAdapter implements CommitExplanationAppRuntime {
  readonly #invoke: CommitExplanationInvoker
  readonly #listen: CommitExplanationEventListener
  readonly #states = new Map<string, CommitExplanationControllerStateV1>()
  readonly #stateRevisions = new Map<string, number>()
  readonly #pendingHydration = new Map<string, Promise<void>>()
  readonly #stateListeners = new Set<StateListener>()
  readonly #narrationListeners = new Set<NarrationListener>()
  readonly #generationHighWater = new Map<string, number>()
  readonly #presentationDedupe = new Set<string>()
  readonly #presentationDedupeOrder: string[] = []
  readonly #scopeWaiters = new Set<ScopeWaiter>()
  #scope: CommitExplanationScopeRequestedV1 | null = null
  #desiredScope: CommitExplanationScopeRequestedV1 | null = null
  #desiredScopeRevision = 0
  #appliedScopeRevision = 0
  #failedScopeRevision = 0
  #scopeLifecycleEpoch = 0
  #scopeWriterIdentity = 0
  #scopeWriter: ScopeWriter | null = null
  #lifecycleEpoch = 0
  #nativeDisposers: Array<() => void> = []
  #startPromise: Promise<void> | null = null
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

  constructor(dependencies: TauriCommitExplanationAdapterDependencies = {}) {
    this.#invoke = dependencies.invoke ?? invokeTauri
    this.#listen = dependencies.listen ?? listenTauri
  }

  readonly subscribe = (listener: StateListener): (() => void) => {
    this.#stateListeners.add(listener)
    return () => this.#stateListeners.delete(listener)
  }

  setPresentationActivator(
    activator: CommitExplanationPresentationActivator | null,
  ): void {
    this.#presentationActivator = activator
  }

  async start(): Promise<void> {
    if (this.#started) return
    if (this.#startPromise !== null) return this.#startPromise
    const epoch = ++this.#lifecycleEpoch
    const starting = Promise.allSettled([
      this.#listen(commitExplanationEventChannels.state, (payload) => {
        if (epoch === this.#lifecycleEpoch) this.consumeState(payload)
      }),
      this.#listen(commitExplanationEventChannels.presentation, (payload) => {
        if (epoch === this.#lifecycleEpoch) this.consumePresentation(payload)
      }),
    ]).then((results) => {
      const disposers = results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      )
      if (
        epoch !== this.#lifecycleEpoch ||
        results.some((result) => result.status === "rejected")
      ) {
        for (const dispose of disposers) dispose()
        if (epoch === this.#lifecycleEpoch) {
          throw boundaryError(
            "CODEX-SUPPORT-EVENTS-UNAVAILABLE",
            commitExplanationCommands.getState,
            true,
          )
        }
        return
      }
      this.#nativeDisposers = disposers
      this.#started = true
    })
    const tracked = starting.finally(() => {
      if (this.#startPromise === tracked) this.#startPromise = null
    })
    this.#startPromise = tracked
    return tracked
  }

  dispose(): void {
    this.revokePresentationIntent("dispose")
    ++this.#lifecycleEpoch
    ++this.#scopeLifecycleEpoch
    this.cancelScopeWriter()
    ++this.#desiredScopeRevision
    this.#started = false
    this.#startPromise = null
    this.#scope = null
    this.#desiredScope = null
    this.#appliedScopeRevision = 0
    this.#failedScopeRevision = 0
    this.rejectScopeWaiters(
      boundaryError(
        "CODEX-SUPPORT-SCOPE-DISPOSED",
        commitExplanationCommands.setScope,
        true,
      ),
    )
    const disposers = this.#nativeDisposers
    this.#nativeDisposers = []
    for (const dispose of disposers) dispose()
    this.emitStateChange()
  }

  async setScope(scopeValue: CommitExplanationScopeRequestedV1): Promise<void> {
    const scope = createCommitExplanationScopeRequested(scopeValue)
    const highest = this.#generationHighWater.get(scope.workspaceId)
    if (highest !== undefined && scope.workspaceGeneration < highest) {
      return Promise.reject(
        boundaryError(
          "CODEX-SUPPORT-WORKSPACE-STALE",
          commitExplanationCommands.setScope,
          false,
        ),
      )
    }
    if (sameScope(this.currentScope(), scope)) return Promise.resolve()
    this.#generationHighWater.set(scope.workspaceId, scope.workspaceGeneration)

    if (
      !sameScope(this.#desiredScope, scope) ||
      this.#failedScopeRevision === this.#desiredScopeRevision
    ) {
      this.revokePresentationIntent("scope_change")
      this.#desiredScope = scope
      ++this.#desiredScopeRevision
      this.#failedScopeRevision = 0
      this.emitStateChange()
    }

    const revision = this.#desiredScopeRevision
    const pending = new Promise<void>((resolve, reject) => {
      this.#scopeWaiters.add({ revision, resolve, reject })
    })
    this.ensureScopeWriter()
    return pending
  }

  revokePresentationIntent(
    reason: CommitExplanationPresentationRevokeReason,
  ): void {
    void reason
    ++this.#presentationIntentEpoch
    this.#presentationIntent = null
  }

  private currentScope(): CommitExplanationScopeRequestedV1 | null {
    if (
      this.#scope === null ||
      this.#desiredScope === null ||
      this.#appliedScopeRevision !== this.#desiredScopeRevision ||
      !sameScope(this.#scope, this.#desiredScope)
    ) {
      return null
    }
    return this.#scope
  }

  private ensureScopeWriter(): void {
    if (this.#scopeWriter !== null) return
    const lifecycleEpoch = this.#scopeLifecycleEpoch
    const identity = ++this.#scopeWriterIdentity
    let cancelWrite: (() => void) | undefined
    const cancellation = new Promise<void>((resolve) => {
      cancelWrite = resolve
    })
    const tracked = this.drainScopeWrites(
      lifecycleEpoch,
      identity,
      cancellation,
    ).finally(() => {
      if (this.#scopeWriter?.identity !== identity) return
      this.#scopeWriter = null
      if (
        this.#desiredScope !== null &&
        this.#scopeWaiters.size > 0 &&
        this.#failedScopeRevision !== this.#desiredScopeRevision
      ) {
        this.ensureScopeWriter()
      }
    })
    this.#scopeWriter = {
      identity,
      lifecycleEpoch,
      operation: tracked,
      cancel: () => cancelWrite?.(),
    }
  }

  private cancelScopeWriter(): void {
    const writer = this.#scopeWriter
    if (writer === null) return
    this.#scopeWriter = null
    ++this.#scopeWriterIdentity
    writer.cancel()
  }

  private isScopeWriterCurrent(
    lifecycleEpoch: number,
    identity: number,
  ): boolean {
    return (
      lifecycleEpoch === this.#scopeLifecycleEpoch &&
      identity === this.#scopeWriterIdentity
    )
  }

  private async drainScopeWrites(
    lifecycleEpoch: number,
    identity: number,
    cancellation: Promise<void>,
  ): Promise<void> {
    while (this.isScopeWriterCurrent(lifecycleEpoch, identity)) {
      const target = this.#desiredScope
      const revision = this.#desiredScopeRevision
      if (target === null) return
      if (
        this.#appliedScopeRevision === revision &&
        sameScope(this.#scope, target)
      ) {
        this.resolveScopeWaiters(revision)
        return
      }
      if (this.#failedScopeRevision === revision) return

      let invocation: Promise<ScopeWriteOutcome>
      try {
        invocation = this.#invoke(commitExplanationCommands.setScope, {
          request: target,
        }).then<ScopeWriteOutcome>(
          (value) => ({ kind: "response", value }),
          (error: unknown) => ({ kind: "failure", error }),
        )
      } catch (error) {
        invocation = Promise.resolve({ kind: "failure", error })
      }
      const outcome = await Promise.race<ScopeWriteOutcome>([
        invocation,
        cancellation.then<ScopeWriteOutcome>(() => ({ kind: "canceled" })),
      ])
      if (
        outcome.kind === "canceled" ||
        !this.isScopeWriterCurrent(lifecycleEpoch, identity)
      ) {
        return
      }

      const writeError =
        outcome.kind === "failure"
          ? outcome.error
          : outcome.value === null
            ? null
            : new GitReviewContractError()
      if (writeError !== null) {
        const normalized = normalizeError(
          commitExplanationCommands.setScope,
          writeError,
        )
        this.rejectScopeWaiters(normalized, revision)
        this.#failedScopeRevision = revision
        if (revision === this.#desiredScopeRevision) return
        continue
      }

      if (!this.isScopeWriterCurrent(lifecycleEpoch, identity)) return
      this.#scope = target
      this.#appliedScopeRevision = revision
      this.resolveScopeWaiters(revision)
      this.emitStateChange()
      if (revision === this.#desiredScopeRevision) return
    }
  }

  private resolveScopeWaiters(revision: number): void {
    for (const waiter of [...this.#scopeWaiters]) {
      if (waiter.revision > revision) continue
      this.#scopeWaiters.delete(waiter)
      waiter.resolve()
    }
  }

  private rejectScopeWaiters(
    error: CommitExplanationBoundaryError,
    throughRevision = Number.POSITIVE_INFINITY,
  ): void {
    for (const waiter of [...this.#scopeWaiters]) {
      if (waiter.revision > throughRevision) continue
      this.#scopeWaiters.delete(waiter)
      waiter.reject(error)
    }
  }

  private issuePresentationIntent(
    value: Omit<
      PresentationIntent,
      "epoch" | "commitSha" | "issuedAt" | "presentation"
    > & { readonly requestedAt: string },
  ): PresentationIntent {
    const commitSha = fullCommitSha(value.commitEvidenceId)
    if (commitSha === null) {
      throw boundaryError(
        "CODEX-SUPPORT-PRESENTATION-STALE",
        commitExplanationCommands.present,
        false,
      )
    }
    const parsedIssuedAt = Date.parse(value.requestedAt)
    const intent: PresentationIntent = {
      epoch: ++this.#presentationIntentEpoch,
      workspaceId: value.workspaceId,
      workspaceGeneration: value.workspaceGeneration,
      commitEvidenceId: value.commitEvidenceId,
      commitSha,
      requestId: value.requestId,
      selectionVersion: value.selectionVersion,
      trigger: value.trigger,
      locale: value.locale,
      mode: value.mode,
      issuedAt: Number.isFinite(parsedIssuedAt) ? parsedIssuedAt : Date.now(),
      presentation: null,
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
    return (
      state.workspaceId === intent.workspaceId &&
      state.workspaceGeneration === intent.workspaceGeneration &&
      state.commitEvidenceId === intent.commitEvidenceId &&
      state.requestId === intent.requestId &&
      state.selectionVersion === intent.selectionVersion &&
      state.trigger === intent.trigger &&
      state.locale === intent.locale
    )
  }

  private presentMatchingIntent(
    state: CommitExplanationControllerStateV1,
  ): Promise<void> | null {
    const intent = this.#presentationIntent
    if (
      intent === null ||
      !this.isPresentationIntentCurrent(intent) ||
      !this.intentMatchesState(intent, state)
    ) {
      return null
    }
    if (state.status !== "generated" || !state.presentationAvailable) {
      if (
        state.status === "failed" ||
        state.status === "unavailable" ||
        state.status === "canceled"
      ) {
        this.publishTerminalIntent(
          intent,
          state.status === "canceled" ? "canceled" : "unavailable",
        )
        this.revokePresentationIntent("close")
      }
      return null
    }
    return this.presentIntent(
      intent,
      createCommitExplanationPresentationRequested({
        schemaVersion: gitReviewSchemaVersion,
        workspaceId: intent.workspaceId,
        workspaceGeneration: intent.workspaceGeneration,
        commitEvidenceId: intent.commitEvidenceId,
        requestId: intent.requestId,
        mode: intent.mode,
        requestedAt: new Date().toISOString(),
      }),
    )
  }

  private presentIntent(
    intent: PresentationIntent,
    request: CommitExplanationPresentationRequestedV1,
  ): Promise<void> {
    if (!this.isPresentationIntentCurrent(intent)) return Promise.resolve()
    if (intent.presentation !== null) return intent.presentation
    const operation = (async () => {
      try {
        const presentation = parseCommitExplanationPresentation(
          await this.#invoke(commitExplanationCommands.present, { request }),
        )
        if (!this.isPresentationIntentCurrent(intent)) return
        if (!this.presentationMatchesIntent(presentation, intent)) {
          throw new GitReviewContractError()
        }
        this.publishPresentation(presentation)
      } catch (error) {
        if (this.isPresentationIntentCurrent(intent)) {
          this.publishTerminalIntent(intent, "unavailable")
          this.revokePresentationIntent("close")
        }
        throw normalizeError(commitExplanationCommands.present, error)
      }
    })()
    intent.presentation = operation
    return operation
  }

  private presentationMatchesIntent(
    presentation: CommitExplanationPresentationV1,
    intent: PresentationIntent,
  ): boolean {
    const presentedAt = Date.parse(presentation.presentedAt)
    return (
      this.isPresentationIntentCurrent(intent) &&
      presentation.workspaceId === intent.workspaceId &&
      presentation.workspaceGeneration === intent.workspaceGeneration &&
      presentation.commitEvidenceId === intent.commitEvidenceId &&
      presentation.requestId === intent.requestId &&
      presentation.selectionVersion === intent.selectionVersion &&
      presentation.trigger === intent.trigger &&
      presentation.locale === intent.locale &&
      presentation.mode === intent.mode &&
      Number.isFinite(presentedAt) &&
      presentedAt >= intent.issuedAt
    )
  }

  readonly request = async (
    dispatchValue: CommitExplanationDispatchV1,
  ): Promise<void> => {
    const dispatch = createCommitExplanationDispatch(dispatchValue)
    if (dispatch.request.trigger === "auto_verified_commit") {
      throw boundaryError(
        "CODEX-SUPPORT-AUTO-TRIGGER-FORBIDDEN",
        commitExplanationCommands.request,
        false,
      )
    }
    const scope = this.currentScope()
    if (
      scope === null ||
      scope.workspaceId !== dispatch.request.workspaceId ||
      scope.workspaceGeneration !== dispatch.request.workspaceGeneration ||
      scope.locale !== dispatch.request.locale
    ) {
      throw boundaryError(
        "CODEX-SUPPORT-WORKSPACE-STALE",
        commitExplanationCommands.request,
        true,
      )
    }
    const intent = this.issuePresentationIntent({
      workspaceId: dispatch.request.workspaceId,
      workspaceGeneration: dispatch.request.workspaceGeneration,
      commitEvidenceId: dispatch.request.commitEvidenceId,
      requestId: dispatch.request.requestId,
      selectionVersion: dispatch.request.selectionVersion,
      trigger: dispatch.request.trigger,
      locale: dispatch.request.locale,
      mode: "show",
      requestedAt: dispatch.request.requestedAt,
    })
    try {
      const state = parseCommitExplanationControllerState(
        await this.#invoke(commitExplanationCommands.request, { dispatch }),
      )
      if (
        state.workspaceId !== dispatch.request.workspaceId ||
        state.workspaceGeneration !== dispatch.request.workspaceGeneration ||
        state.commitEvidenceId !== dispatch.request.commitEvidenceId ||
        state.requestId !== dispatch.request.requestId ||
        state.locale !== dispatch.request.locale ||
        state.selectionVersion !== dispatch.request.selectionVersion ||
        state.trigger !== dispatch.request.trigger
      ) {
        throw new GitReviewContractError()
      }
      if (!this.isPresentationIntentCurrent(intent)) return
      const presentation = this.applyState(state)
      if (presentation !== null) await presentation
    } catch (error) {
      if (this.isPresentationIntentCurrent(intent)) {
        this.publishTerminalIntent(intent, "unavailable")
        this.revokePresentationIntent("close")
      }
      throw normalizeError(commitExplanationCommands.request, error)
    }
  }

  readonly cancel = async (
    requestValue: CommitExplanationCancelRequestedV1,
  ): Promise<void> => {
    const request = createCommitExplanationCancelRequested(requestValue)
    const intent = this.#presentationIntent
    const matchingIntent =
      intent !== null &&
      intent.requestId === request.requestId &&
      intent.workspaceGeneration === request.workspaceGeneration &&
      intent.selectionVersion === request.selectionVersion
        ? intent
        : null
    try {
      const response = await this.#invoke(commitExplanationCommands.cancel, {
        request,
      })
      if (response === null) {
        if (
          matchingIntent !== null &&
          this.isPresentationIntentCurrent(matchingIntent)
        ) {
          this.publishTerminalIntent(matchingIntent, "unavailable")
          this.revokePresentationIntent("close")
        }
        return
      }
      const state = parseCommitExplanationControllerState(response)
      if (
        state.requestId !== request.requestId ||
        state.workspaceGeneration !== request.workspaceGeneration ||
        state.selectionVersion !== request.selectionVersion
      ) {
        throw new GitReviewContractError()
      }
      const presentation = this.applyState(state)
      void presentation?.catch(() => undefined)
    } catch (error) {
      if (
        matchingIntent !== null &&
        this.isPresentationIntentCurrent(matchingIntent)
      ) {
        this.publishTerminalIntent(matchingIntent, "unavailable")
        this.revokePresentationIntent("close")
      }
      throw normalizeError(commitExplanationCommands.cancel, error)
    }
  }

  readonly present = async (
    requestValue: CommitExplanationPresentationRequestedV1,
  ): Promise<void> => {
    const request = createCommitExplanationPresentationRequested(requestValue)
    const state = this.#states.get(
      stateKey(
        request.workspaceId,
        request.workspaceGeneration,
        request.commitEvidenceId,
      ),
    )
    if (
      state === undefined ||
      !stateMatchesScope(state, this.currentScope()) ||
      state.status !== "generated" ||
      !state.presentationAvailable ||
      state.requestId !== request.requestId
    ) {
      throw boundaryError(
        "CODEX-SUPPORT-PRESENTATION-STALE",
        commitExplanationCommands.present,
        true,
      )
    }
    if (
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
    const intent = this.issuePresentationIntent({
      workspaceId: request.workspaceId,
      workspaceGeneration: request.workspaceGeneration,
      commitEvidenceId: request.commitEvidenceId,
      requestId: request.requestId,
      selectionVersion: state.selectionVersion,
      trigger: state.trigger,
      locale: state.locale,
      mode: request.mode,
      requestedAt: request.requestedAt,
    })
    await this.presentIntent(intent, request)
  }

  readonly getState = (
    workspaceId: string,
    workspaceGeneration: number,
    commitEvidenceIdValue: string,
  ): CommitExplanationControllerStateV1 | null => {
    let request: CommitExplanationStateRequestedV1
    try {
      request = createCommitExplanationStateRequested({
        schemaVersion: gitReviewSchemaVersion,
        workspaceId,
        workspaceGeneration,
        commitEvidenceId: commitEvidenceIdValue,
      })
    } catch {
      return null
    }
    const key = stateKey(
      workspaceId,
      workspaceGeneration,
      commitEvidenceIdValue,
    )
    const cached = this.#states.get(key)
    if (
      cached !== undefined &&
      stateMatchesScope(cached, this.currentScope())
    ) {
      return cached
    }
    this.hydrateState(key, request)
    return null
  }

  private hydrateState(
    key: string,
    request: CommitExplanationStateRequestedV1,
  ): void {
    if (this.#pendingHydration.has(key)) return
    const revision = this.#stateRevisions.get(key) ?? 0
    const scopeRevision = this.#desiredScopeRevision
    const hydration = this.#invoke(commitExplanationCommands.getState, {
      request,
    })
      .then((value) => {
        const state = parseCommitExplanationControllerState(value)
        if (
          (this.#stateRevisions.get(key) ?? 0) !== revision ||
          state.workspaceId !== request.workspaceId ||
          state.workspaceGeneration !== request.workspaceGeneration ||
          state.commitEvidenceId !== request.commitEvidenceId ||
          scopeRevision !== this.#desiredScopeRevision ||
          !stateMatchesScope(state, this.currentScope())
        ) {
          return
        }
        const presentation = this.applyState(state)
        void presentation?.catch(() => undefined)
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.#pendingHydration.get(key) === hydration) {
          this.#pendingHydration.delete(key)
        }
      })
    this.#pendingHydration.set(key, hydration)
  }

  private consumeState(payload: unknown): void {
    try {
      const state = parseCommitExplanationControllerState(payload)
      if (!stateMatchesScope(state, this.currentScope())) return
      const presentation = this.applyState(state)
      void presentation?.catch(() => undefined)
    } catch {
      // Dedicated native events are untrusted until their exact schema passes.
    }
  }

  private applyState(
    state: CommitExplanationControllerStateV1,
  ): Promise<void> | null {
    if (!stateMatchesScope(state, this.currentScope())) return null
    const key = stateKey(
      state.workspaceId,
      state.workspaceGeneration,
      state.commitEvidenceId,
    )
    const current = this.#states.get(key)
    if (
      current !== undefined &&
      current.selectionVersion !== null &&
      state.selectionVersion !== null &&
      state.selectionVersion < current.selectionVersion
    ) {
      return null
    }
    if (!sameState(current, state)) {
      this.#states.set(key, state)
      this.#stateRevisions.set(key, (this.#stateRevisions.get(key) ?? 0) + 1)
      this.emitStateChange()
    }
    return this.presentMatchingIntent(state)
  }

  private emitStateChange(): void {
    for (const listener of [...this.#stateListeners]) {
      try {
        listener()
      } catch {
        // A view subscriber cannot break native event ownership.
      }
    }
  }

  private consumePresentation(payload: unknown): void {
    try {
      this.publishPresentation(parseCommitExplanationPresentation(payload))
    } catch {
      // Malformed or private presentation payloads fail closed.
    }
  }

  private publishPresentation(
    presentation: CommitExplanationPresentationV1,
  ): void {
    const intent = this.#presentationIntent
    const scope = this.currentScope()
    const sha = fullCommitSha(presentation.commitEvidenceId)
    if (
      intent === null ||
      !this.presentationMatchesIntent(presentation, intent) ||
      scope === null ||
      sha === null ||
      sha !== intent.commitSha ||
      presentation.workspaceId !== scope.workspaceId ||
      presentation.workspaceGeneration !== scope.workspaceGeneration ||
      presentation.locale !== scope.locale
    ) {
      return
    }
    const state = this.#states.get(
      stateKey(
        presentation.workspaceId,
        presentation.workspaceGeneration,
        presentation.commitEvidenceId,
      ),
    )
    if (
      state === undefined ||
      state.status !== "generated" ||
      !state.presentationAvailable ||
      state.requestId !== presentation.requestId ||
      state.selectionVersion !== presentation.selectionVersion ||
      state.trigger !== presentation.trigger ||
      state.locale !== presentation.locale
    ) {
      return
    }

    const digest = JSON.stringify(presentation)
    const dedupeKey = JSON.stringify([
      presentation.workspaceId,
      presentation.workspaceGeneration,
      sha,
      presentation.requestId,
      presentation.locale,
      presentation.mode,
      intent.epoch,
      digest,
    ])
    if (!this.rememberPresentation(dedupeKey)) return

    const base = {
      schemaVersion: gitReviewSchemaVersion,
      source: "background_support" as const,
      trigger: presentation.trigger,
      workspaceId: presentation.workspaceId,
      workspaceGeneration: presentation.workspaceGeneration,
      commitSha: sha,
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
          // A narration consumer cannot duplicate or corrupt event delivery.
        }
      }
    }
    const activator = this.#presentationActivator
    if (activator !== null && this.isPresentationIntentCurrent(intent)) {
      const key: CommitNarrationSourceKey = {
        workspaceId: presentation.workspaceId,
        workspaceGeneration: presentation.workspaceGeneration,
        commitSha: sha,
        requestId: presentation.requestId,
        locale: presentation.locale,
      }
      try {
        void Promise.resolve(activator(key)).catch(() => undefined)
      } catch {
        // Presentation activation cannot corrupt the trusted event bridge.
      }
    }
  }

  private publishTerminalIntent(
    intent: PresentationIntent,
    status: "unavailable" | "canceled",
  ): void {
    if (!this.isPresentationIntentCurrent(intent)) return
    const dedupeKey = JSON.stringify([
      "terminal",
      intent.epoch,
      intent.workspaceId,
      intent.workspaceGeneration,
      intent.commitSha,
      intent.requestId,
      intent.selectionVersion,
      intent.locale,
      status,
    ])
    if (!this.rememberPresentation(dedupeKey)) return

    const base = {
      schemaVersion: gitReviewSchemaVersion,
      source: "background_support" as const,
      trigger: intent.trigger,
      workspaceId: intent.workspaceId,
      workspaceGeneration: intent.workspaceGeneration,
      commitSha: intent.commitSha,
      requestId: intent.requestId,
      locale: intent.locale,
    }
    const preTerminalEvents: CommitNarrationConsumerEventV1[] = [
      parseCommitNarrationConsumerEvent({ ...base, kind: "started" }),
      parseCommitNarrationConsumerEvent({
        ...base,
        kind: "chunk",
        sequence: 0,
        text: terminalPresentationCopy[intent.locale][status],
      }),
    ]
    for (const event of preTerminalEvents) {
      this.emitNarrationEvent(intent, event)
    }

    const activator = this.#presentationActivator
    if (activator !== null && this.isPresentationIntentCurrent(intent)) {
      const key: CommitNarrationSourceKey = {
        workspaceId: intent.workspaceId,
        workspaceGeneration: intent.workspaceGeneration,
        commitSha: intent.commitSha,
        requestId: intent.requestId,
        locale: intent.locale,
      }
      try {
        void Promise.resolve(activator(key)).catch(() => undefined)
      } catch {
        // Terminal caption activation cannot corrupt the trusted event bridge.
      }
    }

    this.emitNarrationEvent(
      intent,
      parseCommitNarrationConsumerEvent({
        ...base,
        kind: "terminal",
        status: status === "canceled" ? "canceled" : "failed",
        errorCode:
          status === "canceled"
            ? "CODEX-SUPPORT-PRESENTATION-CANCELED"
            : "CODEX-SUPPORT-PRESENTATION-UNAVAILABLE",
      }),
    )
  }

  private emitNarrationEvent(
    intent: PresentationIntent,
    event: CommitNarrationConsumerEventV1,
  ): void {
    if (!this.isPresentationIntentCurrent(intent)) return
    for (const listener of [...this.#narrationListeners]) {
      if (!this.isPresentationIntentCurrent(intent)) return
      try {
        listener(event)
      } catch {
        // A narration consumer cannot corrupt terminal fallback delivery.
      }
    }
  }

  private rememberPresentation(key: string): boolean {
    if (this.#presentationDedupe.has(key)) return false
    this.#presentationDedupe.add(key)
    this.#presentationDedupeOrder.push(key)
    while (
      this.#presentationDedupeOrder.length > maximumPresentationDedupeEntries
    ) {
      const oldest = this.#presentationDedupeOrder.shift()
      if (oldest !== undefined) this.#presentationDedupe.delete(oldest)
    }
    return true
  }
}
