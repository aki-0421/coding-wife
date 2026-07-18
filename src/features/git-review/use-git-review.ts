import { useSyncExternalStore } from "react"

import {
  GitReviewStore,
  type GitReviewSnapshot,
} from "@/features/git-review/store"

export interface GitReviewController extends GitReviewSnapshot {
  readonly refresh: () => Promise<void>
  readonly loadMore: () => Promise<void>
  readonly selectCheckpoint: (checkpointId: string) => Promise<void>
  readonly selectFile: (fileId: string) => Promise<void>
  readonly setCompareSelection: (
    side: "from" | "to",
    checkpointId: string,
  ) => void
  readonly compareCheckpoints: () => Promise<void>
  readonly previewRestore: (
    kind: "revert_commit" | "recovery_branch",
    recoveryBranch: string | null,
  ) => Promise<void>
  readonly confirmRestore: () => Promise<void>
  readonly cancelRestore: () => Promise<void>
  readonly clearRestoreResult: () => void
}

export function useGitReview(store: GitReviewStore): GitReviewController {
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.snapshot,
    store.snapshot,
  )

  return {
    ...snapshot,
    refresh: () => store.refresh(),
    loadMore: () => store.loadMore(),
    selectCheckpoint: (checkpointId) => store.selectCheckpoint(checkpointId),
    selectFile: (fileId) => store.selectFile(fileId),
    setCompareSelection: (side, checkpointId) =>
      store.setCompareSelection(side, checkpointId),
    compareCheckpoints: () => store.compareCheckpoints(),
    previewRestore: (kind, recoveryBranch) =>
      store.previewRestore(kind, recoveryBranch),
    confirmRestore: () => store.confirmRestore(),
    cancelRestore: () => store.cancelRestore(),
    clearRestoreResult: () => store.clearRestoreResult(),
  }
}
