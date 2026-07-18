import { useSyncExternalStore } from "react"

import {
  GitReviewStore,
  type GitReviewSnapshot,
} from "@/features/git-review/store"
import type {
  CommitEvidenceFilter,
  CommitExplanationControllerStateV1,
  CommitExplanationPresentationMode,
  CommitExplanationUserRequestTrigger,
} from "@/lib/contracts/git-review"

export interface GitReviewController extends GitReviewSnapshot {
  readonly activate: () => Promise<void>
  readonly deactivate: () => void
  readonly refresh: () => Promise<void>
  readonly setFilter: (filter: CommitEvidenceFilter) => Promise<void>
  readonly loadMore: () => Promise<void>
  readonly selectCommitEvidence: (commitEvidenceId: string) => Promise<void>
  readonly selectFile: (fileEvidenceId: string) => Promise<void>
  readonly requestExplanation: (
    locale: "ja" | "en",
    trigger: CommitExplanationUserRequestTrigger,
  ) => Promise<void>
  readonly cancelExplanation: (
    state: CommitExplanationControllerStateV1,
  ) => Promise<void>
  readonly presentExplanation: (
    state: CommitExplanationControllerStateV1,
    mode: CommitExplanationPresentationMode,
  ) => Promise<void>
}

export function useGitReview(store: GitReviewStore): GitReviewController {
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.snapshot,
    store.snapshot,
  )

  return {
    ...snapshot,
    activate: () => store.activate(),
    deactivate: () => store.deactivate(),
    refresh: () => store.refresh(),
    setFilter: (filter) => store.setFilter(filter),
    loadMore: () => store.loadMore(),
    selectCommitEvidence: (commitEvidenceId) =>
      store.selectCommitEvidence(commitEvidenceId),
    selectFile: (fileEvidenceId) => store.selectFile(fileEvidenceId),
    requestExplanation: (locale, trigger) =>
      store.requestExplanation(locale, trigger),
    cancelExplanation: (state) => store.cancelExplanation(state),
    presentExplanation: (state, mode) => store.presentExplanation(state, mode),
  }
}
