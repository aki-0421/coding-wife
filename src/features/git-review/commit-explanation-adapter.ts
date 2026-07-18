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
}

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
  #scopeWriter: Promise<void> | null = null
  #lifecycleEpoch = 0
  #nativeDisposers: Array<() => void> = []
  #startPromise: Promise<void> | null = null
  #started = false
  #presentationActivator: CommitExplanationPresentationActivator | null = null

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
    ++this.#lifecycleEpoch
    ++this.#scopeLifecycleEpoch
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
    const tracked = this.drainScopeWrites(lifecycleEpoch).finally(() => {
      if (this.#scopeWriter !== tracked) return
      this.#scopeWriter = null
      if (
        this.#desiredScope !== null &&
        this.#scopeWaiters.size > 0 &&
        this.#failedScopeRevision !== this.#desiredScopeRevision
      ) {
        this.ensureScopeWriter()
      }
    })
    this.#scopeWriter = tracked
  }

  private async drainScopeWrites(lifecycleEpoch: number): Promise<void> {
    while (lifecycleEpoch === this.#scopeLifecycleEpoch) {
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

      try {
        const response = await this.#invoke(
          commitExplanationCommands.setScope,
          { request: target },
        )
        if (response !== null) throw new GitReviewContractError()
      } catch (error) {
        if (lifecycleEpoch !== this.#scopeLifecycleEpoch) return
        const normalized = normalizeError(
          commitExplanationCommands.setScope,
          error,
        )
        this.rejectScopeWaiters(normalized, revision)
        this.#failedScopeRevision = revision
        if (revision === this.#desiredScopeRevision) return
        continue
      }

      if (lifecycleEpoch !== this.#scopeLifecycleEpoch) return
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
      this.applyState(state)
    } catch (error) {
      throw normalizeError(commitExplanationCommands.request, error)
    }
  }

  readonly cancel = async (
    requestValue: CommitExplanationCancelRequestedV1,
  ): Promise<void> => {
    const request = createCommitExplanationCancelRequested(requestValue)
    try {
      const response = await this.#invoke(commitExplanationCommands.cancel, {
        request,
      })
      if (response === null) return
      const state = parseCommitExplanationControllerState(response)
      if (
        state.requestId !== request.requestId ||
        state.workspaceGeneration !== request.workspaceGeneration ||
        state.selectionVersion !== request.selectionVersion
      ) {
        throw new GitReviewContractError()
      }
      this.applyState(state)
    } catch (error) {
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
    try {
      const presentation = parseCommitExplanationPresentation(
        await this.#invoke(commitExplanationCommands.present, { request }),
      )
      if (
        presentation.workspaceId !== request.workspaceId ||
        presentation.workspaceGeneration !== request.workspaceGeneration ||
        presentation.commitEvidenceId !== request.commitEvidenceId ||
        presentation.requestId !== request.requestId ||
        presentation.mode !== request.mode
      ) {
        throw new GitReviewContractError()
      }
      this.publishPresentation(presentation)
    } catch (error) {
      throw normalizeError(commitExplanationCommands.present, error)
    }
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
        this.applyState(state)
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
      this.applyState(state)
    } catch {
      // Dedicated native events are untrusted until their exact schema passes.
    }
  }

  private applyState(state: CommitExplanationControllerStateV1): void {
    if (!stateMatchesScope(state, this.currentScope())) return
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
      return
    }
    if (sameState(current, state)) return
    this.#states.set(key, state)
    this.#stateRevisions.set(key, (this.#stateRevisions.get(key) ?? 0) + 1)
    this.emitStateChange()
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
    const scope = this.currentScope()
    const sha = fullCommitSha(presentation.commitEvidenceId)
    if (
      scope === null ||
      sha === null ||
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
      digest,
    ])
    if (this.#presentationDedupe.has(dedupeKey)) return
    this.#presentationDedupe.add(dedupeKey)
    this.#presentationDedupeOrder.push(dedupeKey)
    while (
      this.#presentationDedupeOrder.length > maximumPresentationDedupeEntries
    ) {
      const oldest = this.#presentationDedupeOrder.shift()
      if (oldest !== undefined) this.#presentationDedupe.delete(oldest)
    }

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
      for (const listener of [...this.#narrationListeners]) {
        try {
          listener(event)
        } catch {
          // A narration consumer cannot duplicate or corrupt event delivery.
        }
      }
    }
    const activator = this.#presentationActivator
    if (activator !== null) {
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
}
