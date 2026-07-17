import { describe, expect, it } from "vitest"

import {
  ipcCommands,
  ipcSchemaVersion,
  normalizeIpcError,
  parseHealthCheckResponse,
  parseRuntimeMetadata,
  validateRuntimeResponses,
} from "@/lib/contracts/ipc"
import runtimeFixture from "@/test/fixtures/runtime-foundation.v1.json"

describe("IPC runtime contracts", () => {
  it("parses the committed cross-language fixture", () => {
    expect(runtimeFixture.schemaVersion).toBe(ipcSchemaVersion)
    expect(parseHealthCheckResponse(runtimeFixture.healthCheck)).toEqual(
      runtimeFixture.healthCheck,
    )
    expect(parseRuntimeMetadata(runtimeFixture.runtimeMetadata)).toEqual(
      runtimeFixture.runtimeMetadata,
    )
  })

  it("rejects unknown versions and snake_case drift", () => {
    expect(() =>
      parseHealthCheckResponse({
        ...runtimeFixture.healthCheck,
        schemaVersion: 2,
      }),
    ).toThrow("IPC contract")

    expect(() =>
      parseHealthCheckResponse({
        schema_version: 1,
        runtime: "tauri",
        foundation_state: "ready",
      }),
    ).toThrow("IPC contract")
  })

  it("rejects missing fields, unexpected fields, and enum drift", () => {
    const missingArchitecture = {
      schemaVersion: runtimeFixture.runtimeMetadata.schemaVersion,
      runtime: runtimeFixture.runtimeMetadata.runtime,
      appVersion: runtimeFixture.runtimeMetadata.appVersion,
      platform: runtimeFixture.runtimeMetadata.platform,
      integrations: runtimeFixture.runtimeMetadata.integrations,
    }

    expect(() => parseRuntimeMetadata(missingArchitecture)).toThrow(
      "IPC contract",
    )
    expect(() =>
      parseRuntimeMetadata({
        ...runtimeFixture.runtimeMetadata,
        unexpected: true,
      }),
    ).toThrow("IPC contract")
    expect(() =>
      parseRuntimeMetadata({
        ...runtimeFixture.runtimeMetadata,
        integrations: {
          ...runtimeFixture.runtimeMetadata.integrations,
          git: "ready",
        },
      }),
    ).toThrow("IPC contract")
    expect(
      parseRuntimeMetadata({
        ...runtimeFixture.runtimeMetadata,
        integrations: {
          ...runtimeFixture.runtimeMetadata.integrations,
          history: "recovery_required",
        },
      }).integrations.history,
    ).toBe("recovery_required")
    expect(() =>
      parseRuntimeMetadata({
        ...runtimeFixture.runtimeMetadata,
        integrations: {
          ...runtimeFixture.runtimeMetadata.integrations,
          history: "unknown",
        },
      }),
    ).toThrow("IPC contract")
  })

  it("rejects health and metadata from different runtimes", () => {
    const health = parseHealthCheckResponse(runtimeFixture.healthCheck)
    const metadata = parseRuntimeMetadata({
      ...runtimeFixture.runtimeMetadata,
      runtime: "demo",
    })

    let rejection: unknown
    try {
      validateRuntimeResponses("tauri", health, metadata)
    } catch (error) {
      rejection = error
    }

    expect(rejection).toMatchObject({
      code: "APP-IPC-CONTRACT-MISMATCH",
      operation: ipcCommands.getRuntimeMetadata,
      recoverable: false,
    })
    expect(normalizeIpcError(ipcCommands.healthCheck, rejection)).toMatchObject(
      {
        code: "APP-IPC-CONTRACT-MISMATCH",
        operation: ipcCommands.getRuntimeMetadata,
        recoverable: false,
      },
    )
  })
})
