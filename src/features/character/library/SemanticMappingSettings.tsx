import { useEffect, useMemo, useRef, useState } from "react"
import { LockKeyholeIcon, RotateCcwIcon, SaveIcon } from "lucide-react"

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
  builtinHiyoriPackId,
  semanticStates,
  type CharacterLibrarySnapshot,
  type CharacterPackView,
  type SemanticAssignmentsV1,
  type SemanticCueSelection,
  type SemanticMappingV1,
} from "@/features/character/library/contracts"
import {
  type CharacterLibraryState,
  type CharacterLibraryStore,
  useCharacterLibrary,
  useCharacterLibraryStore,
} from "@/features/character/library/provider"
import {
  getSemanticMappingCopy,
  type SemanticMappingCopy,
} from "@/features/character/library/semantic-mapping-copy"
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

export function SemanticMappingSettings({
  packId,
  workspaceId,
}: {
  readonly packId: string
  readonly workspaceId: string
}) {
  const { locale } = useI18n()
  const copy = getSemanticMappingCopy(locale)
  const library = useCharacterLibrary(workspaceId)
  const store = useCharacterLibraryStore()
  const snapshot = library.snapshot
  const pack = snapshot?.packs.find((candidate) => candidate.packId === packId)

  if (snapshot === null || pack === undefined) return null
  if (pack.packId === builtinHiyoriPackId) {
    return <BundledHiyoriMotionSettings copy={copy} />
  }
  if (pack.packId !== snapshot.selectedPackId) {
    return <InactiveCustomMotionSettings copy={copy} />
  }

  return (
    <SemanticMappingEditor
      copy={copy}
      initialAssignments={snapshot.semanticMapping.assignments}
      key={`${workspaceId}:${pack.packId}:${pack.manifestHash}`}
      library={library}
      mapping={snapshot.semanticMapping}
      selectedPack={pack}
      snapshot={snapshot}
      store={store}
      workspaceId={workspaceId}
    />
  )
}

function MotionSettingsHeading({
  copy,
  bundled,
}: {
  readonly copy: SemanticMappingCopy
  readonly bundled: boolean
}) {
  return (
    <div className="min-w-0 max-w-[62ch]">
      <h4
        className="m-0 text-title text-text-strong"
        id="motion-settings-title"
      >
        {copy.title}
      </h4>
      <p className="m-0 mt-xxs text-caption text-muted-foreground">
        {bundled ? copy.bundledDescription : copy.description}
      </p>
    </div>
  )
}

function BundledHiyoriMotionSettings({
  copy,
}: {
  readonly copy: SemanticMappingCopy
}) {
  return (
    <section
      aria-labelledby="motion-settings-title"
      className="mt-sm flex min-w-0 flex-col gap-md border-t border-divider pt-md"
      data-motion-settings="preset"
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-md">
        <MotionSettingsHeading bundled copy={copy} />
        <Badge variant="outline">
          <LockKeyholeIcon aria-hidden="true" />
          {copy.presetLocked}
        </Badge>
      </div>
      <dl className="m-0 overflow-hidden rounded-control border border-divider">
        {semanticStates.map((state) => (
          <div
            className="grid min-w-0 grid-cols-[minmax(7rem,0.7fr)_minmax(10rem,1.5fr)] items-center gap-sm border-b border-divider px-sm py-sm last:border-b-0 max-[560px]:grid-cols-1"
            key={state}
          >
            <dt className="text-caption text-muted-foreground">
              {copy[state]}
            </dt>
            <dd className="m-0 text-caption text-text-strong">
              {copy.presetMotions[state]}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

function InactiveCustomMotionSettings({
  copy,
}: {
  readonly copy: SemanticMappingCopy
}) {
  return (
    <section
      aria-labelledby="motion-settings-title"
      className="mt-sm flex min-w-0 flex-col gap-md border-t border-divider pt-md"
      data-motion-settings="inactive"
    >
      <div className="min-w-0 max-w-[62ch]">
        <h4
          className="m-0 text-title text-text-strong"
          id="motion-settings-title"
        >
          {copy.title}
        </h4>
        <p className="m-0 mt-xxs text-caption text-muted-foreground">
          {copy.inactiveDescription}
        </p>
      </div>
    </section>
  )
}

function SemanticMappingEditor({
  copy,
  initialAssignments,
  library,
  mapping,
  selectedPack,
  snapshot,
  store,
  workspaceId,
}: {
  readonly copy: SemanticMappingCopy
  readonly initialAssignments: SemanticAssignmentsV1
  readonly library: CharacterLibraryState
  readonly mapping: SemanticMappingV1
  readonly selectedPack: CharacterPackView
  readonly snapshot: CharacterLibrarySnapshot
  readonly store: CharacterLibraryStore
  readonly workspaceId: string
}) {
  const [draft, setDraft] = useState<SemanticAssignmentsV1>(
    () => initialAssignments,
  )
  const firstCueRef = useRef<HTMLSelectElement>(null)

  useEffect(() => {
    if (snapshot.semanticMappingStatus !== "invalid") return
    queueMicrotask(() => firstCueRef.current?.focus())
  }, [snapshot.semanticMappingStatus])

  const cueOptions = useMemo(
    () => ({
      motions: selectedPack.cueInventory.motions,
      expressions: selectedPack.cueInventory.expressions,
    }),
    [selectedPack],
  )

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
      aria-labelledby="motion-settings-title"
      className="mt-sm flex min-w-0 flex-col gap-md border-t border-divider pt-md"
      data-motion-settings={snapshot.semanticMappingStatus}
    >
      <MotionSettingsHeading bundled={false} copy={copy} />

      {snapshot.semanticMappingStatus === "invalid" ? (
        <Alert>
          <AlertTitle>{copy.invalidTitle}</AlertTitle>
          <AlertDescription>{copy.invalidDescription}</AlertDescription>
        </Alert>
      ) : null}

      <div className="overflow-hidden rounded-control border border-divider">
        {semanticStates.map((state) => {
          const inputId = `motion-setting-${state}`
          return (
            <Field
              className="grid min-w-0 grid-cols-[minmax(7rem,0.7fr)_minmax(10rem,1.5fr)] items-center gap-sm border-b border-divider px-sm py-xs last:border-b-0 max-[560px]:grid-cols-1"
              key={state}
            >
              <FieldLabel className="text-caption" htmlFor={inputId}>
                {copy[state]}
              </FieldLabel>
              <NativeSelect
                aria-label={copy[state]}
                className="w-full"
                disabled={busy}
                id={inputId}
                onChange={(event) => {
                  const cue = decodeCue(event.currentTarget.value)
                  setDraft((current) => ({ ...current, [state]: cue }))
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
            </Field>
          )
        })}
      </div>

      <div className="flex flex-wrap items-center justify-end gap-xs">
        {snapshot.semanticMappingStatus === "saved" ? (
          <span className="mr-auto text-label text-muted-foreground">
            {copy.saved}
          </span>
        ) : null}
        <Button
          disabled={busy}
          onClick={() => setDraft(neutralSemanticAssignments())}
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
