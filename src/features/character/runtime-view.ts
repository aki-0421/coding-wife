import {
  BUILTIN_HIYORI_PACK,
  type CharacterRuntimeSnapshot,
} from "@/features/character/runtime-status"
import type {
  CharacterErrorCode,
  CharacterFallbackLevel,
  CharacterMotionPolicy,
} from "@/features/character/model"

export type CharacterRuntimeViewPhase =
  | "idle"
  | "loading"
  | "ready"
  | "recovering"
  | "error"
  | "disposed"
  | "hidden"
  | "unknown"

export type CharacterRuntimeReadiness =
  | "loading"
  | "ready"
  | "recovering"
  | "degraded"
  | "error"
  | "hidden"
  | "unknown"

export interface CharacterRuntimeView {
  readonly rendererKind: CharacterRuntimeSnapshot["rendererKind"]
  readonly phase: CharacterRuntimeViewPhase
  readonly fallback: CharacterFallbackLevel | "unknown"
  readonly motionPolicy: CharacterMotionPolicy | "unknown"
  readonly readiness: CharacterRuntimeReadiness
  readonly pack: typeof BUILTIN_HIYORI_PACK | null
  readonly currentErrorCode: CharacterErrorCode | null
  readonly lastErrorCode: CharacterErrorCode | null
  readonly canRetry: boolean
}

export function projectCharacterRuntime(
  snapshot: CharacterRuntimeSnapshot,
  hidden: boolean,
): CharacterRuntimeView {
  if (hidden) {
    return {
      rendererKind: snapshot.rendererKind,
      phase: "hidden",
      fallback: "text_only",
      motionPolicy: "hidden",
      readiness: "hidden",
      pack:
        snapshot.rendererKind === "builtin_hiyori" ? BUILTIN_HIYORI_PACK : null,
      currentErrorCode: null,
      lastErrorCode: snapshot.lastErrorCode,
      canRetry: false,
    }
  }

  if (snapshot.rendererKind === "external") {
    return {
      rendererKind: "external",
      phase: "unknown",
      fallback: "unknown",
      motionPolicy: "unknown",
      readiness: "unknown",
      pack: null,
      currentErrorCode: null,
      lastErrorCode: snapshot.lastErrorCode,
      canRetry: false,
    }
  }

  const status = snapshot.status
  if (!snapshot.mounted || status === null) {
    return {
      rendererKind: "builtin_hiyori",
      phase: "loading",
      fallback: "text_only",
      motionPolicy: "unknown",
      readiness: "loading",
      pack: BUILTIN_HIYORI_PACK,
      currentErrorCode: null,
      lastErrorCode: snapshot.lastErrorCode,
      canRetry: false,
    }
  }

  const readiness: CharacterRuntimeReadiness =
    status.phase === "error"
      ? "error"
      : status.phase === "recovering"
        ? "recovering"
        : status.phase === "ready" &&
            (status.fallbackLevel === "static" ||
              status.fallbackLevel === "text_only")
          ? "degraded"
          : status.phase === "ready"
            ? "ready"
            : status.phase === "disposed"
              ? "loading"
              : "loading"

  const packProvenance = status.pack?.provenance

  return {
    rendererKind: "builtin_hiyori",
    phase: status.phase,
    fallback: status.fallbackLevel,
    motionPolicy: status.motionPolicy,
    readiness,
    pack: status.pack
      ? {
          packId: status.pack.packId,
          displayName: status.pack.displayName,
          bundledVersion: status.pack.bundledVersion,
          illustration:
            packProvenance?.sourceKind === "developer-provided"
              ? packProvenance.illustration
              : (packProvenance?.sourceLabel ?? "Local folder"),
          modeling:
            packProvenance?.sourceKind === "developer-provided"
              ? packProvenance.modeling
              : "User imported",
          noticeSha256:
            packProvenance?.sourceKind === "developer-provided"
              ? packProvenance.noticeSha256
              : (status.pack.thumbnailSha256 ?? "—"),
        }
      : BUILTIN_HIYORI_PACK,
    currentErrorCode:
      status.error?.code === "disposed" ? null : (status.error?.code ?? null),
    lastErrorCode: snapshot.lastErrorCode,
    canRetry: snapshot.canRetry,
  }
}
