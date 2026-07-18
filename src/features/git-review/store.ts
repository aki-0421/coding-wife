import {
  gitReviewCommands,
  type CompareCheckpointsView,
  type FileDiffView,
  type GitBaseline,
  type RestoreKind,
  type RestorePreview,
  type RestoreResult,
  type ReviewPack,
  type ReviewPackSummary,
} from "@/lib/contracts/git-review"

import {
  GitReviewBoundaryError,
  type GitReviewTransport,
} from "@/features/git-review/transport"

export type ReviewCollectionStatus =
  "idle" | "loading" | "ready" | "empty" | "error"
export type ReviewResourceStatus = "idle" | "loading" | "ready" | "error"
export type RestoreFlowStatus =
  | "idle"
  | "previewing"
  | "ready"
  | "blocked"
  | "confirming"
  | "succeeded"
  | "error"

export interface GitReviewErrorState {
  readonly code: string
  readonly userMessageKey: string
  readonly recoverable: boolean
}

export interface CompareState {
  readonly fromCheckpointId: string | null
  readonly toCheckpointId: string | null
  readonly status: ReviewResourceStatus
  readonly result: CompareCheckpointsView | null
  readonly error: GitReviewErrorState | null
}

export interface RestoreState {
  readonly kind: RestoreKind | null
  readonly status: RestoreFlowStatus
  readonly preview: RestorePreview | null
  readonly result: RestoreResult | null
  readonly error: GitReviewErrorState | null
}

export interface GitReviewSnapshot {
  readonly collectionStatus: ReviewCollectionStatus
  readonly baselineStatus: ReviewResourceStatus
  readonly baseline: GitBaseline | null
  readonly baselineError: GitReviewErrorState | null
  readonly items: readonly ReviewPackSummary[]
  readonly nextBeforeSequence: number | null
  readonly loadingMore: boolean
  readonly collectionError: GitReviewErrorState | null
  readonly selectedCheckpointId: string | null
  readonly detailStatus: ReviewResourceStatus
  readonly detail: ReviewPack | null
  readonly detailError: GitReviewErrorState | null
  readonly selectedFileId: string | null
  readonly diffStatus: ReviewResourceStatus
  readonly diff: FileDiffView | null
  readonly diffError: GitReviewErrorState | null
  readonly compare: CompareState
  readonly restore: RestoreState
}

type ReviewListener = () => void

const idleCompare: CompareState = {
  fromCheckpointId: null,
  toCheckpointId: null,
  status: "idle",
  result: null,
  error: null,
}

const idleRestore: RestoreState = {
  kind: null,
  status: "idle",
  preview: null,
  result: null,
  error: null,
}

const initialSnapshot: GitReviewSnapshot = {
  collectionStatus: "idle",
  baselineStatus: "idle",
  baseline: null,
  baselineError: null,
  items: [],
  nextBeforeSequence: null,
  loadingMore: false,
  collectionError: null,
  selectedCheckpointId: null,
  detailStatus: "idle",
  detail: null,
  detailError: null,
  selectedFileId: null,
  diffStatus: "idle",
  diff: null,
  diffError: null,
  compare: idleCompare,
  restore: idleRestore,
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
  private current: GitReviewSnapshot = initialSnapshot
  private readonly listeners = new Set<ReviewListener>()
  private initialization: Promise<void> | null = null
  private collectionGeneration = 0
  private baselineGeneration = 0
  private detailGeneration = 0
  private diffGeneration = 0
  private compareGeneration = 0
  private restoreGeneration = 0

  constructor(
    readonly workspaceId: string,
    private readonly transport: GitReviewTransport,
  ) {}

  snapshot = (): GitReviewSnapshot => this.current

  subscribe = (listener: ReviewListener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  initialize(): Promise<void> {
    if (this.initialization !== null) return this.initialization
    if (this.current.collectionStatus !== "idle") return Promise.resolve()

    this.initialization = this.refresh().finally(() => {
      this.initialization = null
    })
    return this.initialization
  }

  async refresh(): Promise<void> {
    const hasItems = this.current.items.length > 0
    this.setSnapshot({
      ...this.current,
      collectionStatus: hasItems ? "ready" : "loading",
      baselineStatus: this.current.baseline === null ? "loading" : "ready",
      collectionError: null,
      baselineError: null,
    })

    await Promise.all([this.loadBaseline(), this.loadFirstPage()])
  }

  async loadMore(): Promise<void> {
    const beforeSequence = this.current.nextBeforeSequence
    if (beforeSequence === null || this.current.loadingMore) return

    const generation = ++this.collectionGeneration
    this.setSnapshot({ ...this.current, loadingMore: true })
    try {
      const page = await this.transport.request(
        gitReviewCommands.listReviewPacks,
        {
          workspaceId: this.workspaceId,
          beforeSequence,
          limit: 50,
        },
      )
      if (generation !== this.collectionGeneration) return

      const known = new Set(this.current.items.map((item) => item.checkpointId))
      const additional = page.items.filter(
        (item) => !known.has(item.checkpointId),
      )
      this.setSnapshot({
        ...this.current,
        items: [...this.current.items, ...additional],
        nextBeforeSequence: page.nextBeforeSequence,
        loadingMore: false,
      })
    } catch (error) {
      if (generation !== this.collectionGeneration) return
      this.setSnapshot({
        ...this.current,
        loadingMore: false,
        collectionError: errorState(error, "GIT-REVIEW-PAGE-FAILED"),
      })
    }
  }

  async selectCheckpoint(checkpointId: string): Promise<void> {
    if (
      !this.current.items.some((item) => item.checkpointId === checkpointId)
    ) {
      return
    }

    const generation = ++this.detailGeneration
    ++this.diffGeneration
    ++this.restoreGeneration
    this.setSnapshot({
      ...this.current,
      selectedCheckpointId: checkpointId,
      detailStatus: "loading",
      detail: null,
      detailError: null,
      selectedFileId: null,
      diffStatus: "idle",
      diff: null,
      diffError: null,
      restore: idleRestore,
    })

    try {
      const detail = await this.transport.request(
        gitReviewCommands.readReviewPack,
        {
          workspaceId: this.workspaceId,
          checkpointId,
        },
      )
      if (
        generation !== this.detailGeneration ||
        this.current.selectedCheckpointId !== checkpointId
      ) {
        return
      }
      this.setSnapshot({
        ...this.current,
        detailStatus: "ready",
        detail,
        detailError: null,
      })
    } catch (error) {
      if (generation !== this.detailGeneration) return
      this.setSnapshot({
        ...this.current,
        detailStatus: "error",
        detail: null,
        detailError: errorState(error, "GIT-REVIEW-PACK-FAILED"),
      })
    }
  }

  async selectFile(fileId: string): Promise<void> {
    const checkpointId = this.current.selectedCheckpointId
    const detail = this.current.detail
    if (
      checkpointId === null ||
      detail === null ||
      !detail.manifest.some((file) => file.fileId === fileId)
    ) {
      return
    }

    const generation = ++this.diffGeneration
    this.setSnapshot({
      ...this.current,
      selectedFileId: fileId,
      diffStatus: "loading",
      diff: null,
      diffError: null,
    })

    try {
      const diff = await this.transport.request(
        gitReviewCommands.readFileDiff,
        {
          workspaceId: this.workspaceId,
          checkpointId,
          fileId,
        },
      )
      if (
        generation !== this.diffGeneration ||
        this.current.selectedCheckpointId !== checkpointId ||
        this.current.selectedFileId !== fileId
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
        diffError: errorState(error, "GIT-REVIEW-DIFF-FAILED"),
      })
    }
  }

  setCompareSelection(side: "from" | "to", checkpointId: string): void {
    if (
      !this.current.items.some((item) => item.checkpointId === checkpointId)
    ) {
      return
    }
    ++this.compareGeneration
    this.setSnapshot({
      ...this.current,
      compare: {
        ...this.current.compare,
        [side === "from" ? "fromCheckpointId" : "toCheckpointId"]: checkpointId,
        status: "idle",
        result: null,
        error: null,
      },
    })
  }

  async compareCheckpoints(): Promise<void> {
    const { fromCheckpointId, toCheckpointId } = this.current.compare
    if (
      fromCheckpointId === null ||
      toCheckpointId === null ||
      fromCheckpointId === toCheckpointId
    ) {
      this.setSnapshot({
        ...this.current,
        compare: {
          ...this.current.compare,
          status: "error",
          result: null,
          error: {
            code: "GIT-COMPARE-SELECTION-INVALID",
            userMessageKey: "gitReview.error.compareSelection",
            recoverable: true,
          },
        },
      })
      return
    }

    const generation = ++this.compareGeneration
    this.setSnapshot({
      ...this.current,
      compare: {
        ...this.current.compare,
        status: "loading",
        result: null,
        error: null,
      },
    })
    try {
      const result = await this.transport.request(
        gitReviewCommands.compareCheckpoints,
        {
          workspaceId: this.workspaceId,
          fromCheckpointId,
          toCheckpointId,
        },
      )
      if (generation !== this.compareGeneration) return
      this.setSnapshot({
        ...this.current,
        compare: {
          ...this.current.compare,
          status: "ready",
          result,
          error: null,
        },
      })
    } catch (error) {
      if (generation !== this.compareGeneration) return
      this.setSnapshot({
        ...this.current,
        compare: {
          ...this.current.compare,
          status: "error",
          result: null,
          error: errorState(error, "GIT-COMPARE-FAILED"),
        },
      })
    }
  }

  async previewRestore(
    kind: RestoreKind,
    recoveryBranch: string | null,
  ): Promise<void> {
    const checkpointId = this.current.selectedCheckpointId
    if (checkpointId === null || this.current.restore.status === "confirming") {
      return
    }

    const generation = ++this.restoreGeneration
    this.setSnapshot({
      ...this.current,
      restore: {
        kind,
        status: "previewing",
        preview: null,
        result: null,
        error: null,
      },
    })
    try {
      const preview = await this.transport.request(
        gitReviewCommands.previewRestore,
        {
          workspaceId: this.workspaceId,
          checkpointId,
          kind,
          recoveryBranch,
        },
      )
      if (
        generation !== this.restoreGeneration ||
        this.current.selectedCheckpointId !== checkpointId
      ) {
        return
      }
      this.setSnapshot({
        ...this.current,
        restore: {
          kind,
          status: preview.status === "ready" ? "ready" : "blocked",
          preview,
          result: null,
          error: null,
        },
      })
    } catch (error) {
      if (generation !== this.restoreGeneration) return
      this.setSnapshot({
        ...this.current,
        restore: {
          kind,
          status: "error",
          preview: null,
          result: null,
          error: errorState(error, "GIT-RESTORE-PREVIEW-FAILED"),
        },
      })
    }
  }

  async confirmRestore(): Promise<void> {
    const preview = this.current.restore.preview
    const confirmationToken = preview?.confirmationToken
    if (
      preview?.status !== "ready" ||
      confirmationToken === null ||
      confirmationToken === undefined
    ) {
      return
    }

    const generation = ++this.restoreGeneration
    this.setSnapshot({
      ...this.current,
      restore: { ...this.current.restore, status: "confirming", error: null },
    })
    try {
      const result = await this.transport.request(
        gitReviewCommands.confirmRestore,
        { workspaceId: this.workspaceId, confirmationToken },
      )
      if (generation !== this.restoreGeneration) return
      this.setSnapshot({
        ...this.current,
        restore: {
          kind: result.kind,
          status: "succeeded",
          preview: null,
          result,
          error: null,
        },
      })
    } catch (error) {
      if (generation !== this.restoreGeneration) return
      this.setSnapshot({
        ...this.current,
        restore: {
          ...this.current.restore,
          status: "error",
          error: errorState(error, "GIT-RESTORE-CONFIRM-FAILED"),
        },
      })
    }
  }

  async cancelRestore(): Promise<void> {
    const confirmationToken = this.current.restore.preview?.confirmationToken
    const generation = ++this.restoreGeneration
    if (confirmationToken === null || confirmationToken === undefined) {
      this.setSnapshot({ ...this.current, restore: idleRestore })
      return
    }

    try {
      await this.transport.request(gitReviewCommands.cancelRestore, {
        workspaceId: this.workspaceId,
        confirmationToken,
      })
      if (generation !== this.restoreGeneration) return
      this.setSnapshot({ ...this.current, restore: idleRestore })
    } catch (error) {
      if (generation !== this.restoreGeneration) return
      this.setSnapshot({
        ...this.current,
        restore: {
          ...this.current.restore,
          status: "error",
          error: errorState(error, "GIT-RESTORE-CANCEL-FAILED"),
        },
      })
    }
  }

  clearRestoreResult(): void {
    ++this.restoreGeneration
    this.setSnapshot({ ...this.current, restore: idleRestore })
  }

  private async loadBaseline(): Promise<void> {
    const generation = ++this.baselineGeneration
    try {
      const baseline = await this.transport.request(
        gitReviewCommands.inspectBaseline,
        { workspaceId: this.workspaceId },
      )
      if (generation !== this.baselineGeneration) return
      this.setSnapshot({
        ...this.current,
        baselineStatus: "ready",
        baseline,
        baselineError: null,
      })
    } catch (error) {
      if (generation !== this.baselineGeneration) return
      this.setSnapshot({
        ...this.current,
        baselineStatus: "error",
        baselineError: errorState(error, "GIT-BASELINE-FAILED"),
      })
    }
  }

  private async loadFirstPage(): Promise<void> {
    const generation = ++this.collectionGeneration
    try {
      const page = await this.transport.request(
        gitReviewCommands.listReviewPacks,
        {
          workspaceId: this.workspaceId,
          beforeSequence: null,
          limit: 50,
        },
      )
      if (generation !== this.collectionGeneration) return

      const retainedSelection = page.items.some(
        (item) => item.checkpointId === this.current.selectedCheckpointId,
      )
        ? this.current.selectedCheckpointId
        : null
      const selectedCheckpointId =
        retainedSelection ?? page.items[0]?.checkpointId ?? null
      const compareFrom = page.items[1]?.checkpointId ?? null
      const compareTo = page.items[0]?.checkpointId ?? null

      this.setSnapshot({
        ...this.current,
        collectionStatus: page.items.length === 0 ? "empty" : "ready",
        items: page.items,
        nextBeforeSequence: page.nextBeforeSequence,
        loadingMore: false,
        collectionError: null,
        selectedCheckpointId,
        compare: {
          fromCheckpointId:
            this.current.compare.fromCheckpointId ?? compareFrom,
          toCheckpointId: this.current.compare.toCheckpointId ?? compareTo,
          status: "idle",
          result: null,
          error: null,
        },
      })

      if (selectedCheckpointId !== null) {
        await this.selectCheckpoint(selectedCheckpointId)
      } else {
        ++this.detailGeneration
        ++this.diffGeneration
        this.setSnapshot({
          ...this.current,
          selectedCheckpointId: null,
          detailStatus: "idle",
          detail: null,
          detailError: null,
          selectedFileId: null,
          diffStatus: "idle",
          diff: null,
          diffError: null,
        })
      }
    } catch (error) {
      if (generation !== this.collectionGeneration) return
      this.setSnapshot({
        ...this.current,
        collectionStatus: this.current.items.length > 0 ? "ready" : "error",
        loadingMore: false,
        collectionError: errorState(error, "GIT-REVIEW-LIST-FAILED"),
      })
    }
  }

  private setSnapshot(snapshot: GitReviewSnapshot): void {
    this.current = snapshot
    for (const listener of this.listeners) listener()
  }
}
