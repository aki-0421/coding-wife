export const appLifecycleSchemaVersion = 1 as const

export const appLifecycleCommands = {
  cancelQuit: "app_quit_cancel",
  confirmQuit: "app_quit_confirm",
  retryCleanup: "app_quit_retry_cleanup",
} as const

export const appLifecycleEventChannels = {
  closeRequested: "coding-wife://app-close-requested",
  cleanupFailed: "coding-wife://app-cleanup-failed",
} as const

export const appLifecycleDemoEvents = {
  closeRequested: "coding-wife:demo-app-close-requested",
  cleanupFailed: "coding-wife:demo-app-cleanup-failed",
  action: "coding-wife:demo-app-quit-action",
} as const

export interface AppCloseRequestedV1 {
  readonly schemaVersion: typeof appLifecycleSchemaVersion
  readonly requestId: string
  readonly workspaceId: string
  readonly workspaceGeneration: number
}

export interface AppQuitRequestV1 {
  readonly schemaVersion: typeof appLifecycleSchemaVersion
  readonly requestId: string
}

export interface AppCleanupFailedV1 {
  readonly schemaVersion: typeof appLifecycleSchemaVersion
  readonly requestId: string
  readonly attempt: number
  readonly errorCode: "APP-QUIT-CLEANUP-INCOMPLETE"
}

export type AppQuitAction = "dont_quit" | "stop_and_quit" | "retry_cleanup"

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  )
}

function validOpaqueId(value: unknown, prefix?: string): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 128 &&
    (prefix === undefined || value.startsWith(prefix)) &&
    /^[A-Za-z0-9-]+$/u.test(value)
  )
}

export function parseAppCloseRequested(value: unknown): AppCloseRequestedV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "requestId",
      "workspaceId",
      "workspaceGeneration",
    ]) ||
    value.schemaVersion !== appLifecycleSchemaVersion ||
    !validOpaqueId(value.requestId, "app-quit-") ||
    !validOpaqueId(value.workspaceId, "workspace-") ||
    !Number.isSafeInteger(value.workspaceGeneration) ||
    Number(value.workspaceGeneration) < 1
  ) {
    throw new Error("APP-LIFECYCLE-CONTRACT-MISMATCH")
  }
  return {
    schemaVersion: appLifecycleSchemaVersion,
    requestId: value.requestId,
    workspaceId: value.workspaceId,
    workspaceGeneration: Number(value.workspaceGeneration),
  }
}

export function parseAppCleanupFailed(value: unknown): AppCleanupFailedV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "requestId",
      "attempt",
      "errorCode",
    ]) ||
    value.schemaVersion !== appLifecycleSchemaVersion ||
    !validOpaqueId(value.requestId, "app-quit-") ||
    !Number.isSafeInteger(value.attempt) ||
    Number(value.attempt) < 1 ||
    Number(value.attempt) > 65_535 ||
    value.errorCode !== "APP-QUIT-CLEANUP-INCOMPLETE"
  ) {
    throw new Error("APP-LIFECYCLE-CONTRACT-MISMATCH")
  }
  return {
    schemaVersion: appLifecycleSchemaVersion,
    requestId: value.requestId,
    attempt: Number(value.attempt),
    errorCode: "APP-QUIT-CLEANUP-INCOMPLETE",
  }
}

export function createAppQuitRequest(requestId: string): AppQuitRequestV1 {
  if (!validOpaqueId(requestId, "app-quit-")) {
    throw new Error("APP-LIFECYCLE-REQUEST-ID")
  }
  return {
    schemaVersion: appLifecycleSchemaVersion,
    requestId,
  }
}
