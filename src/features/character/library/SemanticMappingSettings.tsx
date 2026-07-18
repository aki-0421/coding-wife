import { useEffect, useMemo, useRef, useState } from "react"
import { EyeIcon, PackageIcon, RotateCcwIcon, SaveIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldLabel } from "@/components/ui/field"
import {
  NativeSelect,
  NativeSelectOptGroup,
  NativeSelectOption,
} from "@/components/ui/native-select"
import {
  semanticStates,
  type SemanticAssignmentsV1,
  type SemanticCueSelection,
  type SemanticState,
} from "@/features/character/library/contracts"
import {
  useCharacterLibrary,
  useCharacterLibraryStore,
} from "@/features/character/library/provider"
import { getSemanticMappingCopy } from "@/features/character/library/semantic-mapping-copy"
import { neutralSemanticAssignments } from "@/features/character/semantic-mapping"
import { useI18n } from "@/features/localization"

function encodeCue(cue: SemanticCueSelection): string {
  return cue.kind === "neutral" ? "neutral" : `${cue.kind}:${cue.cueId}`
}

function decodeCue(value: string): SemanticCueSelection {
  if (value === "neutral") return { kind: "neutral" }
  const separator = value.indexOf(":")
  const kind = value.slice(0, separator)
  const cueId = value.slice(separator + 1)
  return kind === "expression"
    ? { kind: "expression", cueId }
    : { kind: "motion", cueId }
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false,
  )
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return
    const query = window.matchMedia("(prefers-reduced-motion: reduce)")
    const update = () => setReduced(query.matches)
    query.addEventListener("change", update)
    return () => query.removeEventListener("change", update)
  }, [])
  return reduced
}

export function SemanticMappingSettings({
  workspaceId,
}: {
  readonly workspaceId: string
}) {
  const { locale } = useI18n()
  const copy = getSemanticMappingCopy(locale)
  const library = useCharacterLibrary(workspaceId)
  const store = useCharacterLibraryStore()
  const reducedMotion = usePrefersReducedMotion()
  const snapshot = library.snapshot
  const mapping = snapshot?.semanticMapping ?? null
  const selectedPack = snapshot?.packs.find(
    (pack) => pack.packId === snapshot.selectedPackId,
  )
  const [draft, setDraft] = useState<SemanticAssignmentsV1>(() =>
    neutralSemanticAssignments(),
  )
  const [previewState, setPreviewState] = useState<SemanticState>("neutral")
  const firstCueRef = useRef<HTMLSelectElement>(null)

  useEffect(() => {
    setDraft(mapping?.assignments ?? neutralSemanticAssignments())
  }, [mapping])
  useEffect(
    () => () => store.setSemanticPreview(workspaceId, null),
    [store, workspaceId],
  )
  useEffect(() => {
    if (snapshot?.semanticMappingStatus !== "invalid") return
    queueMicrotask(() => firstCueRef.current?.focus())
  }, [snapshot?.semanticMappingStatus])

  const cueOptions = useMemo(
    () => ({
      motions: selectedPack?.cueInventory.motions ?? [],
      expressions: selectedPack?.cueInventory.expressions ?? [],
    }),
    [selectedPack],
  )
  if (snapshot === null || mapping === null || selectedPack === undefined) {
    return null
  }

  const previewCue = draft[previewState]
  const busy = library.mutation !== null
  const save = () => {
    void store
      .saveSemanticMapping({
        workspaceId,
        packId: selectedPack.packId,
        manifestHash: selectedPack.manifestHash,
        expectedMappingVersion: mapping.mappingVersion,
        assignments: draft,
      })
      .catch(() => undefined)
  }

  return (
    <section
      aria-labelledby="semantic-mapping-title"
      className="mt-sm flex min-w-0 flex-col gap-md border-t border-divider pt-md"
      data-semantic-mapping-status={snapshot.semanticMappingStatus}
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-md">
        <div className="min-w-0 max-w-[62ch]">
          <h3
            className="m-0 text-title text-text-strong"
            id="semantic-mapping-title"
          >
            {copy.title}
          </h3>
          <p className="m-0 mt-xxs text-caption text-muted-foreground">
            {copy.description}
          </p>
        </div>
        <Badge variant="outline">
          {copy.version.replace("{version}", String(mapping.mappingVersion))}
        </Badge>
      </div>

      {snapshot.semanticMappingStatus === "invalid" ? (
        <Alert>
          <AlertTitle>{copy.invalidTitle}</AlertTitle>
          <AlertDescription>{copy.invalidDescription}</AlertDescription>
        </Alert>
      ) : null}

      <div className="overflow-hidden rounded-control border border-divider">
        {semanticStates.map((state) => {
          const inputId = `semantic-cue-${state}`
          return (
            <Field
              className="grid min-w-0 grid-cols-[minmax(7rem,0.7fr)_minmax(10rem,1.5fr)_auto] items-center gap-sm border-b border-divider px-sm py-xs last:border-b-0 max-[560px]:grid-cols-1"
              key={state}
            >
              <FieldLabel className="text-caption" htmlFor={inputId}>
                {copy[state]}
              </FieldLabel>
              <NativeSelect
                aria-label={`${copy[state]} cue`}
                className="w-full"
                disabled={busy}
                id={inputId}
                onChange={(event) => {
                  const cue = decodeCue(event.currentTarget.value)
                  setDraft((current) => ({
                    ...current,
                    [state]: cue,
                  }))
                }}
                ref={state === "neutral" ? firstCueRef : undefined}
                size="sm"
                value={encodeCue(draft[state])}
              >
                <NativeSelectOption value="neutral">
                  {copy.neutralCue}
                </NativeSelectOption>
                {cueOptions.motions.length > 0 ? (
                  <NativeSelectOptGroup label={copy.motionGroup}>
                    {cueOptions.motions.map((cueId) => (
                      <NativeSelectOption key={cueId} value={`motion:${cueId}`}>
                        {cueId}
                      </NativeSelectOption>
                    ))}
                  </NativeSelectOptGroup>
                ) : null}
                {cueOptions.expressions.length > 0 ? (
                  <NativeSelectOptGroup label={copy.expressionGroup}>
                    {cueOptions.expressions.map((cueId) => (
                      <NativeSelectOption
                        key={cueId}
                        value={`expression:${cueId}`}
                      >
                        {cueId}
                      </NativeSelectOption>
                    ))}
                  </NativeSelectOptGroup>
                ) : null}
              </NativeSelect>
              <Button
                disabled={busy}
                onClick={() => {
                  setPreviewState(state)
                  store.setSemanticPreview(workspaceId, {
                    state,
                    cue: draft[state],
                  })
                }}
                size="xs"
                type="button"
                variant="ghost"
              >
                <EyeIcon aria-hidden="true" />
                {copy.preview}
              </Button>
            </Field>
          )
        })}
      </div>

      <div
        aria-live="polite"
        className="flex min-w-0 items-center gap-sm rounded-control border border-divider bg-panel px-sm py-xs"
        data-semantic-preview={reducedMotion ? "static" : "animated"}
      >
        <PackageIcon aria-hidden="true" className="size-4 text-primary" />
        <span className="min-w-0 flex-1 text-caption text-muted-foreground">
          <span className="text-text-strong">{copy.previewTitle}</span>
          {" · "}
          {copy[previewState]} · {encodeCue(previewCue)}
          {" · "}
          {reducedMotion ? copy.staticPreview : copy.animatedPreview}
        </span>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-xs">
        {snapshot.semanticMappingStatus === "saved" ? (
          <span className="mr-auto text-label text-muted-foreground">
            {copy.saved}
          </span>
        ) : null}
        <Button
          disabled={busy}
          onClick={() => {
            setDraft(neutralSemanticAssignments())
            setPreviewState("neutral")
            store.setSemanticPreview(workspaceId, {
              state: "neutral",
              cue: { kind: "neutral" },
            })
          }}
          size="xs"
          type="button"
          variant="ghost"
        >
          <RotateCcwIcon aria-hidden="true" />
          {copy.reset}
        </Button>
        <Button disabled={busy} onClick={save} size="xs" type="button">
          <SaveIcon aria-hidden="true" />
          {library.mutation === "saving_mapping" ? copy.saving : copy.save}
        </Button>
      </div>
    </section>
  )
}
