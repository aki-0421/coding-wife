import {
  supportControlSchemaVersion,
  type SupportControlSnapshotV1,
} from "@/features/support-controls/contracts"
import {
  SupportControlsBoundaryError,
  type SupportControlsGateway,
} from "@/features/support-controls/transport"

export type SupportControlsStatus = "loading" | "ready" | "saving" | "error"

export interface SupportControlsControllerState {
  readonly status: SupportControlsStatus
  readonly snapshot: SupportControlSnapshotV1 | null
  readonly errorCode: string | null
}

export interface SupportControlsPatch {
  readonly globalEnabled?: boolean
  readonly commitExplainerEnabled?: boolean
}

type Listener = () => void

function errorCode(error: unknown): string {
  return error instanceof SupportControlsBoundaryError
    ? error.code
    : "CODEX-SUPPORT-IPC-UNAVAILABLE"
}

export class SupportControlsController {
  readonly #gateway: SupportControlsGateway
  readonly #listeners = new Set<Listener>()
  #state: SupportControlsControllerState = {
    status: "loading",
    snapshot: null,
    errorCode: null,
  }
  #initialize: Promise<boolean> | null = null
  #operation: Promise<void> = Promise.resolve()
  #disposed = false

  public constructor(gateway: SupportControlsGateway) {
    this.#gateway = gateway
  }

  public readonly subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  public readonly getSnapshot = (): SupportControlsControllerState =>
    this.#state

  public initialize(): Promise<boolean> {
    if (this.#initialize !== null) return this.#initialize
    const load = this.#gateway.get().then(
      (snapshot) => {
        if (this.#disposed) return false
        this.publish({ status: "ready", snapshot, errorCode: null })
        return true
      },
      (error: unknown) => this.fail(error),
    )
    this.#initialize = load
    void load.finally(() => {
      if (this.#initialize === load) this.#initialize = null
    })
    return load
  }

  public refresh(): Promise<boolean> {
    if (this.#disposed || this.#state.status === "saving") {
      return Promise.resolve(false)
    }
    this.#initialize = null
    this.publish({ ...this.#state, status: "loading", errorCode: null })
    return this.initialize()
  }

  public update(patch: SupportControlsPatch): Promise<boolean> {
    if (this.#disposed) return Promise.resolve(false)
    const run = this.#operation.then(async () => {
      if (this.#state.snapshot === null && !(await this.initialize())) {
        return false
      }
      const current = this.#state.snapshot
      if (current === null || this.#disposed) return false
      const globalEnabled =
        patch.globalEnabled ?? current.settings.globalEnabled
      const commitExplainerEnabled =
        patch.commitExplainerEnabled ?? current.settings.commitExplainerEnabled
      if (
        globalEnabled === current.settings.globalEnabled &&
        commitExplainerEnabled === current.settings.commitExplainerEnabled
      ) {
        return true
      }
      this.publish({ ...this.#state, status: "saving", errorCode: null })
      try {
        const snapshot = await this.#gateway.update({
          schemaVersion: supportControlSchemaVersion,
          expectedVersion: current.settings.version,
          globalEnabled,
          commitExplainerEnabled,
        })
        if (this.#disposed) return false
        this.publish({ status: "ready", snapshot, errorCode: null })
        return true
      } catch (error) {
        return this.fail(error)
      }
    })
    this.#operation = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  public dispose(): void {
    this.#disposed = true
    this.#listeners.clear()
  }

  private fail(error: unknown): false {
    if (!this.#disposed) {
      this.publish({
        ...this.#state,
        status: "error",
        errorCode: errorCode(error),
      })
    }
    return false
  }

  private publish(state: SupportControlsControllerState): void {
    this.#state = state
    this.#listeners.forEach((listener) => listener())
  }
}
