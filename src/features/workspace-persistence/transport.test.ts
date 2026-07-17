import { describe, expect, it, vi } from "vitest"

import { workspaceHistoryCommands } from "@/lib/contracts/workspace-history"
import fixture from "@/test/fixtures/workspace-history.v1.json"

import {
  TauriWorkspaceHistoryTransport,
  WorkspaceHistoryBoundaryError,
  type WorkspaceHistoryInvoker,
} from "@/features/workspace-persistence/transport"

describe("TauriWorkspaceHistoryTransport", () => {
  it("invokes no-request commands without fabricating a payload", async () => {
    const invoker = vi
      .fn<WorkspaceHistoryInvoker>()
      .mockResolvedValue(fixture.state)
    const transport = new TauriWorkspaceHistoryTransport(invoker)

    await expect(
      transport.request(workspaceHistoryCommands.list, undefined),
    ).resolves.toEqual(fixture.state)
    expect(invoker).toHaveBeenCalledWith(
      workspaceHistoryCommands.list,
      undefined,
    )
  })

  it("passes strict request objects and validates the matching response", async () => {
    const invoker = vi
      .fn<WorkspaceHistoryInvoker>()
      .mockResolvedValue(fixture.draft)
    const transport = new TauriWorkspaceHistoryTransport(invoker)
    const request = {
      workspaceId: "workspace-fixture",
      text: "Verify the persisted workspace.",
      effort: "max" as const,
      expectedRevision: 1,
    }

    await expect(
      transport.request(workspaceHistoryCommands.saveDraft, request),
    ).resolves.toEqual(fixture.draft)
    expect(invoker).toHaveBeenCalledWith(
      workspaceHistoryCommands.saveDraft,
      request,
    )
  })

  it("normalizes native envelopes only when the operation matches", async () => {
    const nativeError = Object.assign(
      new Error(fixture.error.code),
      fixture.error,
    )
    const transport = new TauriWorkspaceHistoryTransport(() =>
      Promise.reject(nativeError),
    )

    await expect(
      transport.request(workspaceHistoryCommands.select, {
        workspaceId: "workspace-missing",
      }),
    ).rejects.toMatchObject({
      code: "WORKSPACE-NOT-FOUND",
      operation: workspaceHistoryCommands.select,
      recoverable: false,
    })
  })

  it("turns malformed or private native values into a contract boundary error", async () => {
    const transport = new TauriWorkspaceHistoryTransport(() =>
      Promise.resolve({
        ...fixture.state,
        workspaces: [
          {
            ...fixture.summary,
            repository: "/Users/private/repository",
          },
        ],
      }),
    )

    await expect(
      transport.request(workspaceHistoryCommands.list, undefined),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "WorkspaceHistoryBoundaryError",
        code: "WORKSPACE-IPC-CONTRACT-MISMATCH",
        operation: workspaceHistoryCommands.list,
      }),
    )
    await expect(
      Promise.reject(
        new WorkspaceHistoryBoundaryError({
          code: "TEST",
          operation: workspaceHistoryCommands.list,
          recoverable: false,
          userMessageKey: "workspace.error.generic",
        }),
      ),
    ).rejects.toBeInstanceOf(WorkspaceHistoryBoundaryError)
  })
})
