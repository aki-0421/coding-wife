import {
  appPreferencesSchemaVersion,
  createSafeDefaultPreferences,
  type AppLocale,
  type AppPreferencesPersistence,
  type AppPreferencesSnapshotV1,
  type AppPreferencesV1,
  type CharacterVisibility,
  type ReducedMotionPreference,
} from "@/features/preferences/contracts"
import {
  AppPreferencesBoundaryError,
  type AppPreferencesGateway,
} from "@/features/preferences/transport"

export type AppPreferencesControllerStatus =
  "loading" | "ready" | "saving" | "recovery" | "error"

export interface AppPreferencesControllerState {
  readonly status: AppPreferencesControllerStatus
  readonly snapshot: AppPreferencesSnapshotV1
  readonly pendingPreferences: AppPreferencesV1 | null
  readonly errorCode: string | null
}

export type AppPreferencesPatch = Readonly<{
  locale?: AppLocale
  reducedMotion?: ReducedMotionPreference
  characterVisibility?: CharacterVisibility
}>

type Listener = () => void

function initialSnapshot(
  locale: AppLocale,
  persistence: AppPreferencesPersistence,
): AppPreferencesSnapshotV1 {
  return {
    schemaVersion: appPreferencesSchemaVersion,
    preferences: createSafeDefaultPreferences(locale),
    persistence,
    recoveryCode: null,
  }
}

function statusFor(
  snapshot: AppPreferencesSnapshotV1,
): AppPreferencesControllerStatus {
  return snapshot.recoveryCode === null ? "ready" : "recovery"
}

function safeErrorCode(error: unknown): string {
  return error instanceof AppPreferencesBoundaryError
    ? error.code
    : "APP-PREFERENCES-IPC-UNAVAILABLE"
}

function samePreferences(
  left: AppPreferencesV1,
  right: AppPreferencesV1,
): boolean {
  return (
    left.locale === right.locale &&
    left.reducedMotion === right.reducedMotion &&
    left.characterVisibility === right.characterVisibility
  )
}

export class AppPreferencesController {
  readonly #gateway: AppPreferencesGateway
  readonly #defaultLocale: AppLocale
  readonly #listeners = new Set<Listener>()
  #state: AppPreferencesControllerState
  #authoritative: AppPreferencesSnapshotV1
  #initializePromise: Promise<boolean> | null = null
  #operation: Promise<void> = Promise.resolve()
  #updateDrain: Promise<boolean> | null = null
  #latestMutation = 0
  #desired: AppPreferencesV1 | null = null
  #disposed = false

  public constructor(gateway: AppPreferencesGateway, defaultLocale: AppLocale) {
    this.#gateway = gateway
    this.#defaultLocale = defaultLocale
    const snapshot = initialSnapshot(
      defaultLocale,
      gateway.kind === "native" ? "native" : "demo_memory",
    )
    this.#authoritative = snapshot
    this.#state = {
      status: "loading",
      snapshot,
      pendingPreferences: null,
      errorCode: null,
    }
  }

  public readonly subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  public readonly getSnapshot = (): AppPreferencesControllerState => this.#state

  public initialize(): Promise<boolean> {
    if (this.#initializePromise !== null) return this.#initializePromise
    this.#initializePromise = this.#gateway.get(this.#defaultLocale).then(
      (snapshot) => {
        if (this.#disposed) return false
        this.#authoritative = snapshot
        this.publish({
          status: this.#desired === null ? statusFor(snapshot) : "saving",
          snapshot,
          pendingPreferences: this.#desired,
          errorCode: null,
        })
        return true
      },
      (error: unknown) => {
        if (this.#disposed) return false
        this.#desired = null
        this.publish({
          status: "error",
          snapshot: this.#authoritative,
          pendingPreferences: null,
          errorCode: safeErrorCode(error),
        })
        return false
      },
    )
    return this.#initializePromise
  }

  public update(patch: AppPreferencesPatch): Promise<boolean> {
    const currentDesired = this.#desired ?? this.#authoritative.preferences
    const desired: AppPreferencesV1 = {
      ...currentDesired,
      ...patch,
    }

    if (
      this.#desired === null &&
      samePreferences(desired, this.#authoritative.preferences)
    ) {
      return Promise.resolve(true)
    }

    this.#desired = desired
    this.#latestMutation += 1
    this.publish({
      ...this.#state,
      status: "saving",
      pendingPreferences: desired,
      errorCode: null,
    })
    return this.ensureUpdateDrain()
  }

  public reset(): Promise<boolean> {
    const desired: AppPreferencesV1 = {
      ...createSafeDefaultPreferences(this.#defaultLocale),
      version: this.#authoritative.preferences.version,
      snapshotId: this.#authoritative.preferences.snapshotId,
    }
    this.#desired = desired
    const mutation = ++this.#latestMutation
    this.publish({
      ...this.#state,
      status: "saving",
      pendingPreferences: desired,
      errorCode: null,
    })

    let succeeded = false
    const run = this.#operation.then(async () => {
      if (!(await this.initialize()) || this.#disposed) return
      try {
        const snapshot = await this.#gateway.reset({
          schemaVersion: appPreferencesSchemaVersion,
          expectedVersion: this.#authoritative.preferences.version,
          defaultLocale: this.#defaultLocale,
        })
        this.#authoritative = snapshot
        succeeded = true

        if (mutation === this.#latestMutation) {
          this.#desired = null
          this.publish({
            status: statusFor(snapshot),
            snapshot,
            pendingPreferences: null,
            errorCode: null,
          })
        }
      } catch (error) {
        if (mutation === this.#latestMutation && !this.#disposed) {
          this.#desired = null
          this.publish({
            status: "error",
            snapshot: this.#authoritative,
            pendingPreferences: null,
            errorCode: safeErrorCode(error),
          })
        }
      }
    })
    this.#operation = run.then(
      () => undefined,
      () => undefined,
    )
    return run.then(() => succeeded)
  }

  public retry(): Promise<boolean> {
    if (this.#state.status !== "error") return Promise.resolve(true)
    this.#initializePromise = null
    this.publish({
      ...this.#state,
      status: "loading",
      pendingPreferences: null,
      errorCode: null,
    })
    return this.initialize()
  }

  public dispose(): void {
    this.#disposed = true
    this.#desired = null
    this.#listeners.clear()
  }

  private ensureUpdateDrain(): Promise<boolean> {
    if (this.#updateDrain !== null) return this.#updateDrain

    const drain = this.#operation.then(() => this.drainUpdates())
    this.#updateDrain = drain
    this.#operation = drain.then(
      () => undefined,
      () => undefined,
    )
    void drain.finally(() => {
      if (this.#updateDrain === drain) this.#updateDrain = null
    })
    return drain
  }

  private async drainUpdates(): Promise<boolean> {
    if (!(await this.initialize()) || this.#disposed) {
      this.#desired = null
      return false
    }

    while (this.#desired !== null && !this.#disposed) {
      const candidate = this.#desired

      if (samePreferences(candidate, this.#authoritative.preferences)) {
        this.#desired = null
        break
      }

      try {
        const snapshot = await this.#gateway.update({
          schemaVersion: appPreferencesSchemaVersion,
          expectedVersion: this.#authoritative.preferences.version,
          locale: candidate.locale,
          reducedMotion: candidate.reducedMotion,
          characterVisibility: candidate.characterVisibility,
        })
        this.#authoritative = snapshot

        if (
          this.#desired !== null &&
          samePreferences(this.#desired, this.#authoritative.preferences)
        ) {
          this.#desired = null
        }
      } catch (error) {
        if (
          this.#desired !== null &&
          !samePreferences(this.#desired, candidate)
        ) {
          continue
        }

        this.#desired = null
        this.publish({
          status: "error",
          snapshot: this.#authoritative,
          pendingPreferences: null,
          errorCode: safeErrorCode(error),
        })
        return false
      }

      if (this.#desired !== null) {
        this.publish({
          ...this.#state,
          status: "saving",
          pendingPreferences: this.#desired,
          errorCode: null,
        })
      }
    }

    if (this.#disposed) return false

    this.publish({
      status: statusFor(this.#authoritative),
      snapshot: this.#authoritative,
      pendingPreferences: null,
      errorCode: null,
    })
    return true
  }

  private publish(state: AppPreferencesControllerState): void {
    if (this.#disposed) return
    this.#state = state
    for (const listener of this.#listeners) listener()
  }
}
