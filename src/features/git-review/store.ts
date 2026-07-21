import {
  createCommitExplanationCancelRequested,
  createCommitExplanationPresentationRequested,
  createCommitExplanationRequested,
  gitReviewCommands,
  gitReviewSchemaVersion,
  type CommitDiffFile,
  type CommitEvidenceDetail,
  type CommitEvidenceFilter,
  type CommitEvidenceSummary,
  type CommitExplanationController,
  type CommitExplanationControllerStateV1,
  type CommitExplanationPresentationMode,
  type CommitExplanationUserRequestTrigger,
  type GitObservation,
  type GitObservationReason,
} from "@/lib/contracts/git-review"

import {
  GitReviewBoundaryError,
  type GitReviewTransport,
} from "@/features/git-review/transport"

export type GitReviewCollectionStatus =
  | "idle"
  | "loading"
  | "ready"
  | "empty"
  | "error"
export type GitReviewResourceStatus = "idle" | "loading" | "ready" | "error"
export type CommitExplanationIntentStatus =
  | "idle"
  | "preparing"
  | "canceling"
  | "error"

export interface GitReviewErrorState {
  readonly code: string
  readonly userMessageKey: string
  readonly recoverable: boolean
}

export interface CommitExplanationState {
  readonly status: CommitExplanationIntentStatus
  readonly requestId: string | null
  readonly error: GitReviewErrorState | null
}

export interface GitReviewSnapshot {
  readonly active: boolean
  readonly observationStatus: GitReviewResourceStatus
  readonly observation: GitObservation | null
  readonly observationError: GitReviewErrorState | null
  readonly collectionStatus: GitReviewCollectionStatus
  readonly items: readonly CommitEvidenceSummary[]
  readonly nextCursor: string | null
  readonly loadingMore: boolean
  readonly filter: CommitEvidenceFilter
  readonly collectionError: GitReviewErrorState | null
  readonly selectedCommitEvidenceId: string | null
  readonly selectionVersion: number
  readonly detailStatus: GitReviewResourceStatus
  readonly detail: CommitEvidenceDetail | null
  readonly detailError: GitReviewErrorState | null
  readonly selectedFileEvidenceId: string | null
  readonly diffStatus: GitReviewResourceStatus
  readonly diff: CommitDiffFile | null
  readonly diffError: GitReviewErrorState | null
  readonly explanation: CommitExplanationState
}

export interface GitReviewStoreOptions {
  readonly workspaceGeneration?: number
  readonly commitExplanationController?: CommitExplanationController | undefined
  readonly now?: () => Date
}

type ReviewListener = () => void

const idleExplanation: CommitExplanationState = {
  status: "idle",
  requestId: null,
  error: null,
}

function initialSnapshot(): GitReviewSnapshot {
  return {
    active: false,
    observationStatus: "idle",
    observation: null,
    observationError: null,
    collectionStatus: "idle",
    items: [],
    nextCursor: null,
    loadingMore: false,
    filter: "all",
    collectionError: null,
    selectedCommitEvidenceId: null,
    selectionVersion: 0,
    detailStatus: "idle",
    detail: null,
    detailError: null,
    selectedFileEvidenceId: null,
    diffStatus: "idle",
    diff: null,
    diffError: null,
    explanation: idleExplanation,
  }
}

function errorState(error: unknown, fallback: string): GitReviewErrorState {
  if (error instanceof GitReviewBoundaryError) {
    return {
      code: error.code,
      userMessageKey: error.userMessageKey,
      recoverable: error.recoverable,
    }
  }

  return {
    code: fallback,
    userMessageKey: "gitReview.error.generic",
    recoverable: true,
  }
}

export class GitReviewStore {
  private current = initialSnapshot()
  private readonly listeners = new Set<ReviewListener>()
  private readonly workspaceGeneration: number
  private readonly explanationController:
    | CommitExplanationController
    | undefined
  private readonly now: () => Date
  private activatedOnce = false
  private initialSelectionEstablished = false
  private requestSequence = 0
  private collectionGeneration = 0
  private detailGeneration = 0
  private diffGeneration = 0
  private explanationGeneration = 0

  constructor(
    readonly workspaceId: string,
    private readonly transport: GitReviewTransport,
    options: GitReviewStoreOptions = {},
  ) {
    this.workspaceGeneration = options.workspaceGeneration ?? 1
    this.explanationController = options.commitExplanationController
    this.now = options.now ?? (() => new Date())
  }

  snapshot = (): GitReviewSnapshot => this.current

  subscribe = (listener: ReviewListener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async activate(): Promise<void> {
    if (this.current.active) return
    this.setSnapshot({ ...this.current, active: true })
    const reason: GitObservationReason = this.activatedOnce
      ? "manual_refresh"
      : "active_view"
    this.activatedOnce = true
    await this.refresh(reason)
  }

  deactivate(): void {
    if (!this.current.active) return
    ++this.collectionGeneration
    ++this.detailGeneration
    ++this.diffGeneration
    ++this.explanationGeneration
    this.setSnapshot({
      ...this.current,
      active: false,
      explanation: idleExplanation,
    })
  }

  async refresh(
    reason: GitObservationReason = "manual_refresh",
  ): Promise<void> {
    if (!this.current.active) return

    const hasItems = this.current.items.length > 0
    this.setSnapshot({
      ...this.current,
      observationStatus: "loading",
      observationError: null,
      collectionStatus: hasItems ? "ready" : "loading",
      collectionError: null,
    })

    try {
      const observation = await this.transport.request(
        gitReviewCommands.observeRepository,
        {
          schemaVersion: gitReviewSchemaVersion,
          clientRequestId: this.nextRequestId("observe"),
          workspaceId: this.workspaceId,
          workspaceGeneration: this.workspaceGeneration,
          reason,
          workUnitId: null,
          sourceEventId: null,
        },
      )
      if (!this.current.active) return
      this.setSnapshot({
        ...this.current,
        observationStatus: "ready",
        observation,
        observationError: null,
      })
    } catch (error) {
      if (!this.current.active) return
      this.setSnapshot({
        ...this.current,
        observationStatus: "error",
        observationError: errorState(error, "GIT-OBSERVATION-FAILED"),
      })
    }

    await this.loadFirstPage({ clearMissingSelection: true })
  }

  async setFilter(filter: CommitEvidenceFilter): Promise<void> {
    if (filter === this.current.filter) return
    this.setSnapshot({ ...this.current, filter })
    if (this.current.active) {
      await this.loadFirstPage({ clearMissingSelection: false })
    }
  }

  async loadMore(): Promise<void> {
    const cursor = this.current.nextCursor
    if (!this.current.active || cursor === null || this.current.loadingMore) {
      return
    }

    const generation = ++this.collectionGeneration
    this.setSnapshot({ ...this.current, loadingMore: true })
    try {
      const page = await this.requestPage(cursor)
      if (generation !== this.collectionGeneration || !this.current.active) {
        return
      }
      const known = new Set(
        this.current.items.map((item) => item.commitEvidenceId),
      )
      const additional = page.items.filter(
        (item) => !known.has(item.commitEvidenceId),
      )
      this.setSnapshot({
        ...this.current,
        items: [...this.current.items, ...additional],
        nextCursor: page.nextCursor,
        loadingMore: false,
      })
    } catch (error) {
      if (generation !== this.collectionGeneration) return
      this.setSnapshot({
        ...this.current,
        loadingMore: false,
        collectionError: errorState(error, "GIT-EVIDENCE-PAGE-FAILED"),
      })
    }
  }

  async selectCommitEvidence(commitEvidenceId: string): Promise<void> {
    if (
      !this.current.items.some(
        (item) => item.commitEvidenceId === commitEvidenceId,
      )
    ) {
      return
    }
    if (this.current.selectedCommitEvidenceId === commitEvidenceId) return

    const generation = ++this.detailGeneration
    ++this.diffGeneration
    ++this.explanationGeneration
    const selectionVersion = this.current.selectionVersion + 1
    this.initialSelectionEstablished = true
    this.setSnapshot({
      ...this.current,
      selectedCommitEvidenceId: commitEvidenceId,
      selectionVersion,
      detailStatus: "loading",
      detail: null,
      detailError: null,
      selectedFileEvidenceId: null,
      diffStatus: "idle",
      diff: null,
      diffError: null,
      explanation: idleExplanation,
    })

    try {
      const detail = await this.transport.request(
        gitReviewCommands.readCommitEvidence,
        {
          schemaVersion: gitReviewSchemaVersion,
          workspaceId: this.workspaceId,
          workspaceGeneration: this.workspaceGeneration,
          commitEvidenceId,
        },
      )
      if (
        generation !== this.detailGeneration ||
        this.current.selectedCommitEvidenceId !== commitEvidenceId
      ) {
        return
      }
      this.setSnapshot({
        ...this.current,
        detailStatus: "ready",
        detail,
        detailError: null,
      })
      const firstFile = detail.files[0]
      if (firstFile !== undefined) {
        await this.selectFile(firstFile.fileEvidenceId)
      }
    } catch (error) {
      if (generation !== this.detailGeneration) return
      this.setSnapshot({
        ...this.current,
        detailStatus: "error",
        detail: null,
        detailError: errorState(error, "GIT-EVIDENCE-DETAIL-FAILED"),
      })
    }
  }

  async selectFile(fileEvidenceId: string): Promise<void> {
    const detail = this.current.detail
    if (
      detail === null ||
      !detail.files.some((file) => file.fileEvidenceId === fileEvidenceId)
    ) {
      return
    }

    const generation = ++this.diffGeneration
    this.setSnapshot({
      ...this.current,
      selectedFileEvidenceId: fileEvidenceId,
      diffStatus: "loading",
      diff: null,
      diffError: null,
    })

    try {
      const diff = await this.transport.request(
        gitReviewCommands.readCommitDiffFile,
        {
          schemaVersion: gitReviewSchemaVersion,
          workspaceId: this.workspaceId,
          workspaceGeneration: this.workspaceGeneration,
          commitEvidenceId: detail.commitEvidenceId,
          fileEvidenceId,
        },
      )
      if (
        generation !== this.diffGeneration ||
        this.current.selectedFileEvidenceId !== fileEvidenceId
      ) {
        return
      }
      this.setSnapshot({
        ...this.current,
        diffStatus: "ready",
        diff,
        diffError: null,
      })
    } catch (error) {
      if (generation !== this.diffGeneration) return
      this.setSnapshot({
        ...this.current,
        diffStatus: "error",
        diff: null,
        diffError: errorState(error, "GIT-EVIDENCE-DIFF-FAILED"),
      })
    }
  }

  async requestExplanation(
    locale: "ja" | "en",
    trigger: CommitExplanationUserRequestTrigger,
  ): Promise<void> {
    const detail = this.current.detail
    if (
      !this.current.active ||
      detail === null ||
      this.current.detailStatus !== "ready" ||
      this.current.observationStatus !== "ready" ||
      this.current.observation?.supportState !== "ready" ||
      this.explanationController === undefined
    ) {
      this.setSnapshot({
        ...this.current,
        explanation: {
          status: "error",
          requestId: null,
          error: {
            code: "GIT-EXPLANATION-UNAVAILABLE",
            userMessageKey: "gitReview.explanation.unavailable",
            recoverable: true,
          },
        },
      })
      return
    }

    const generation = ++this.explanationGeneration
    const selectionVersion = this.current.selectionVersion
    const commitEvidenceId = detail.commitEvidenceId
    const requestId = this.nextRequestId("explain")
    this.setSnapshot({
      ...this.current,
      explanation: { status: "preparing", requestId, error: null },
    })

    try {
      const evidence = await this.transport.request(
        gitReviewCommands.prepareCommitExplanationEvidence,
        {
          schemaVersion: gitReviewSchemaVersion,
          workspaceId: this.workspaceId,
          workspaceGeneration: this.workspaceGeneration,
          commitEvidenceId,
          locale,
          selectionVersion,
        },
      )
      if (
        generation !== this.explanationGeneration ||
        !this.current.active ||
        this.current.selectedCommitEvidenceId !== commitEvidenceId ||
        this.current.selectionVersion !== selectionVersion
      ) {
        return
      }

      const request = createCommitExplanationRequested({
        schemaVersion: gitReviewSchemaVersion,
        requestId,
        workspaceId: this.workspaceId,
        workspaceGeneration: this.workspaceGeneration,
        commitEvidenceId,
        locale,
        selectionVersion,
        trigger,
        requestedAt: this.now().toISOString(),
      })
      await this.explanationController.request({ request, evidence })
      if (generation !== this.explanationGeneration) return
      this.setSnapshot({
        ...this.current,
        explanation: idleExplanation,
      })
    } catch (error) {
      if (generation !== this.explanationGeneration) return
      this.setSnapshot({
        ...this.current,
        explanation: {
          status: "error",
          requestId,
          error: errorState(error, "GIT-EXPLANATION-PREPARE-FAILED"),
        },
      })
    }
  }

  async cancelExplanation(
    state: CommitExplanationControllerStateV1,
  ): Promise<void> {
    if (
      this.explanationController === undefined ||
      state.workspaceId !== this.workspaceId ||
      state.workspaceGeneration !== this.workspaceGeneration ||
      state.commitEvidenceId !== this.current.selectedCommitEvidenceId ||
      state.requestId === null ||
      state.selectionVersion !== this.current.selectionVersion ||
      (state.status !== "queued" && state.status !== "running")
    ) {
      return
    }

    const generation = ++this.explanationGeneration
    this.setSnapshot({
      ...this.current,
      explanation: {
        status: "canceling",
        requestId: state.requestId,
        error: null,
      },
    })
    const request = createCommitExplanationCancelRequested({
      schemaVersion: gitReviewSchemaVersion,
      requestId: state.requestId,
      workspaceGeneration: this.workspaceGeneration,
      selectionVersion: state.selectionVersion,
      reason: "user",
      requestedAt: this.now().toISOString(),
    })

    try {
      await this.explanationController.cancel(request)
      if (generation !== this.explanationGeneration) return
      this.setSnapshot({ ...this.current, explanation: idleExplanation })
    } catch (error) {
      if (generation !== this.explanationGeneration) return
      this.setSnapshot({
        ...this.current,
        explanation: {
          status: "error",
          requestId: state.requestId,
          error: errorState(error, "GIT-EXPLANATION-CANCEL-FAILED"),
        },
      })
    }
  }

  async presentExplanation(
    state: CommitExplanationControllerStateV1,
    mode: CommitExplanationPresentationMode,
  ): Promise<void> {
    if (
      this.explanationController === undefined ||
      state.workspaceId !== this.workspaceId ||
      state.workspaceGeneration !== this.workspaceGeneration ||
      state.commitEvidenceId !== this.current.selectedCommitEvidenceId ||
      state.requestId === null ||
      state.selectionVersion !== this.current.selectionVersion ||
      !state.presentationAvailable
    ) {
      return
    }

    const generation = ++this.explanationGeneration
    const selectionVersion = this.current.selectionVersion
    const commitEvidenceId = state.commitEvidenceId
    const requestId = state.requestId
    const isCurrentPresentation = () => {
      const controllerState = this.explanationController?.getState(
        this.workspaceId,
        this.workspaceGeneration,
        commitEvidenceId,
      )
      return (
        generation === this.explanationGeneration &&
        this.current.active &&
        this.current.selectionVersion === selectionVersion &&
        this.current.selectedCommitEvidenceId === commitEvidenceId &&
        controllerState?.requestId === requestId
      )
    }

    try {
      await this.explanationController.present(
        createCommitExplanationPresentationRequested({
          schemaVersion: gitReviewSchemaVersion,
          workspaceId: this.workspaceId,
          workspaceGeneration: this.workspaceGeneration,
          commitEvidenceId,
          requestId,
          mode,
          requestedAt: this.now().toISOString(),
        }),
      )
      if (!isCurrentPresentation()) return
    } catch (error) {
      if (!isCurrentPresentation()) return
      this.setSnapshot({
        ...this.current,
        explanation: {
          status: "error",
          requestId,
          error: errorState(error, "GIT-EXPLANATION-PRESENT-FAILED"),
        },
      })
    }
  }

  private async loadFirstPage(options: {
    readonly clearMissingSelection: boolean
  }): Promise<void> {
    const generation = ++this.collectionGeneration
    const hasItems = this.current.items.length > 0
    this.setSnapshot({
      ...this.current,
      collectionStatus: hasItems ? "ready" : "loading",
      collectionError: null,
      loadingMore: false,
    })

    try {
      const page = await this.requestPage(null)
      if (generation !== this.collectionGeneration || !this.current.active) {
        return
      }
      const selected = this.current.selectedCommitEvidenceId
      const selectionStillVisible =
        selected !== null &&
        page.items.some((item) => item.commitEvidenceId === selected)
      this.setSnapshot({
        ...this.current,
        collectionStatus:
          page.items.length === 0 && page.nextCursor === null
            ? "empty"
            : "ready",
        items: page.items,
        nextCursor: page.nextCursor,
        loadingMore: false,
        collectionError: null,
      })

      if (!this.initialSelectionEstablished && page.items[0] !== undefined) {
        await this.selectCommitEvidence(page.items[0].commitEvidenceId)
      } else if (
        options.clearMissingSelection &&
        selected !== null &&
        !selectionStillVisible &&
        this.current.filter === "all"
      ) {
        this.clearSelection()
      }
    } catch (error) {
      if (generation !== this.collectionGeneration) return
      this.setSnapshot({
        ...this.current,
        collectionStatus: hasItems ? "ready" : "error",
        loadingMore: false,
        collectionError: errorState(error, "GIT-EVIDENCE-LIST-FAILED"),
      })
    }
  }

  private requestPage(cursor: string | null) {
    return this.transport.request(gitReviewCommands.listCommitEvidence, {
      schemaVersion: gitReviewSchemaVersion,
      workspaceId: this.workspaceId,
      workspaceGeneration: this.workspaceGeneration,
      cursor,
      limit: 50,
      filter: this.current.filter,
      workUnitId:
        this.current.filter === "this_work_unit"
          ? (this.current.detail?.workUnitId ?? null)
          : null,
    })
  }

  private clearSelection(): void {
    ++this.detailGeneration
    ++this.diffGeneration
    ++this.explanationGeneration
    this.initialSelectionEstablished = true
    this.setSnapshot({
      ...this.current,
      selectedCommitEvidenceId: null,
      selectionVersion: this.current.selectionVersion + 1,
      detailStatus: "idle",
      detail: null,
      detailError: null,
      selectedFileEvidenceId: null,
      diffStatus: "idle",
      diff: null,
      diffError: null,
      explanation: idleExplanation,
    })
  }

  private nextRequestId(operation: "observe" | "explain"): string {
    this.requestSequence += 1
    return `git-${operation}-${this.workspaceGeneration}-${this.requestSequence}`
  }

  private setSnapshot(next: GitReviewSnapshot): void {
    this.current = next
    this.listeners.forEach((listener) => listener())
  }
}
