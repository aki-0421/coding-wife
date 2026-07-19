import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  DemoCommitExplanationRuntime,
  demoCurrentCommitEvidenceId,
} from "@/features/git-review"
import { gitReviewSchemaVersion } from "@/lib/contracts/git-review"

const workspaceId = "workspace-demo-runtime"
const workspaceGeneration = 7
const now = new Date("2026-07-18T10:00:00.000Z")
const previousCommitSha = "b".repeat(40)
const previousCommitEvidenceId = `commit-${previousCommitSha}`

function scope(locale: "ja" | "en") {
  return {
    schemaVersion: gitReviewSchemaVersion,
    workspaceId,
    workspaceGeneration,
    locale,
  } as const
}

function userDispatch(
  commitEvidenceId: string,
  requestId: string,
  selectionVersion: number,
) {
  return {
    request: {
      schemaVersion: gitReviewSchemaVersion,
      requestId,
      workspaceId,
      workspaceGeneration,
      commitEvidenceId,
      locale: "en" as const,
      selectionVersion,
      trigger: "user_request" as const,
      requestedAt: now.toISOString(),
    },
    evidence: {
      schemaVersion: gitReviewSchemaVersion,
      commitId: commitEvidenceId,
      subject: "chore: update local project metadata",
      body: "Keep the demo presentation bound to its selected commit.",
      changes: [
        {
          changeKind: "modified" as const,
          fileCount: 1,
          additions: 1,
          deletions: 1,
          binaryFiles: 0,
        },
      ],
      diffSummary: {
        filesChanged: 1,
        additions: 1,
        deletions: 1,
        binaryFiles: 0,
      },
      verification: [],
      decisions: [],
      risks: [],
      locale: "en" as const,
      workspaceGeneration,
      selectionVersion,
    },
  }
}

describe("DemoCommitExplanationRuntime", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("moves verified demo evidence through queued, running, and generated without auto-presenting", async () => {
    const runtime = new DemoCommitExplanationRuntime({
      runningDelayMs: 40,
      generatedDelayMs: 100,
      now: () => now,
    })
    const states: string[] = []
    const events: unknown[] = []
    const activate = vi.fn(() => true)
    runtime.subscribe(() => {
      const state = runtime.getState(
        workspaceId,
        workspaceGeneration,
        demoCurrentCommitEvidenceId,
      )
      if (state !== null) states.push(state.status)
    })
    runtime.narrationSource.subscribe((event) => events.push(event))
    runtime.setPresentationActivator(activate)

    await runtime.setScope(scope("en"))
    await runtime.start()
    expect(
      runtime.getState(
        workspaceId,
        workspaceGeneration,
        demoCurrentCommitEvidenceId,
      ),
    ).toMatchObject({
      status: "queued",
      trigger: "auto_verified_commit",
      selectionVersion: 1,
      presentationAvailable: false,
    })

    await vi.advanceTimersByTimeAsync(40)
    expect(states).toContain("running")
    await vi.advanceTimersByTimeAsync(60)
    const generated = runtime.getState(
      workspaceId,
      workspaceGeneration,
      demoCurrentCommitEvidenceId,
    )
    expect(generated).toMatchObject({
      status: "generated",
      presentationAvailable: true,
    })
    expect(events).toEqual([])
    expect(activate).not.toHaveBeenCalled()

    if (generated?.requestId === null || generated === null) {
      throw new Error("generated demo state is missing its request")
    }
    await runtime.present({
      schemaVersion: gitReviewSchemaVersion,
      workspaceId,
      workspaceGeneration,
      commitEvidenceId: demoCurrentCommitEvidenceId,
      requestId: generated.requestId,
      mode: "show",
      requestedAt: now.toISOString(),
    })

    expect(events).toHaveLength(5)
    expect(events).toEqual([
      expect.objectContaining({ kind: "started", locale: "en" }),
      expect.objectContaining({ kind: "chunk", sequence: 0 }),
      expect.objectContaining({ kind: "chunk", sequence: 1 }),
      expect.objectContaining({ kind: "chunk", sequence: 2 }),
      expect.objectContaining({ kind: "terminal", status: "completed" }),
    ])
    expect(activate).toHaveBeenCalledOnce()
    expect(
      runtime.getState(
        workspaceId,
        workspaceGeneration,
        demoCurrentCommitEvidenceId,
      )?.status,
    ).toBe("generated")
  })

  it("preserves jobs from an older locale scope and resumes safely after lifecycle disposal", async () => {
    const runtime = new DemoCommitExplanationRuntime({
      runningDelayMs: 40,
      generatedDelayMs: 100,
      now: () => now,
    })
    await runtime.start()
    await runtime.setScope(scope("en"))
    await vi.advanceTimersByTimeAsync(20)
    await runtime.setScope(scope("ja"))
    runtime.dispose()

    await vi.advanceTimersByTimeAsync(200)
    expect(
      runtime.getState(
        workspaceId,
        workspaceGeneration,
        demoCurrentCommitEvidenceId,
      ),
    ).toMatchObject({ status: "queued", locale: "ja" })

    await runtime.start()
    await vi.advanceTimersByTimeAsync(100)
    expect(
      runtime.getState(
        workspaceId,
        workspaceGeneration,
        demoCurrentCommitEvidenceId,
      ),
    ).toMatchObject({ status: "generated", locale: "ja" })
    await runtime.setScope(scope("en"))
    expect(
      runtime.getState(
        workspaceId,
        workspaceGeneration,
        demoCurrentCommitEvidenceId,
      ),
    ).toMatchObject({ status: "generated", locale: "en" })
  })

  it("presents a generated cache hit immediately on the first user action", async () => {
    const runtime = new DemoCommitExplanationRuntime({
      runningDelayMs: 40,
      generatedDelayMs: 100,
      now: () => now,
    })
    const events: unknown[] = []
    runtime.narrationSource.subscribe((event) => events.push(event))
    await runtime.start()
    await runtime.setScope(scope("en"))
    await vi.advanceTimersByTimeAsync(100)
    expect(events).toEqual([])

    await runtime.request(
      userDispatch(demoCurrentCommitEvidenceId, "demo-cache-hit", 2),
    )

    expect(events).toHaveLength(5)
    expect(events[0]).toEqual(
      expect.objectContaining({ kind: "started", requestId: "demo-cache-hit" }),
    )
    expect(
      runtime.getState(
        workspaceId,
        workspaceGeneration,
        demoCurrentCommitEvidenceId,
      ),
    ).toMatchObject({ status: "generated", requestId: "demo-cache-hit" })
  })

  it("revokes only presentation intent while a user-requested job completes and stays cached", async () => {
    const runtime = new DemoCommitExplanationRuntime({
      runningDelayMs: 40,
      generatedDelayMs: 100,
      now: () => now,
    })
    const events: unknown[] = []
    runtime.narrationSource.subscribe((event) => events.push(event))
    await runtime.start()
    await runtime.setScope(scope("en"))
    await runtime.request(
      userDispatch(previousCommitEvidenceId, "demo-revoked", 2),
    )
    runtime.revokePresentationIntent("turn_stop")
    await vi.advanceTimersByTimeAsync(100)

    const generated = runtime.getState(
      workspaceId,
      workspaceGeneration,
      previousCommitEvidenceId,
    )
    expect(generated).toMatchObject({
      status: "generated",
      requestId: "demo-revoked",
    })
    expect(events).toEqual([])
    await runtime.present({
      schemaVersion: gitReviewSchemaVersion,
      workspaceId,
      workspaceGeneration,
      commitEvidenceId: previousCommitEvidenceId,
      requestId: "demo-revoked",
      mode: "show",
      requestedAt: now.toISOString(),
    })
    expect(events).toHaveLength(5)
  })

  it("cancels only the exact active request and ignores its late phase timers", async () => {
    const runtime = new DemoCommitExplanationRuntime({
      runningDelayMs: 40,
      generatedDelayMs: 100,
      now: () => now,
    })
    await runtime.start()
    await runtime.setScope(scope("en"))
    await vi.advanceTimersByTimeAsync(40)
    const running = runtime.getState(
      workspaceId,
      workspaceGeneration,
      demoCurrentCommitEvidenceId,
    )
    if (
      running?.requestId === null ||
      running?.requestId === undefined ||
      running.selectionVersion === null
    ) {
      throw new Error("running demo state is missing its identity")
    }

    await runtime.cancel({
      schemaVersion: gitReviewSchemaVersion,
      requestId: running.requestId,
      workspaceGeneration,
      selectionVersion: running.selectionVersion,
      reason: "user",
      requestedAt: now.toISOString(),
    })
    await vi.advanceTimersByTimeAsync(200)

    expect(
      runtime.getState(
        workspaceId,
        workspaceGeneration,
        demoCurrentCommitEvidenceId,
      ),
    ).toMatchObject({
      requestId: running.requestId,
      status: "canceled",
      retryable: true,
      presentationAvailable: false,
      errorCode: "CODEX-SUPPORT-CANCELED",
    })
  })

  it("presents the selected commit after one user request", async () => {
    const runtime = new DemoCommitExplanationRuntime({
      runningDelayMs: 40,
      generatedDelayMs: 100,
      now: () => now,
    })
    const events: unknown[] = []
    const activate = vi.fn(() => true)
    runtime.narrationSource.subscribe((event) => events.push(event))
    runtime.setPresentationActivator(activate)
    await runtime.start()
    await runtime.setScope(scope("en"))

    await runtime.request({
      request: {
        schemaVersion: gitReviewSchemaVersion,
        requestId: "demo-previous-commit",
        workspaceId,
        workspaceGeneration,
        commitEvidenceId: previousCommitEvidenceId,
        locale: "en",
        selectionVersion: 2,
        trigger: "user_request",
        requestedAt: now.toISOString(),
      },
      evidence: {
        schemaVersion: gitReviewSchemaVersion,
        commitId: previousCommitEvidenceId,
        subject: "chore: update local project metadata",
        body: "Keep the demo presentation bound to its selected commit.",
        changes: [
          {
            changeKind: "modified",
            fileCount: 1,
            additions: 1,
            deletions: 1,
            binaryFiles: 0,
          },
        ],
        diffSummary: {
          filesChanged: 1,
          additions: 1,
          deletions: 1,
          binaryFiles: 0,
        },
        verification: [],
        decisions: [],
        risks: [],
        locale: "en",
        workspaceGeneration,
        selectionVersion: 2,
      },
    })
    await vi.advanceTimersByTimeAsync(100)

    expect(events).toEqual([
      expect.objectContaining({
        kind: "started",
        commitSha: previousCommitSha,
      }),
      expect.objectContaining({ kind: "chunk", commitSha: previousCommitSha }),
      expect.objectContaining({ kind: "chunk", commitSha: previousCommitSha }),
      expect.objectContaining({ kind: "chunk", commitSha: previousCommitSha }),
      expect.objectContaining({
        kind: "terminal",
        commitSha: previousCommitSha,
      }),
    ])
    expect(activate).toHaveBeenCalledWith(
      expect.objectContaining({ commitSha: previousCommitSha }),
    )
  })
})
