import type { NativeReadinessSnapshotV1 } from "@/features/readiness/contracts"
import {
  NativeReadinessBoundaryError,
  type NativeReadinessGateway,
} from "@/features/readiness/transport"

export type NativeReadinessControllerStatus =
  | "loading"
  | "ready"
  | "rechecking"
  | "configuring"
  | "error"
export type NativeReadinessCopyStatus = "idle" | "copying" | "copied" | "error"
export type NativeReadinessRecheckOutcome =
  | "idle"
  | "complete"
  | "attention"
  | "failed"

export interface NativeReadinessControllerState {
  readonly status: NativeReadinessControllerStatus
  readonly snapshot: NativeReadinessSnapshotV1 | null
  readonly errorCode: string | null
  readonly copyStatus: NativeReadinessCopyStatus
  readonly recheckSequence: number
  readonly recheckOutcome: NativeReadinessRecheckOutcome
}

export interface DiagnosticsClipboard {
  writeText(value: string): Promise<void>
}

type Listener = () => void

const browserClipboard: DiagnosticsClipboard = {
  writeText(value) {
    if (typeof navigator === "undefined" || navigator.clipboard === undefined) {
      return Promise.reject(new Error("clipboard unavailable"))
    }
    return navigator.clipboard.writeText(value)
  },
}

function safeErrorCode(error: unknown): string {
  return error instanceof NativeReadinessBoundaryError
    ? error.code
    : "READINESS-IPC-UNAVAILABLE"
}

export class NativeReadinessController {
  readonly #gateway: NativeReadinessGateway
  readonly #clipboard: DiagnosticsClipboard
  readonly #listeners = new Set<Listener>()
  #state: NativeReadinessControllerState = {
    status: "loading",
    snapshot: null,
    errorCode: null,
    copyStatus: "idle",
    recheckSequence: 0,
    recheckOutcome: "idle",
  }
  #initializePromise: Promise<boolean> | null = null
  #runSequence = 0
  #copySequence = 0
  #disposed = false

  public constructor(
    gateway: NativeReadinessGateway,
    clipboard: DiagnosticsClipboard = browserClipboard,
  ) {
    this.#gateway = gateway
    this.#clipboard = clipboard
  }

  public readonly subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  public readonly getSnapshot = (): NativeReadinessControllerState =>
    this.#state

  public initialize(): Promise<boolean> {
    if (this.#initializePromise !== null) return this.#initializePromise
    this.#initializePromise = this.run(false)
    return this.#initializePromise
  }

  public recheck(): Promise<boolean> {
    return this.run(true)
  }

  public configureCodexBinary(path: string | null): Promise<boolean> {
    return this.configure(path)
  }

  public async copy(): Promise<boolean> {
    const snapshot = this.#state.snapshot
    if (snapshot === null || this.#state.copyStatus === "copying") return false
    const sequence = this.#copySequence + 1
    this.#copySequence = sequence
    this.publish({ ...this.#state, copyStatus: "copying", errorCode: null })
    try {
      const result = await this.#gateway.copy(snapshot.snapshotId)
      await this.#clipboard.writeText(result.summary)
      if (this.#disposed || sequence !== this.#copySequence) return false
      this.publish({ ...this.#state, copyStatus: "copied", errorCode: null })
      return true
    } catch (error) {
      if (!this.#disposed && sequence === this.#copySequence) {
        this.publish({
          ...this.#state,
          copyStatus: "error",
          errorCode: safeErrorCode(error),
        })
      }
      return false
    }
  }

  public dispose(): void {
    this.#disposed = true
    this.#listeners.clear()
  }

  private async run(rechecking: boolean): Promise<boolean> {
    const sequence = this.#runSequence + 1
    this.#runSequence = sequence
    this.publish({
      ...this.#state,
      status:
        rechecking && this.#state.snapshot !== null ? "rechecking" : "loading",
      errorCode: null,
      copyStatus: "idle",
      recheckOutcome: rechecking ? "idle" : this.#state.recheckOutcome,
    })
    try {
      const snapshot = await this.#gateway.run()
      if (this.#disposed || sequence !== this.#runSequence) return false
      this.publish({
        status: "ready",
        snapshot,
        errorCode: null,
        copyStatus: "idle",
        recheckSequence: this.#state.recheckSequence + (rechecking ? 1 : 0),
        recheckOutcome: rechecking
          ? snapshot.checks.some(
              (check) =>
                check.status === "blocked" || check.status === "unavailable",
            )
            ? "attention"
            : "complete"
          : this.#state.recheckOutcome,
      })
      return true
    } catch (error) {
      if (!this.#disposed && sequence === this.#runSequence) {
        this.publish({
          ...this.#state,
          status: "error",
          errorCode: safeErrorCode(error),
          copyStatus: "idle",
          recheckSequence: this.#state.recheckSequence + (rechecking ? 1 : 0),
          recheckOutcome: rechecking ? "failed" : this.#state.recheckOutcome,
        })
      }
      return false
    }
  }

  private async configure(path: string | null): Promise<boolean> {
    const sequence = this.#runSequence + 1
    this.#runSequence = sequence
    this.publish({
      ...this.#state,
      status: "configuring",
      errorCode: null,
      copyStatus: "idle",
      recheckOutcome: "idle",
    })
    try {
      const snapshot = await this.#gateway.configureCodexBinary(path)
      if (this.#disposed || sequence !== this.#runSequence) return false
      this.publish({
        status: "ready",
        snapshot,
        errorCode: null,
        copyStatus: "idle",
        recheckSequence: this.#state.recheckSequence + 1,
        recheckOutcome: snapshot.checks.some(
          (check) =>
            check.status === "blocked" || check.status === "unavailable",
        )
          ? "attention"
          : "complete",
      })
      return true
    } catch (error) {
      if (!this.#disposed && sequence === this.#runSequence) {
        this.publish({
          ...this.#state,
          status: "error",
          errorCode: safeErrorCode(error),
          copyStatus: "idle",
          recheckSequence: this.#state.recheckSequence + 1,
          recheckOutcome: "failed",
        })
      }
      return false
    }
  }

  private publish(state: NativeReadinessControllerState): void {
    if (this.#disposed) return
    this.#state = state
    for (const listener of this.#listeners) listener()
  }
}
