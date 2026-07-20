import type {
  NativeReadinessSnapshotV1,
  ReadinessCheckId,
  ReadinessCheckV1,
} from "@/features/readiness/contracts"
import type { NativeReadinessControllerState } from "@/features/readiness/controller"

const internalSetupCheckIds = [
  "os_app",
  "history",
  "live2d",
  "preferences",
] as const satisfies readonly ReadinessCheckId[]

export type SetupRequirementKey =
  | "codex"
  | "git"
  | "project"
  | "diagnostics"
  | (typeof internalSetupCheckIds)[number]

export interface SetupRequirement {
  readonly key: SetupRequirementKey
  readonly check: ReadinessCheckV1 | null
}

export interface SetupRequirementOverrides {
  readonly runtimeUnavailable?: boolean
}

export function checkById(
  snapshot: NativeReadinessSnapshotV1 | null,
  id: ReadinessCheckId,
): ReadinessCheckV1 | null {
  return snapshot?.checks.find((check) => check.id === id) ?? null
}

export function gitExecutableIsReady(check: ReadinessCheckV1 | null): boolean {
  if (check === null) return false
  const fact = check.facts.find((item) => item.key === "git_executable")
  return (
    fact?.value === "available" ||
    (fact === undefined && check.status === "ready")
  )
}

export function unresolvedSetupRequirements(
  snapshot: NativeReadinessSnapshotV1 | null,
  projectCount: number,
  overrides: SetupRequirementOverrides = {},
): readonly SetupRequirement[] {
  if (snapshot === null) {
    return [
      { key: "diagnostics", check: null },
      ...(projectCount === 0
        ? ([{ key: "project", check: null }] as const)
        : []),
    ]
  }

  const requirements: SetupRequirement[] = []
  const codex = checkById(snapshot, "codex")
  const git = checkById(snapshot, "git")
  if (codex === null || codex.status !== "ready") {
    requirements.push({
      key: "codex",
      check: codex,
    })
  }
  if (!gitExecutableIsReady(git)) {
    requirements.push({ key: "git", check: git })
  }
  if (overrides.runtimeUnavailable === true) {
    requirements.push({ key: "diagnostics", check: null })
  }
  if (projectCount === 0) {
    requirements.push({ key: "project", check: null })
  }
  for (const id of internalSetupCheckIds) {
    const item = checkById(snapshot, id)
    if (
      item !== null &&
      (item.status === "blocked" || item.status === "unavailable")
    ) {
      requirements.push({ key: id, check: item })
    }
  }
  return requirements
}

export function shouldShowSetupOverview(
  hydrationMode: "demo" | "native" | undefined,
  state: NativeReadinessControllerState,
  projectCount: number,
  overrides: SetupRequirementOverrides = {},
): boolean {
  if (hydrationMode !== "native") return false
  if (state.snapshot?.source === "demo") return false
  if (state.snapshot === null) return state.status === "error"
  if (projectCount === 0 || overrides.runtimeUnavailable === true) {
    return true
  }
  return (
    unresolvedSetupRequirements(state.snapshot, projectCount, overrides)
      .length > 0
  )
}
