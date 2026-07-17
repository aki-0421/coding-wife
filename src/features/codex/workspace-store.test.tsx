import { act, renderHook } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { useCodexWorkspace } from "@/features/codex/use-codex-workspace"
import { CodexWorkspaceStore } from "@/features/codex/workspace-store"
import type { CodexTransport } from "@/features/codex/transport"
import type { WorkspaceRegistration } from "@/lib/contracts"

const registration = {
  schemaVersion: 1,
  workspaceId: "workspace-fixture",
  alias: "Fixture repository",
  preflight: {
    gitRepository: true,
    ownedByCurrentUser: true,
    writable: true,
  },
} as const

describe("CodexWorkspaceStore", () => {
  it("deduplicates native picks and exposes only an opaque registration", async () => {
    const request = vi.fn().mockResolvedValue(registration)
    const transport = {
      kind: "demo",
      request,
      subscribe: () => Promise.resolve(() => undefined),
    } as CodexTransport
    const store = new CodexWorkspaceStore(transport)
    const { result } = renderHook(() => useCodexWorkspace(store))

    let first: Promise<WorkspaceRegistration> | undefined
    let second: Promise<WorkspaceRegistration> | undefined
    await act(async () => {
      first = result.current.pickAndRegister()
      second = result.current.pickAndRegister()
      await Promise.all([first, second])
    })

    expect(first).toBe(second)
    expect(request).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledWith("codex_pick_workspace", undefined)
    expect(result.current).toMatchObject({
      status: "ready",
      registration,
      errorCode: null,
    })
    expect(JSON.stringify(result.current.registration)).not.toContain("/")
  })
})
