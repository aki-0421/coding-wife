import { describe, expect, it } from "vitest"

import {
  acceptanceResourceGrowth,
  buildFinalAcceptanceMatrix,
  containsPrivateAcceptanceEvidence,
  createAcceptanceWorkspaces,
  FinalAcceptanceEvidenceRecorder,
  finalAcceptanceLocales,
  finalAcceptanceScenarios,
  finalAcceptanceViewports,
  measureAcceptanceBudget,
  percentile95,
} from "@/app/acceptance/final-acceptance-harness"
import { projectWorkspaceNavigation } from "@/features/workspace-view/workspace-navigation"

describe("final acceptance evidence harness", () => {
  it("keeps matrix definitions unique for the production render suite", () => {
    const matrix = buildFinalAcceptanceMatrix()

    expect(matrix).toHaveLength(
      finalAcceptanceLocales.length * finalAcceptanceViewports.length * 2,
    )
    for (const locale of finalAcceptanceLocales) {
      for (const viewport of finalAcceptanceViewports) {
        expect(matrix).toContainEqual({
          locale,
          viewport: viewport.id,
          journey: "happy",
        })
        expect(matrix).toContainEqual({
          locale,
          viewport: viewport.id,
          journey: "major_error",
        })
      }
    }
    expect(new Set(finalAcceptanceScenarios.map(({ id }) => id)).size).toBe(
      finalAcceptanceScenarios.length,
    )
  })

  it("cannot certify native-only persistence or process cleanup from a browser fixture", () => {
    const recorder = new FinalAcceptanceEvidenceRecorder("browser_demo")

    expect(() =>
      recorder.pass({
        scenarioId: "native_restart_repair_quit",
        assertions: ["A browser fixture must not claim native readiness."],
      }),
    ).toThrow(/packaged native Tauri/u)

    recorder.notExecutedNative("native_restart_repair_quit", [
      "SQLite cold restart, repository repair, and orderly quit remain native release checks.",
    ])
    recorder.notExecutedNative("native_process_cleanup", [
      "Descendant process disappearance and audio/support cleanup require the packaged app.",
    ])
    recorder.pass({
      scenarioId: "web_demo_boundary",
      assertions: [
        "Chat omits normal durability badges while the header labels browser execution Preview only.",
        "Native diagnostics are unavailable rather than reported Ready.",
      ],
    })

    expect(recorder.evidence.map(({ status }) => status)).toEqual([
      "not_executed",
      "not_executed",
      "passed",
    ])
    recorder.assertNoFailures()
  })

  it("rejects private paths, credentials, raw reasoning, and raw process output from evidence", () => {
    const recorder = new FinalAcceptanceEvidenceRecorder(
      "webview_contract_fixture",
    )

    for (const value of [
      "private root under /\u0055sers/example/project",
      "Bearer sample-credential",
      "raw_reasoning payload",
      "raw stderr was copied",
    ]) {
      expect(containsPrivateAcceptanceEvidence(value)).toBe(true)
      expect(() =>
        recorder.pass({
          scenarioId: "attachment_security",
          assertions: [value],
        }),
      ).toThrow(/private material/u)
    }
    expect(
      containsPrivateAcceptanceEvidence({
        code: "CODEX-ATTACHMENT-BOUNDARY",
        detail: "Only basename and bounded metadata were retained.",
      }),
    ).toBe(false)
  })

  it("calculates deterministic p95 evidence with an explicit sample count and budget", () => {
    const durations = Array.from({ length: 100 }, (_, index) =>
      index === 99 ? 120 : (index % 10) + 1,
    )
    let sample = 0
    let atStart = true
    const now = () => {
      if (atStart) {
        atStart = false
        return 0
      }
      atStart = true
      const duration = durations[sample] ?? 0
      sample += 1
      return duration
    }

    const evidence = measureAcceptanceBudget(100, 100, () => undefined, now)

    expect(evidence).toEqual({
      sampleCount: 100,
      budgetMs: 100,
      p95Ms: 10,
      maximumMs: 120,
      passed: true,
    })
    expect(percentile95([5, 1, 4, 3, 2])).toBe(5)
  })

  it("keeps 200-workspace project filter and selection probes below the 100ms p95 budget", () => {
    const workspaces = createAcceptanceWorkspaces()
    let selectedId = ""
    let filteredCount = 0
    const evidence = measureAcceptanceBudget(100, 100, (sample) => {
      const targetId = `acceptance-workspace-${String((sample % 200) + 1).padStart(3, "0")}`
      const projectFilterIds = [
        `acceptance-project-${String(sample % 8).padStart(2, "0")}`,
        `acceptance-project-${String((sample + 1) % 8).padStart(2, "0")}`,
      ]
      const projection = projectWorkspaceNavigation(
        workspaces,
        targetId,
        projectFilterIds,
      )
      selectedId = projection.selectedWorkspace?.id ?? ""
      filteredCount = projection.filteredWorkspaces.length
    })

    expect(workspaces).toHaveLength(200)
    expect(selectedId).toMatch(/^acceptance-workspace-/u)
    expect(filteredCount).toBe(50)
    expect(evidence.sampleCount).toBe(100)
    expect(evidence.passed).toBe(true)
    expect(evidence.p95Ms).toBeLessThanOrEqual(100)
  })

  it("reports listener, process, and queued-task growth independently", () => {
    expect(
      acceptanceResourceGrowth(
        { listeners: 4, processes: 2, queuedTasks: 1 },
        { listeners: 4, processes: 2, queuedTasks: 1 },
      ),
    ).toEqual({ listeners: 0, processes: 0, queuedTasks: 0 })
  })
})
