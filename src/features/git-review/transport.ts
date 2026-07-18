import { invoke } from "@tauri-apps/api/core"

import {
  GitReviewContractError,
  parseGitReviewError,
  parseGitReviewResponse,
  type GitReviewCommand,
  type GitReviewErrorEnvelope,
  type GitReviewRequestMap,
  type GitReviewResponseMap,
} from "@/lib/contracts/git-review"

export type GitReviewTransportKind = "tauri" | "demo"

export type GitReviewInvoker = (
  command: GitReviewCommand,
  request: unknown,
) => Promise<unknown>

export interface GitReviewTransport {
  readonly kind: GitReviewTransportKind
  request<K extends GitReviewCommand>(
    command: K,
    request: GitReviewRequestMap[K],
  ): Promise<GitReviewResponseMap[K]>
}

export class GitReviewBoundaryError
  extends Error
  implements GitReviewErrorEnvelope
{
  readonly code: string
  readonly operation: string
  readonly recoverable: boolean
  readonly userMessageKey: string
  readonly detailRef?: string

  constructor(envelope: GitReviewErrorEnvelope) {
    super(envelope.code)
    this.name = "GitReviewBoundaryError"
    this.code = envelope.code
    this.operation = envelope.operation
    this.recoverable = envelope.recoverable
    this.userMessageKey = envelope.userMessageKey
    if (envelope.detailRef !== undefined) this.detailRef = envelope.detailRef
  }
}

const invokeTauri: GitReviewInvoker = (command, request) =>
  invoke(command, { request })

function contractError(operation: GitReviewCommand): GitReviewBoundaryError {
  return new GitReviewBoundaryError({
    code: "GIT-IPC-CONTRACT-MISMATCH",
    operation,
    recoverable: false,
    userMessageKey: "gitReview.error.contract",
    detailRef: "git-review-v1",
  })
}

function unavailableError(operation: GitReviewCommand): GitReviewBoundaryError {
  return new GitReviewBoundaryError({
    code: "GIT-IPC-UNAVAILABLE",
    operation,
    recoverable: true,
    userMessageKey: "gitReview.error.unavailable",
  })
}

function normalizeError(
  operation: GitReviewCommand,
  error: unknown,
): GitReviewBoundaryError {
  if (error instanceof GitReviewBoundaryError) return error
  if (error instanceof GitReviewContractError) return contractError(operation)

  try {
    return new GitReviewBoundaryError(parseGitReviewError(error))
  } catch {
    return unavailableError(operation)
  }
}

export class TauriGitReviewTransport implements GitReviewTransport {
  readonly kind = "tauri"

  constructor(private readonly invoker: GitReviewInvoker = invokeTauri) {}

  async request<K extends GitReviewCommand>(
    command: K,
    request: GitReviewRequestMap[K],
  ): Promise<GitReviewResponseMap[K]> {
    try {
      const response = await this.invoker(command, request)
      return parseGitReviewResponse(command, response)
    } catch (error) {
      throw normalizeError(command, error)
    }
  }
}
