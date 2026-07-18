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
  #generation = 0
  #active = true
  #retired = false

  public constructor(gateway: SupportControlsGateway) {
    this.#gateway = gateway
  }

  public readonly subscribe = (listener: Listener): (() => void) => {
    if (this.#retired) return () => undefined
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  public readonly getSnapshot = (): SupportControlsControllerState =>
    this.#state

  public activate(): number {
    if (this.#retired) return this.#generation
    this.#active = true
    this.#generation += 1
    this.#initialize = null
    this.#operation = Promise.resolve()
    return this.#generation
  }

  public deactivate(lease: number): void {
    if (lease !== this.#generation) return
    this.#active = false
    this.#generation += 1
    this.#initialize = null
    this.#operation = Promise.resolve()
    this.#listeners.clear()
  }

  public initialize(): Promise<boolean> {
    if (this.#initialize !== null) return this.#initialize
    const generation = this.#generation
    if (!this.isCurrent(generation)) return Promise.resolve(false)
    const load = this.#gateway.get().then(
      (snapshot) => {
        if (!this.isCurrent(generation)) return false
        this.publish({ status: "ready", snapshot, errorCode: null })
        return true
      },
      (error: unknown) => this.fail(error, generation),
    )
    this.#initialize = load
    void load.finally(() => {
      if (this.#initialize === load) this.#initialize = null
    })
    return load
  }

  public refresh(): Promise<boolean> {
    const generation = this.#generation
    if (!this.isCurrent(generation) || this.#state.status === "saving") {
      return Promise.resolve(false)
    }
    this.#initialize = null
    this.publish({ ...this.#state, status: "loading", errorCode: null })
    return this.initialize()
  }

  public update(patch: SupportControlsPatch): Promise<boolean> {
    const generation = this.#generation
    if (!this.isCurrent(generation)) return Promise.resolve(false)
    const run = this.#operation.then(async () => {
      if (!this.isCurrent(generation)) return false
      if (this.#state.snapshot === null && !(await this.initialize())) {
        return false
      }
      const current = this.#state.snapshot
      if (current === null || !this.isCurrent(generation)) return false
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
        if (!this.isCurrent(generation)) return false
        this.publish({ status: "ready", snapshot, errorCode: null })
        return true
      } catch (error) {
        if (!this.isCurrent(generation)) return false
        const updateErrorCode = errorCode(error)
        let snapshot = this.#state.snapshot
        try {
          snapshot = await this.#gateway.get()
        } catch {
          // Preserve the authoritative update error when a recovery read also fails.
        }
        if (!this.isCurrent(generation)) return false
        this.publish({ status: "error", snapshot, errorCode: updateErrorCode })
        return false
      }
    })
    this.#operation = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  public dispose(): void {
    this.#retired = true
    this.#active = false
    this.#generation += 1
    this.#initialize = null
    this.#operation = Promise.resolve()
    this.#listeners.clear()
  }

  private fail(error: unknown, generation: number): false {
    if (this.isCurrent(generation)) {
      this.publish({
        ...this.#state,
        status: "error",
        errorCode: errorCode(error),
      })
    }
    return false
  }

  private isCurrent(generation: number): boolean {
    return this.#active && !this.#retired && generation === this.#generation
  }

  private publish(state: SupportControlsControllerState): void {
    this.#state = state
    this.#listeners.forEach((listener) => listener())
  }
}
