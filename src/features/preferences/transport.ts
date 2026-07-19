import { invoke as tauriInvoke } from "@tauri-apps/api/core"

import {
  AppPreferencesContractError,
  appPreferencesCommands,
  appPreferencesSchemaVersion,
  createSafeDefaultPreferences,
  parseAppPreferencesCommandError,
  parseAppPreferencesSnapshot,
  type AppLocale,
  type AppPreferencesCommandErrorEnvelope,
  type AppPreferencesGetRequestV1,
  type AppPreferencesResetRequestV1,
  type AppPreferencesSnapshotV1,
  type AppPreferencesUpdateRequestV1,
  type AppPreferencesV1,
} from "@/features/preferences/contracts"

type Invoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>

export type AppPreferencesGatewayKind = "native" | "demo"

export interface AppPreferencesGateway {
  readonly kind: AppPreferencesGatewayKind
  get(defaultLocale: AppLocale): Promise<AppPreferencesSnapshotV1>
  update(
    request: AppPreferencesUpdateRequestV1,
  ): Promise<AppPreferencesSnapshotV1>
  reset(
    request: AppPreferencesResetRequestV1,
  ): Promise<AppPreferencesSnapshotV1>
}

export class AppPreferencesBoundaryError
  extends Error
  implements AppPreferencesCommandErrorEnvelope
{
  public readonly code: string
  public readonly operation: string
  public readonly recoverable: boolean
  public readonly userMessageKey: string
  public readonly detailRef: string

  public constructor(error?: AppPreferencesCommandErrorEnvelope) {
    const envelope = error ?? {
      code: "APP-PREFERENCES-IPC-UNAVAILABLE",
      operation: "app_preferences_ipc",
      recoverable: true,
      userMessageKey: "preferences.error.generic",
      detailRef: "app-preferences-v1",
    }
    super(envelope.code)
    this.name = "AppPreferencesBoundaryError"
    this.code = envelope.code
    this.operation = envelope.operation
    this.recoverable = envelope.recoverable
    this.userMessageKey = envelope.userMessageKey
    this.detailRef = envelope.detailRef
  }
}

function normalizeError(error: unknown): AppPreferencesBoundaryError {
  if (error instanceof AppPreferencesBoundaryError) return error
  if (error instanceof AppPreferencesContractError) {
    return new AppPreferencesBoundaryError({
      code: error.code,
      operation: "app_preferences_contract",
      recoverable: false,
      userMessageKey: "preferences.error.generic",
      detailRef: "app-preferences-v1",
    })
  }
  return new AppPreferencesBoundaryError(
    parseAppPreferencesCommandError(error) ?? undefined,
  )
}

export class NativeAppPreferencesGateway implements AppPreferencesGateway {
  public readonly kind = "native" as const

  public constructor(private readonly invoke: Invoke = tauriInvoke) {}

  public get(defaultLocale: AppLocale): Promise<AppPreferencesSnapshotV1> {
    const request: AppPreferencesGetRequestV1 = {
      schemaVersion: appPreferencesSchemaVersion,
      defaultLocale,
    }
    return this.request(appPreferencesCommands.get, request)
  }

  public async update(
    request: AppPreferencesUpdateRequestV1,
  ): Promise<AppPreferencesSnapshotV1> {
    return this.request(appPreferencesCommands.update, request)
  }

  public reset(
    request: AppPreferencesResetRequestV1,
  ): Promise<AppPreferencesSnapshotV1> {
    return this.request(appPreferencesCommands.reset, request)
  }

  private async request(
    command: string,
    request: unknown,
  ): Promise<AppPreferencesSnapshotV1> {
    try {
      return parseAppPreferencesSnapshot(
        await this.invoke(command, { request }),
      )
    } catch (error) {
      throw normalizeError(error)
    }
  }
}

function demoSnapshotId(version: number): string {
  const suffix = Math.min(version + 1, 0xffff_ffff_ffff)
    .toString(16)
    .padStart(12, "0")
  return `00000000-0000-4000-8000-${suffix}`
}

function cloneSnapshot(
  snapshot: AppPreferencesSnapshotV1,
): AppPreferencesSnapshotV1 {
  return structuredClone(snapshot)
}

export class DemoAppPreferencesGateway implements AppPreferencesGateway {
  public readonly kind = "demo" as const
  #preferences: AppPreferencesV1 | null = null

  public get(defaultLocale: AppLocale): Promise<AppPreferencesSnapshotV1> {
    if (this.#preferences === null) {
      this.#preferences = {
        ...createSafeDefaultPreferences(defaultLocale),
        snapshotId: demoSnapshotId(0),
      }
    }
    return Promise.resolve(cloneSnapshot(this.snapshot()))
  }

  public update(
    request: AppPreferencesUpdateRequestV1,
  ): Promise<AppPreferencesSnapshotV1> {
    return Promise.resolve().then(() => {
      this.requireCurrent(request.expectedVersion)
      const version = request.expectedVersion + 1
      this.#preferences = {
        schemaVersion: appPreferencesSchemaVersion,
        version,
        snapshotId: demoSnapshotId(version),
        locale: request.locale,
        reducedMotion: request.reducedMotion,
        characterVisibility: request.characterVisibility,
      }
      return cloneSnapshot(this.snapshot())
    })
  }

  public reset(
    request: AppPreferencesResetRequestV1,
  ): Promise<AppPreferencesSnapshotV1> {
    return Promise.resolve().then(() => {
      this.requireCurrent(request.expectedVersion)
      const version = request.expectedVersion + 1
      this.#preferences = {
        ...createSafeDefaultPreferences(request.defaultLocale),
        version,
        snapshotId: demoSnapshotId(version),
      }
      return cloneSnapshot(this.snapshot())
    })
  }

  private snapshot(): AppPreferencesSnapshotV1 {
    if (this.#preferences === null) {
      throw new AppPreferencesBoundaryError()
    }
    return {
      schemaVersion: appPreferencesSchemaVersion,
      preferences: this.#preferences,
      persistence: "demo_memory",
      recoveryCode: null,
    }
  }

  private requireCurrent(expectedVersion: number): void {
    if (
      this.#preferences === null ||
      this.#preferences.version !== expectedVersion
    ) {
      throw new AppPreferencesBoundaryError({
        code: "APP-PREFERENCES-CONFLICT",
        operation: "app_preferences_update",
        recoverable: true,
        userMessageKey: "preferences.error.generic",
        detailRef: "app-preferences-v1",
      })
    }
  }
}

export function createAppPreferencesGateway(
  kind: AppPreferencesGatewayKind,
): AppPreferencesGateway {
  return kind === "native"
    ? new NativeAppPreferencesGateway()
    : new DemoAppPreferencesGateway()
}
