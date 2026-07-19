import { describe, expect, it } from "vitest"

import {
  NativeReadinessContractError,
  parseNativeReadinessSnapshot,
  parseSanitizedDiagnosticsSummary,
  readinessCheckIds,
} from "@/features/readiness/contracts"

const checkedAt = "2026-07-18T00:00:00.000Z"
const snapshotId = "123e4567-e89b-42d3-a456-426614174000"

function snapshot(source: "native" | "demo" = "native") {
  return {
    schemaVersion: 1,
    snapshotId,
    checkedAt,
    source,
    checks: readinessCheckIds.map((id) => ({
      id,
      status: source === "native" ? "ready" : "unavailable",
      checkedAt,
      code: `READINESS-${id.toUpperCase().replace("_", "-")}-READY`,
      recoverable: false,
      recoveryAction: "none",
      facts: [],
    })),
  }
}

describe("native readiness contract", () => {
  it("accepts one complete snapshot with a shared checkedAt", () => {
    expect(parseNativeReadinessSnapshot(snapshot()).checks).toHaveLength(6)
  })

  it("rejects unknown fields, missing checks, and mixed timestamps", () => {
    const unknown = { ...snapshot(), privatePath: "/\u0055sers/private" }
    expect(() => parseNativeReadinessSnapshot(unknown)).toThrow(
      NativeReadinessContractError,
    )

    const missing = snapshot()
    missing.checks.pop()
    expect(() => parseNativeReadinessSnapshot(missing)).toThrow(
      NativeReadinessContractError,
    )

    const mixed = snapshot()
    mixed.checks[0] = {
      ...mixed.checks[0]!,
      checkedAt: "2026-07-18T00:00:01.000Z",
    }
    expect(() => parseNativeReadinessSnapshot(mixed)).toThrow(
      NativeReadinessContractError,
    )
  })

  it("never accepts a ready native capability from demo mode", () => {
    const demo = snapshot("demo")
    demo.checks[1] = { ...demo.checks[1]!, status: "ready" }
    expect(() => parseNativeReadinessSnapshot(demo)).toThrow(
      NativeReadinessContractError,
    )
  })

  it("accepts only the four canonical diagnostic outcomes", () => {
    for (const legacyStatus of ["degraded", "not_configured", "error"]) {
      const legacy = snapshot()
      legacy.checks[0] = { ...legacy.checks[0]!, status: legacyStatus }
      expect(() => parseNativeReadinessSnapshot(legacy)).toThrow(
        NativeReadinessContractError,
      )
    }

    for (const status of ["ready", "warning", "blocked", "unavailable"]) {
      const current = snapshot()
      current.checks[0] = { ...current.checks[0]!, status }
      expect(parseNativeReadinessSnapshot(current).checks[0]?.status).toBe(
        status,
      )
    }
  })

  it("rejects copied text containing private paths or raw process fields", () => {
    const base = {
      schemaVersion: 1,
      snapshotId,
      summary: "Coding Wife diagnostics v1\nsource=native\n",
    }
    expect(parseSanitizedDiagnosticsSummary(base, snapshotId)).toEqual(base)
    for (const unsafe of [
      "/\u0055sers/private/repository",
      "token=secret",
      "raw stderr",
    ]) {
      expect(() =>
        parseSanitizedDiagnosticsSummary(
          { ...base, summary: `${base.summary}${unsafe}\n` },
          snapshotId,
        ),
      ).toThrow(NativeReadinessContractError)
    }
  })
})
