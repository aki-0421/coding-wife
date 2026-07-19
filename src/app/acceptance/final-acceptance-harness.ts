import type { SupportedLocale as Locale } from "@/features/localization"
import type { WorkspaceRecord } from "@/features/workspace-view/types"

export const finalAcceptanceLocales = [
  "ja",
  "en",
] as const satisfies readonly Locale[]

export const finalAcceptanceViewports = [
  { id: "desktop", width: 1470, height: 836 },
  { id: "compact", width: 960, height: 640 },
  { id: "zoom-200", width: 480, height: 800 },
] as const

export type FinalAcceptanceViewportId =
  (typeof finalAcceptanceViewports)[number]["id"]

export type AcceptanceSurface =
  | "browser_demo"
  | "webview_contract_fixture"
  | "native_tauri"

export type AcceptanceScenarioId =
  | "bilingual_happy_path"
  | "major_error_and_retry"
  | "keyboard_focus_aria_live"
  | "explicit_caption_tts_privacy"
  | "offline_native_unavailable"
  | "responsive_layout"
  | "locale_restart_and_late_event"
  | "multiworkspace_isolation"
  | "reduced_motion"
  | "attachment_security"
  | "listener_cleanup"
  | "workspace_200_performance"
  | "native_restart_repair_quit"
  | "native_process_cleanup"
  | "web_demo_boundary"

export interface AcceptanceScenarioDefinition {
  readonly id: AcceptanceScenarioId
  readonly requirementIds: readonly string[]
  readonly nativeOnly: boolean
}

export const finalAcceptanceScenarios: readonly AcceptanceScenarioDefinition[] =
  [
    {
      id: "bilingual_happy_path",
      requirementIds: [
        "APP-F-079",
        "WORK-F-050",
        "CODE-F-077",
        "GIT-F-090",
        "SUP-F-078",
        "NARR-F-078",
      ],
      nativeOnly: false,
    },
    {
      id: "major_error_and_retry",
      requirementIds: ["APP-F-065", "CODE-F-072", "HIST-F-053"],
      nativeOnly: false,
    },
    {
      id: "keyboard_focus_aria_live",
      requirementIds: ["APP-F-059", "APP-F-060", "NARR-F-058"],
      nativeOnly: false,
    },
    {
      id: "explicit_caption_tts_privacy",
      requirementIds: [
        "NARR-F-064",
        "NARR-F-078",
        "NARR-F-079",
        "NARR-F-089",
        "SUP-F-076",
        "SUP-F-077",
      ],
      nativeOnly: false,
    },
    {
      id: "offline_native_unavailable",
      requirementIds: ["APP-F-065", "APP-F-070", "SUP-F-058"],
      nativeOnly: false,
    },
    {
      id: "responsive_layout",
      requirementIds: ["APP-F-053", "APP-F-054", "APP-F-062"],
      nativeOnly: false,
    },
    {
      id: "locale_restart_and_late_event",
      requirementIds: ["APP-F-057", "APP-F-058", "SUP-F-057", "SUP-F-078"],
      nativeOnly: false,
    },
    {
      id: "multiworkspace_isolation",
      requirementIds: ["WORK-F-058", "WORK-F-059", "CODE-F-070"],
      nativeOnly: false,
    },
    {
      id: "reduced_motion",
      requirementIds: ["APP-F-061", "LIVE-F-071"],
      nativeOnly: false,
    },
    {
      id: "attachment_security",
      requirementIds: ["CODE-F-061", "CODE-F-062", "CODE-F-075"],
      nativeOnly: false,
    },
    {
      id: "listener_cleanup",
      requirementIds: ["APP-F-063", "APP-F-064", "CODE-F-072"],
      nativeOnly: false,
    },
    {
      id: "workspace_200_performance",
      requirementIds: ["WORK-F-060", "APP-F-073"],
      nativeOnly: false,
    },
    {
      id: "native_restart_repair_quit",
      requirementIds: ["APP-F-063", "APP-F-065", "WORK-F-062", "HIST-F-045"],
      nativeOnly: true,
    },
    {
      id: "native_process_cleanup",
      requirementIds: ["APP-F-064", "NARR-F-081", "SUP-F-050"],
      nativeOnly: true,
    },
    {
      id: "web_demo_boundary",
      requirementIds: ["APP-F-070", "HIST-F-059"],
      nativeOnly: false,
    },
  ]

const scenarioById = new Map(
  finalAcceptanceScenarios.map((scenario) => [scenario.id, scenario] as const),
)

export type AcceptanceEvidenceStatus = "passed" | "failed" | "not_executed"

export interface AcceptanceEvidence {
  readonly scenarioId: AcceptanceScenarioId
  readonly status: AcceptanceEvidenceStatus
  readonly surface: AcceptanceSurface
  readonly locale: Locale | null
  readonly viewport: FinalAcceptanceViewportId | null
  readonly assertions: readonly string[]
  readonly requirementIds: readonly string[]
  readonly reason: string | null
}

export interface AcceptanceEvidenceInput {
  readonly scenarioId: AcceptanceScenarioId
  readonly locale?: Locale
  readonly viewport?: FinalAcceptanceViewportId
  readonly assertions: readonly string[]
}

const privateEvidencePatterns = [
  /\/(?:Users|home)\//iu,
  /\b(?:bearer|api[_ -]?key|auth[_ -]?cookie)\b/iu,
  /\b(?:raw[_ -]?reasoning|chain[_ -]?of[_ -]?thought)\b/iu,
  /\braw\s+(?:stdout|stderr)\b/iu,
] as const

function definition(id: AcceptanceScenarioId): AcceptanceScenarioDefinition {
  const scenario = scenarioById.get(id)
  if (scenario === undefined) {
    throw new Error(`Unknown final acceptance scenario: ${id}`)
  }
  return scenario
}

export function containsPrivateAcceptanceEvidence(value: unknown): boolean {
  const text = JSON.stringify(value)
  return privateEvidencePatterns.some((pattern) => pattern.test(text))
}

export class FinalAcceptanceEvidenceRecorder {
  readonly #evidence: AcceptanceEvidence[] = []

  constructor(readonly surface: AcceptanceSurface) {}

  get evidence(): readonly AcceptanceEvidence[] {
    return this.#evidence
  }

  pass(input: AcceptanceEvidenceInput): AcceptanceEvidence {
    const scenario = definition(input.scenarioId)
    if (scenario.nativeOnly && this.surface !== "native_tauri") {
      throw new Error(
        `${input.scenarioId} requires a packaged native Tauri execution`,
      )
    }
    if (input.assertions.length === 0) {
      throw new Error(`${input.scenarioId} requires at least one assertion`)
    }
    if (containsPrivateAcceptanceEvidence(input.assertions)) {
      throw new Error(`${input.scenarioId} evidence contains private material`)
    }
    const evidence: AcceptanceEvidence = {
      scenarioId: input.scenarioId,
      status: "passed",
      surface: this.surface,
      locale: input.locale ?? null,
      viewport: input.viewport ?? null,
      assertions: input.assertions,
      requirementIds: scenario.requirementIds,
      reason: null,
    }
    this.#evidence.push(evidence)
    return evidence
  }

  fail(input: AcceptanceEvidenceInput, reason: string): AcceptanceEvidence {
    const scenario = definition(input.scenarioId)
    if (containsPrivateAcceptanceEvidence([input.assertions, reason])) {
      throw new Error(`${input.scenarioId} evidence contains private material`)
    }
    const evidence: AcceptanceEvidence = {
      scenarioId: input.scenarioId,
      status: "failed",
      surface: this.surface,
      locale: input.locale ?? null,
      viewport: input.viewport ?? null,
      assertions: input.assertions,
      requirementIds: scenario.requirementIds,
      reason,
    }
    this.#evidence.push(evidence)
    return evidence
  }

  notExecutedNative(
    scenarioId: AcceptanceScenarioId,
    assertions: readonly string[],
  ): AcceptanceEvidence {
    const scenario = definition(scenarioId)
    if (!scenario.nativeOnly) {
      throw new Error(`${scenarioId} is not a native-only scenario`)
    }
    if (this.surface === "native_tauri") {
      throw new Error(`${scenarioId} must be executed on the native surface`)
    }
    const evidence: AcceptanceEvidence = {
      scenarioId,
      status: "not_executed",
      surface: this.surface,
      locale: null,
      viewport: null,
      assertions,
      requirementIds: scenario.requirementIds,
      reason:
        "Requires the packaged Tauri app and real local process, filesystem, Git, and SQLite boundaries.",
    }
    this.#evidence.push(evidence)
    return evidence
  }

  assertNoFailures(): void {
    const failures = this.#evidence.filter(
      (evidence) => evidence.status === "failed",
    )
    if (failures.length > 0) {
      throw new Error(
        `Final acceptance evidence failed: ${failures
          .map((evidence) => evidence.scenarioId)
          .join(", ")}`,
      )
    }
  }
}

export interface AcceptanceMatrixEntry {
  readonly locale: Locale
  readonly viewport: FinalAcceptanceViewportId
  readonly journey: "happy" | "major_error"
}

export function buildFinalAcceptanceMatrix(): readonly AcceptanceMatrixEntry[] {
  return finalAcceptanceLocales.flatMap((locale) =>
    finalAcceptanceViewports.flatMap((viewport) =>
      (["happy", "major_error"] as const).map((journey) => ({
        locale,
        viewport: viewport.id,
        journey,
      })),
    ),
  )
}

export function percentile95(samples: readonly number[]): number {
  if (samples.length === 0) throw new Error("p95 requires at least one sample")
  if (samples.some((sample) => !Number.isFinite(sample) || sample < 0)) {
    throw new Error("p95 samples must be finite non-negative values")
  }
  const sorted = [...samples].sort((left, right) => left - right)
  const index = Math.ceil(sorted.length * 0.95) - 1
  return sorted[index] ?? 0
}

export interface AcceptanceBudgetEvidence {
  readonly sampleCount: number
  readonly budgetMs: number
  readonly p95Ms: number
  readonly maximumMs: number
  readonly passed: boolean
}

export function measureAcceptanceBudget(
  sampleCount: number,
  budgetMs: number,
  operation: (sample: number) => void,
  now: () => number = () => performance.now(),
): AcceptanceBudgetEvidence {
  if (!Number.isSafeInteger(sampleCount) || sampleCount < 1) {
    throw new Error("Acceptance performance requires a positive sample count")
  }
  const samples: number[] = []
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const startedAt = now()
    operation(sample)
    samples.push(Math.max(0, now() - startedAt))
  }
  const p95Ms = percentile95(samples)
  return {
    sampleCount,
    budgetMs,
    p95Ms,
    maximumMs: Math.max(...samples),
    passed: p95Ms <= budgetMs,
  }
}

export interface AcceptanceResourceSnapshot {
  readonly listeners: number
  readonly processes: number
  readonly queuedTasks: number
}

export function acceptanceResourceGrowth(
  before: AcceptanceResourceSnapshot,
  after: AcceptanceResourceSnapshot,
): AcceptanceResourceSnapshot {
  return {
    listeners: after.listeners - before.listeners,
    processes: after.processes - before.processes,
    queuedTasks: after.queuedTasks - before.queuedTasks,
  }
}

export function createAcceptanceWorkspaces(
  count = 200,
): readonly WorkspaceRecord[] {
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error("Workspace fixture count must be positive")
  }
  return Array.from({ length: count }, (_, index) => ({
    id: `acceptance-workspace-${String(index + 1).padStart(3, "0")}`,
    repository: `fixture/repository-${String(index % 8).padStart(2, "0")}`,
    name: `workspace-${String(index + 1).padStart(3, "0")}`,
    branch: index % 2 === 0 ? "develop" : `feature/batch-${String(index % 20)}`,
    lifecycle:
      index % 11 === 0 ? "in_review" : index % 7 === 0 ? "done" : "in_progress",
    health: "ready",
    updatedAt: new Date(Date.UTC(2026, 6, 19, 0, index % 60)).toISOString(),
  }))
}
