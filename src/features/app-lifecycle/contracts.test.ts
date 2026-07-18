import { describe, expect, it } from "vitest"

import {
  createAppQuitRequest,
  parseAppCleanupFailed,
  parseAppCloseRequested,
} from "@/features/app-lifecycle/contracts"

describe("app lifecycle contracts", () => {
  it("accepts only an exact workspace and generation-bound close request", () => {
    expect(
      parseAppCloseRequested({
        schemaVersion: 1,
        requestId: "app-quit-550e8400-e29b-41d4-a716-446655440000",
        workspaceId: "workspace-550e8400-e29b-41d4-a716-446655440000",
        workspaceGeneration: 7,
      }),
    ).toEqual({
      schemaVersion: 1,
      requestId: "app-quit-550e8400-e29b-41d4-a716-446655440000",
      workspaceId: "workspace-550e8400-e29b-41d4-a716-446655440000",
      workspaceGeneration: 7,
    })

    for (const invalid of [
      {
        schemaVersion: 1,
        requestId: "app-quit-valid",
        workspaceId: "workspace-valid",
        workspaceGeneration: 0,
      },
      {
        schemaVersion: 1,
        requestId: "app-quit-valid",
        workspaceId: "workspace-valid",
        workspaceGeneration: 1,
        path: "/Users/private",
      },
      {
        schemaVersion: 2,
        requestId: "app-quit-valid",
        workspaceId: "workspace-valid",
        workspaceGeneration: 1,
      },
    ]) {
      expect(() => parseAppCloseRequested(invalid)).toThrow(
        "APP-LIFECYCLE-CONTRACT-MISMATCH",
      )
    }
  })

  it("creates a minimal quit response without workspace or process data", () => {
    expect(createAppQuitRequest("app-quit-safe")).toEqual({
      schemaVersion: 1,
      requestId: "app-quit-safe",
    })
    expect(() => createAppQuitRequest("unsafe/request")).toThrow(
      "APP-LIFECYCLE-REQUEST-ID",
    )
  })

  it("accepts only a sanitized cleanup failure contract", () => {
    expect(
      parseAppCleanupFailed({
        schemaVersion: 1,
        requestId: "app-quit-safe",
        attempt: 2,
        errorCode: "APP-QUIT-CLEANUP-INCOMPLETE",
      }),
    ).toEqual({
      schemaVersion: 1,
      requestId: "app-quit-safe",
      attempt: 2,
      errorCode: "APP-QUIT-CLEANUP-INCOMPLETE",
    })
    for (const invalid of [
      {
        schemaVersion: 1,
        requestId: "app-quit-safe",
        attempt: 0,
        errorCode: "APP-QUIT-CLEANUP-INCOMPLETE",
      },
      {
        schemaVersion: 1,
        requestId: "app-quit-safe",
        attempt: 1,
        errorCode: "APP-QUIT-CLEANUP-INCOMPLETE",
        service: "history",
      },
      {
        schemaVersion: 1,
        requestId: "app-quit-safe",
        attempt: 1,
        errorCode: "/Users/private/token=secret",
      },
    ]) {
      expect(() => parseAppCleanupFailed(invalid)).toThrow(
        "APP-LIFECYCLE-CONTRACT-MISMATCH",
      )
    }
  })
})
