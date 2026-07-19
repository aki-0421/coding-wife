export {
  DemoGitReviewTransport,
  demoCurrentCommitEvidenceId,
  demoCurrentCommitSha,
} from "@/features/git-review/demo-transport"
export {
  DemoCommitExplanationRuntime,
  type DemoCommitExplanationRuntimeOptions,
} from "@/features/git-review/demo-commit-explanation-runtime"
export {
  CommitExplanationBoundaryError,
  TauriCommitExplanationAdapter,
  type CommitExplanationAppRuntime,
  type CommitExplanationPresentationActivator,
  type ScopedCommitExplanationController,
} from "@/features/git-review/commit-explanation-adapter"
export {
  EvidenceView,
  type EvidenceViewProps,
} from "@/features/git-review/EvidenceView"
export {
  GitReviewStore,
  type GitReviewSnapshot,
} from "@/features/git-review/store"
export {
  GitReviewBoundaryError,
  TauriGitReviewTransport,
  type GitReviewTransport,
} from "@/features/git-review/transport"
