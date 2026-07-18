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

export class AppPreferencesController {
  readonly #gateway: AppPreferencesGateway
  readonly #defaultLocale: AppLocale
  readonly #listeners = new Set<Listener>()
  #state: AppPreferencesControllerState
  #authoritative: AppPreferencesSnapshotV1
  #initializePromise: Promise<boolean> | null = null
  #operation: Promise<void> = Promise.resolve()
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
    this.#state = { status: "loading", snapshot, errorCode: null }
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
          status: statusFor(snapshot),
          snapshot,
          errorCode: null,
        })
        return true
      },
      (error: unknown) => {
        if (this.#disposed) return false
        this.publish({
          status: "error",
          snapshot: this.#authoritative,
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
    this.#desired = desired
    return this.enqueueMutation(async (mutation) => {
      const current = this.#authoritative.preferences
      const snapshot = await this.#gateway.update({
        schemaVersion: appPreferencesSchemaVersion,
        expectedVersion: current.version,
        locale: desired.locale,
        reducedMotion: desired.reducedMotion,
        characterVisibility: desired.characterVisibility,
      })
      this.#authoritative = snapshot
      if (mutation === this.#latestMutation) {
        this.#desired = null
        this.publish({
          status: statusFor(snapshot),
          snapshot,
          errorCode: null,
        })
      }
    })
  }

  public reset(): Promise<boolean> {
    this.#desired = {
      ...createSafeDefaultPreferences(this.#defaultLocale),
      version: this.#authoritative.preferences.version,
      snapshotId: this.#authoritative.preferences.snapshotId,
    }
    return this.enqueueMutation(async (mutation) => {
      const snapshot = await this.#gateway.reset({
        schemaVersion: appPreferencesSchemaVersion,
        expectedVersion: this.#authoritative.preferences.version,
        defaultLocale: this.#defaultLocale,
      })
      this.#authoritative = snapshot
      if (mutation === this.#latestMutation) {
        this.#desired = null
        this.publish({
          status: statusFor(snapshot),
          snapshot,
          errorCode: null,
        })
      }
    })
  }

  public retry(): Promise<boolean> {
    if (this.#state.status !== "error") return Promise.resolve(true)
    this.#initializePromise = null
    this.publish({ ...this.#state, status: "loading", errorCode: null })
    return this.initialize()
  }

  public dispose(): void {
    this.#disposed = true
    this.#listeners.clear()
  }

  private enqueueMutation(
    operation: (mutation: number) => Promise<void>,
  ): Promise<boolean> {
    const mutation = this.#latestMutation + 1
    this.#latestMutation = mutation
    this.publish({ ...this.#state, status: "saving", errorCode: null })
    let succeeded = false
    const run = this.#operation.then(async () => {
      if (!(await this.initialize()) || this.#disposed) return
      try {
        await operation(mutation)
        succeeded = true
      } catch (error) {
        if (mutation === this.#latestMutation && !this.#disposed) {
          this.#desired = null
          this.publish({
            status: "error",
            snapshot: this.#authoritative,
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

  private publish(state: AppPreferencesControllerState): void {
    if (this.#disposed) return
    this.#state = state
    for (const listener of this.#listeners) listener()
  }
}
