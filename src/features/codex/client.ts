import {
  codexCommands,
  type CodexEvent,
  type CodexFallbackDecisionRequest,
  type CodexPendingResponseRequest,
} from "@/lib/contracts"

import type { CodexTransport } from "@/features/codex/transport"
import {
  CodexSessionStore,
  type CodexEventApplyResult,
} from "@/features/codex/session-store"

export class CodexSessionClient {
  private unsubscribe: (() => void) | null = null

  constructor(
    readonly transport: CodexTransport,
    readonly store = new CodexSessionStore(),
  ) {}

  async start(
    onContractError: (error: Error) => void,
    onEvent?: (event: CodexEvent, result: CodexEventApplyResult) => void,
    shouldApplyEvent?: (event: CodexEvent) => boolean,
  ): Promise<void> {
    if (this.unsubscribe !== null) return
    this.unsubscribe = await this.transport.subscribe({
      onEvent: (event) => {
        if (shouldApplyEvent !== undefined && !shouldApplyEvent(event)) {
          onEvent?.(event, "workspace_mismatch")
          return
        }
        const result = this.store.apply(event)
        onEvent?.(event, result)
      },
      onContractError,
    })
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  async respondPending(request: CodexPendingResponseRequest): Promise<boolean> {
    if (!this.store.claimPendingResponse(request)) {
      return false
    }
    try {
      const result = await this.transport.request(
        codexCommands.respondPending,
        request,
      )
      if (!result.accepted) {
        this.store.releasePendingResponse(request.pendingId)
        return false
      }
      this.store.completePendingResponse(request.pendingId)
      return true
    } catch (error) {
      this.store.releasePendingResponse(request.pendingId)
      throw error
    }
  }

  async answerFallbackDecision(
    request: CodexFallbackDecisionRequest,
  ): Promise<boolean> {
    if (!this.store.claimFallbackDecision(request)) return false
    try {
      await this.transport.request(
        codexCommands.answerFallbackDecision,
        request,
      )
      this.store.completePendingResponse(request.decisionHandle)
      return true
    } catch (error) {
      this.store.releasePendingResponse(request.decisionHandle)
      throw error
    }
  }
}
