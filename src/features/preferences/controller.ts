import {
  appPreferencesSchemaVersion,
  createSafeDefaultPreferences,
  type AppLocale,
  type AppPreferencesPersistence,
  type AppPreferencesSnapshotV2,
  type AppPreferencesV2,
} from "@/features/preferences/contracts"
import {
  AppPreferencesBoundaryError,
  type AppPreferencesGateway,
} from "@/features/preferences/transport"

export type AppPreferencesControllerStatus =
  | "loading"
  | "ready"
  | "saving"
  | "recovery"
  | "error"

export interface AppPreferencesControllerState {
  readonly status: AppPreferencesControllerStatus
  readonly snapshot: AppPreferencesSnapshotV2
  readonly pendingPreferences: AppPreferencesV2 | null
  readonly errorCode: string | null
}

export type AppPreferencesPatch = Readonly<{
  locale?: AppLocale
}>

type Listener = () => void
const maxWriteRebaseAttempts = 3

function initialSnapshot(
  locale: AppLocale,
  persistence: AppPreferencesPersistence,
): AppPreferencesSnapshotV2 {
  return {
    schemaVersion: appPreferencesSchemaVersion,
    preferences: createSafeDefaultPreferences(locale),
    persistence,
    recoveryCode: null,
  }
}

function statusFor(
  snapshot: AppPreferencesSnapshotV2,
): AppPreferencesControllerStatus {
  return snapshot.recoveryCode === null ? "ready" : "recovery"
}

function safeErrorCode(error: unknown): string {
  return error instanceof AppPreferencesBoundaryError
    ? error.code
    : "APP-PREFERENCES-IPC-UNAVAILABLE"
}

function samePreferences(
  left: AppPreferencesV2,
  right: AppPreferencesV2,
): boolean {
  return left.locale === right.locale
}

function applyPatch(
  preferences: AppPreferencesV2,
  patch: AppPreferencesPatch,
): AppPreferencesV2 {
  return { ...preferences, ...patch }
}

function ambiguousWriteError(): AppPreferencesBoundaryError {
  return new AppPreferencesBoundaryError({
    code: "APP-PREFERENCES-CONFLICT",
    operation: "app_preferences_reconcile",
    recoverable: true,
    userMessageKey: "preferences.error.generic",
    detailRef: "app-preferences-v2",
  })
}

function acceptedWriteSnapshot(
  snapshot: AppPreferencesSnapshotV2,
  expectedVersion: number,
  expectedPreferences: AppPreferencesV2,
): boolean {
  return (
    snapshot.recoveryCode === null &&
    snapshot.preferences.version === expectedVersion + 1 &&
    samePreferences(snapshot.preferences, expectedPreferences)
  )
}

export class AppPreferencesController {
  readonly #gateway: AppPreferencesGateway
  readonly #defaultLocale: AppLocale
  readonly #listeners = new Set<Listener>()
  #state: AppPreferencesControllerState
  #authoritative: AppPreferencesSnapshotV2
  #initializePromise: Promise<boolean> | null = null
  #operation: Promise<void> = Promise.resolve()
  #updateDrain: Promise<boolean> | null = null
  #retryPromise: Promise<boolean> | null = null
  #desired: AppPreferencesV2 | null = null
  #desiredPatch: AppPreferencesPatch | null = null
  #retryPatch: AppPreferencesPatch | null = null
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
        if (this.#desired !== null && this.#desiredPatch !== null) {
          this.#desired = applyPatch(snapshot.preferences, this.#desiredPatch)
        }
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
        return this.fail(error)
      },
    )
    return this.#initializePromise
  }

  public update(patch: AppPreferencesPatch): Promise<boolean> {
    if (this.#disposed) return Promise.resolve(false)
    const recoveringFromError = this.#state.status === "error"

    if (recoveringFromError && this.#retryPatch !== null) {
      this.#retryPatch = { ...this.#retryPatch, ...patch }
      return this.retry()
    }

    const currentDesired = this.#desired ?? this.#authoritative.preferences
    const desired = applyPatch(currentDesired, patch)
    const desiredPatch = { ...(this.#desiredPatch ?? {}), ...patch }

    this.#retryPatch = null

    if (
      this.#desired === null &&
      !recoveringFromError &&
      this.#authoritative.recoveryCode === null &&
      samePreferences(desired, this.#authoritative.preferences)
    ) {
      this.#desiredPatch = null
      return Promise.resolve(true)
    }

    this.#desired = desired
    this.#desiredPatch = desiredPatch
    if (recoveringFromError) this.#initializePromise = null
    this.publish({
      ...this.#state,
      status: "saving",
      pendingPreferences: desired,
      errorCode: null,
    })
    return this.ensureUpdateDrain()
  }

  public retry(): Promise<boolean> {
    if (this.#disposed) return Promise.resolve(false)
    if (this.#state.status !== "error") return Promise.resolve(true)
    if (this.#retryPromise !== null) return this.#retryPromise
    const failedPatch = this.#retryPatch
    this.#retryPatch = null
    this.#initializePromise = null
    this.publish({
      ...this.#state,
      status: "loading",
      pendingPreferences: null,
      errorCode: null,
    })

    if (failedPatch !== null) {
      this.#desiredPatch = failedPatch
      this.#desired = applyPatch(this.#authoritative.preferences, failedPatch)
    }
    const retry = this.initialize().then((initialized) => {
      if (!initialized || this.#disposed) return false
      return this.#desired === null ? true : this.ensureUpdateDrain()
    })
    this.#retryPromise = retry
    void retry.finally(() => {
      if (this.#retryPromise === retry) this.#retryPromise = null
    })
    return retry
  }

  public dispose(): void {
    this.#disposed = true
    this.#desired = null
    this.#desiredPatch = null
    this.#retryPatch = null
    this.#listeners.clear()
  }

  private ensureUpdateDrain(): Promise<boolean> {
    if (this.#updateDrain !== null) {
      const current = this.#updateDrain
      return current.then((succeeded) => {
        if (!succeeded || this.#disposed) return false
        return this.#desired !== null ? this.ensureUpdateDrain() : true
      })
    }

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
    if (!(await this.initialize()) || this.#disposed) return false

    let rebaseAttempts = 0
    let lastError: unknown = ambiguousWriteError()
    while (this.#desired !== null && !this.#disposed) {
      const candidate = this.#desired

      if (
        this.#authoritative.recoveryCode === null &&
        samePreferences(candidate, this.#authoritative.preferences)
      ) {
        this.#desired = null
        this.#desiredPatch = null
        break
      }

      try {
        const expectedVersion = this.#authoritative.preferences.version
        const snapshot = await this.#gateway.update({
          schemaVersion: appPreferencesSchemaVersion,
          expectedVersion,
          locale: candidate.locale,
        })
        if (this.#disposed) return false
        if (acceptedWriteSnapshot(snapshot, expectedVersion, candidate)) {
          this.#authoritative = snapshot
          rebaseAttempts = 0
        } else {
          lastError = ambiguousWriteError()
          rebaseAttempts += 1
          if (!(await this.refreshAuthoritative())) return false
        }
      } catch (error) {
        lastError = error
        rebaseAttempts += 1
        if (!(await this.refreshAuthoritative())) return false
      }

      if (this.#disposed) return false
      if (
        this.#desired !== null &&
        this.#authoritative.recoveryCode === null &&
        samePreferences(this.#desired, this.#authoritative.preferences)
      ) {
        this.#desired = null
        this.#desiredPatch = null
      } else if (
        this.#desired !== null &&
        rebaseAttempts >= maxWriteRebaseAttempts
      ) {
        return this.fail(lastError)
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

  private async refreshAuthoritative(): Promise<boolean> {
    try {
      const snapshot = await this.#gateway.get(this.#defaultLocale)
      if (this.#disposed) return false
      this.#authoritative = snapshot
      if (this.#desired !== null && this.#desiredPatch !== null) {
        this.#desired = applyPatch(snapshot.preferences, this.#desiredPatch)
      }
      return true
    } catch (error) {
      return this.fail(error)
    }
  }

  private fail(error: unknown): false {
    if (this.#disposed) return false
    if (this.#desiredPatch !== null) this.#retryPatch = this.#desiredPatch
    this.#desired = null
    this.#desiredPatch = null
    this.publish({
      status: "error",
      snapshot: this.#authoritative,
      pendingPreferences: null,
      errorCode: safeErrorCode(error),
    })
    return false
  }

  private publish(state: AppPreferencesControllerState): void {
    if (this.#disposed) return
    this.#state = state
    for (const listener of this.#listeners) listener()
  }
}
