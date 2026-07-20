import { useEffect, useMemo, useRef } from "react"
import {
  AlertTriangleIcon,
  BotIcon,
  FolderCogIcon,
  RefreshCwIcon,
} from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { WorkspaceCopy } from "@/features/workspace-view/copy"
import {
  normalizeContextListDraft,
  type EditableContextField,
  type EditableSettingsContextModel,
} from "@/features/workspace-view/useEditableSettingsContext"
import { unicodeScalarCount } from "@/lib/public-text"

interface EditableContextSectionProps {
  readonly copy: WorkspaceCopy
  readonly instanceId: string
  readonly model: EditableSettingsContextModel
  readonly section: "project" | "character"
  readonly turnActive: boolean
}

function projectTotal(model: EditableSettingsContextModel): number {
  const context = model.project.draft
  return [
    context.goal,
    context.constraints,
    context.userNotes,
    ...normalizeContextListDraft(model.project.listDrafts.definitionOfDone),
    ...normalizeContextListDraft(model.project.listDrafts.technicalReferences),
  ].reduce((total, value) => total + unicodeScalarCount(value), 0)
}

function characterTotal(model: EditableSettingsContextModel): number {
  const context = model.character.draft
  return [
    context.displayName,
    context.tone,
    context.toneNotes,
    context.speechDensity,
    context.behavior,
    ...normalizeContextListDraft(
      model.character.listDrafts.prohibitedExpressions,
    ),
  ].reduce((total, value) => total + unicodeScalarCount(value), 0)
}

function SectionStatus({
  copy,
  model,
  onReload,
  section,
}: Pick<EditableContextSectionProps, "copy" | "model" | "section"> & {
  readonly onReload: () => void
}) {
  const state = section === "project" ? model.project : model.character
  if (state.status === "conflict" && state.conflict !== null) {
    return (
      <Alert data-context-conflict={section}>
        <AlertTriangleIcon aria-hidden="true" className="text-running" />
        <AlertTitle>{copy.contextView.conflictTitle}</AlertTitle>
        <AlertDescription className="flex flex-col items-start gap-sm">
          <span>
            {copy.contextView.conflictVersions
              .replace("{local}", String(state.conflict.localVersion))
              .replace("{remote}", String(state.conflict.remoteVersion))}
          </span>
          {state.conflict.changedFields.length > 0 ? (
            <span>
              {copy.contextView.changedFields}{" "}
              <code className="font-mono text-label text-foreground">
                {state.conflict.changedFields.join(", ")}
              </code>
            </span>
          ) : null}
          <Button
            onClick={onReload}
            size="xs"
            type="button"
            variant="secondary"
          >
            <RefreshCwIcon aria-hidden="true" data-icon="inline-start" />
            {copy.contextView.reloadCurrent}
          </Button>
        </AlertDescription>
      </Alert>
    )
  }
  if (state.status === "error") {
    return (
      <Alert data-context-error={section}>
        <AlertTriangleIcon aria-hidden="true" className="text-destructive" />
        <AlertTitle>{copy.contextView.saveError}</AlertTitle>
        <AlertDescription className="flex flex-col items-start gap-sm">
          <span>{copy.contextView.saveErrorDescription}</span>
          <code className="font-mono text-label text-destructive">
            {state.errorCode ?? "WORKSPACE-CONTEXT-UNKNOWN"}
          </code>
          {state.persisted === null ? (
            <Button
              onClick={model.retryLoad}
              size="xs"
              type="button"
              variant="secondary"
            >
              <RefreshCwIcon aria-hidden="true" data-icon="inline-start" />
              {copy.retry}
            </Button>
          ) : null}
        </AlertDescription>
      </Alert>
    )
  }
  if (state.status === "saved") {
    return (
      <p
        aria-live="polite"
        className="m-0 text-caption text-success"
        role="status"
      >
        {copy.contextView.savedNextTurn}
      </p>
    )
  }
  return null
}

function LoadingContext({
  copy,
  section,
}: Pick<EditableContextSectionProps, "copy" | "section">) {
  return (
    <div
      aria-label={
        section === "project"
          ? copy.contextView.loadingProject
          : copy.contextView.loadingCharacter
      }
      className="flex flex-col gap-lg"
      role="status"
    >
      <Skeleton className="h-5 w-44" />
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-8 w-32" />
    </div>
  )
}

export function EditableContextSection({
  copy,
  instanceId,
  model,
  section,
  turnActive,
}: EditableContextSectionProps) {
  const project = section === "project"
  const state = project ? model.project : model.character
  const fieldRefs = useRef<
    Partial<
      Record<
        EditableContextField,
        HTMLInputElement | HTMLTextAreaElement | null
      >
    >
  >({})
  const titleRef = useRef<HTMLHeadingElement | null>(null)
  const titleId = `${instanceId}-${section}-context-title`
  const invalidField =
    state.status === "error" && state.persisted !== null
      ? (state.fieldError?.field ?? null)
      : null
  const total = project ? projectTotal(model) : characterTotal(model)
  const maximum = project ? 32_000 : 12_000
  const definitionCount = normalizeContextListDraft(
    model.project.listDrafts.definitionOfDone,
  ).length
  const referenceCount = normalizeContextListDraft(
    model.project.listDrafts.technicalReferences,
  ).length
  const prohibitedCount = normalizeContextListDraft(
    model.character.listDrafts.prohibitedExpressions,
  ).length

  const fieldErrorId = (field: EditableContextField) =>
    `${instanceId}-${section}-${field}-error`
  const describedBy = (field: EditableContextField, descriptionId?: string) => {
    const ids = [
      descriptionId,
      invalidField === field ? fieldErrorId(field) : undefined,
    ].filter((value): value is string => value !== undefined)
    return ids.length === 0 ? undefined : ids.join(" ")
  }
  const renderFieldError = (field: EditableContextField) => {
    if (invalidField !== field || state.fieldError === null) return null
    return (
      <FieldDescription className="text-destructive" id={fieldErrorId(field)}>
        {copy.contextView.errors[state.fieldError.reason]}
      </FieldDescription>
    )
  }
  const reload = () => {
    if (project) model.reloadProject()
    else model.reloadCharacter()
    queueMicrotask(() => titleRef.current?.focus())
  }

  useEffect(() => {
    if (state.status !== "error" || state.persisted === null) return
    if (invalidField !== null) fieldRefs.current[invalidField]?.focus()
    else titleRef.current?.focus()
  }, [invalidField, state.errorCode, state.persisted, state.status])

  const metadata = useMemo(() => {
    if (state.persisted === null) return null
    return {
      version: state.persisted.version,
      hash: state.persisted.contentHash.slice(0, 8),
    }
  }, [state.persisted])

  if (state.status === "loading" || state.persisted === null) {
    return <LoadingContext copy={copy} section={section} />
  }

  const busy = state.status === "saving"
  const Icon = project ? FolderCogIcon : BotIcon
  return (
    <section
      aria-labelledby={titleId}
      className="flex min-w-0 flex-col gap-lg"
      data-context-section={section}
    >
      <div className="flex flex-wrap items-start justify-between gap-md">
        <div className="flex min-w-0 items-start gap-sm">
          <Icon
            aria-hidden="true"
            className="mt-xxs size-4 shrink-0 text-muted-foreground"
          />
          <div className="flex min-w-0 flex-col gap-xxs">
            <h2
              className="m-0 text-title text-text-strong"
              id={titleId}
              ref={titleRef}
              tabIndex={-1}
            >
              {project
                ? copy.contextView.projectTitle
                : copy.contextView.characterTitle}
            </h2>
            <p className="m-0 max-w-[70ch] text-caption text-muted-foreground">
              {project
                ? copy.contextView.projectDescription
                : copy.contextView.characterDescription}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-xs">
          {state.dirty ? (
            <Badge variant="running">{copy.contextView.unsaved}</Badge>
          ) : null}
          {project ? (
            <>
              <Badge variant="outline">
                {copy.contextView.version} {metadata?.version ?? "—"}
              </Badge>
              <Badge className="font-mono" variant="outline">
                {metadata?.hash ?? "—"}
              </Badge>
            </>
          ) : null}
        </div>
      </div>

      <SectionStatus
        copy={copy}
        model={model}
        onReload={reload}
        section={section}
      />

      {project ? (
        <FieldGroup>
          <Field data-invalid={invalidField === "goal" || undefined}>
            <FieldLabel htmlFor={`${instanceId}-project-goal`}>
              {copy.contextView.goal}
            </FieldLabel>
            <Textarea
              aria-describedby={describedBy("goal")}
              aria-invalid={invalidField === "goal" || undefined}
              disabled={busy}
              id={`${instanceId}-project-goal`}
              maxLength={8000}
              onChange={(event) =>
                model.updateProject({ goal: event.currentTarget.value })
              }
              ref={(element) => {
                fieldRefs.current.goal = element
              }}
              rows={3}
              value={model.project.draft.goal}
            />
            {renderFieldError("goal")}
          </Field>
          <Field data-invalid={invalidField === "constraints" || undefined}>
            <FieldLabel htmlFor={`${instanceId}-project-constraints`}>
              {copy.contextView.constraints}
            </FieldLabel>
            <Textarea
              aria-describedby={describedBy("constraints")}
              aria-invalid={invalidField === "constraints" || undefined}
              disabled={busy}
              id={`${instanceId}-project-constraints`}
              maxLength={8000}
              onChange={(event) =>
                model.updateProject({ constraints: event.currentTarget.value })
              }
              ref={(element) => {
                fieldRefs.current.constraints = element
              }}
              rows={3}
              value={model.project.draft.constraints}
            />
            {renderFieldError("constraints")}
          </Field>
          <Field
            data-invalid={invalidField === "definitionOfDone" || undefined}
          >
            <FieldLabel htmlFor={`${instanceId}-project-definition`}>
              {copy.contextView.definition}
            </FieldLabel>
            <Textarea
              aria-describedby={describedBy(
                "definitionOfDone",
                `${instanceId}-project-definition-description`,
              )}
              aria-invalid={invalidField === "definitionOfDone" || undefined}
              disabled={busy}
              id={`${instanceId}-project-definition`}
              maxLength={10019}
              onBlur={() => model.normalizeProjectList("definitionOfDone")}
              onChange={(event) =>
                model.updateProjectList(
                  "definitionOfDone",
                  event.currentTarget.value,
                )
              }
              ref={(element) => {
                fieldRefs.current.definitionOfDone = element
              }}
              rows={4}
              value={model.project.listDrafts.definitionOfDone}
            />
            <FieldDescription
              id={`${instanceId}-project-definition-description`}
            >
              {copy.contextView.onePerLine} · {definitionCount}/20
            </FieldDescription>
            {renderFieldError("definitionOfDone")}
          </Field>
          <Field
            data-invalid={invalidField === "technicalReferences" || undefined}
          >
            <FieldLabel htmlFor={`${instanceId}-project-references`}>
              {copy.contextView.technicalReferences}
            </FieldLabel>
            <Textarea
              aria-describedby={describedBy(
                "technicalReferences",
                `${instanceId}-project-references-description`,
              )}
              aria-invalid={invalidField === "technicalReferences" || undefined}
              disabled={busy}
              id={`${instanceId}-project-references`}
              maxLength={10019}
              onBlur={() => model.normalizeProjectList("technicalReferences")}
              onChange={(event) =>
                model.updateProjectList(
                  "technicalReferences",
                  event.currentTarget.value,
                )
              }
              ref={(element) => {
                fieldRefs.current.technicalReferences = element
              }}
              rows={3}
              value={model.project.listDrafts.technicalReferences}
            />
            <FieldDescription
              id={`${instanceId}-project-references-description`}
            >
              {copy.contextView.referencesDescription} · {referenceCount}/20
            </FieldDescription>
            {renderFieldError("technicalReferences")}
          </Field>
          <Field data-invalid={invalidField === "userNotes" || undefined}>
            <FieldLabel htmlFor={`${instanceId}-project-notes`}>
              {copy.contextView.userNotes}
            </FieldLabel>
            <Textarea
              aria-describedby={describedBy("userNotes")}
              aria-invalid={invalidField === "userNotes" || undefined}
              disabled={busy}
              id={`${instanceId}-project-notes`}
              maxLength={8000}
              onChange={(event) =>
                model.updateProject({ userNotes: event.currentTarget.value })
              }
              ref={(element) => {
                fieldRefs.current.userNotes = element
              }}
              rows={3}
              value={model.project.draft.userNotes}
            />
            {renderFieldError("userNotes")}
          </Field>
        </FieldGroup>
      ) : (
        <FieldGroup>
          <Field data-invalid={invalidField === "displayName" || undefined}>
            <FieldLabel htmlFor={`${instanceId}-character-name`}>
              {copy.contextView.displayName}
            </FieldLabel>
            <Input
              aria-describedby={describedBy("displayName")}
              aria-invalid={invalidField === "displayName" || undefined}
              disabled={busy}
              id={`${instanceId}-character-name`}
              maxLength={40}
              onChange={(event) =>
                model.updateCharacter({
                  displayName: event.currentTarget.value,
                })
              }
              ref={(element) => {
                fieldRefs.current.displayName = element
              }}
              value={model.character.draft.displayName}
            />
            {renderFieldError("displayName")}
          </Field>
          <FieldSet>
            <FieldLegend>{copy.contextView.tone}</FieldLegend>
            <ToggleGroup
              aria-label={copy.contextView.tone}
              disabled={busy}
              onValueChange={(value) => {
                if (
                  value === "concise" ||
                  value === "warm" ||
                  value === "neutral"
                ) {
                  model.updateCharacter({ tone: value })
                }
              }}
              type="single"
              value={model.character.draft.tone}
            >
              <ToggleGroupItem value="concise">
                {copy.contextView.concise}
              </ToggleGroupItem>
              <ToggleGroupItem value="warm">
                {copy.contextView.warm}
              </ToggleGroupItem>
              <ToggleGroupItem value="neutral">
                {copy.contextView.neutral}
              </ToggleGroupItem>
            </ToggleGroup>
          </FieldSet>
          <Field data-invalid={invalidField === "toneNotes" || undefined}>
            <FieldLabel htmlFor={`${instanceId}-character-tone-notes`}>
              {copy.contextView.toneNotes}
            </FieldLabel>
            <Textarea
              aria-describedby={describedBy("toneNotes")}
              aria-invalid={invalidField === "toneNotes" || undefined}
              disabled={busy}
              id={`${instanceId}-character-tone-notes`}
              maxLength={1000}
              onChange={(event) =>
                model.updateCharacter({ toneNotes: event.currentTarget.value })
              }
              ref={(element) => {
                fieldRefs.current.toneNotes = element
              }}
              rows={2}
              value={model.character.draft.toneNotes}
            />
            {renderFieldError("toneNotes")}
          </Field>
          <FieldSet>
            <FieldLegend>{copy.contextView.speechDensity}</FieldLegend>
            <ToggleGroup
              aria-label={copy.contextView.speechDensity}
              disabled={busy}
              onValueChange={(value) => {
                if (
                  value === "quiet" ||
                  value === "key_events" ||
                  value === "detailed"
                ) {
                  model.updateCharacter({ speechDensity: value })
                }
              }}
              type="single"
              value={model.character.draft.speechDensity}
            >
              <ToggleGroupItem value="quiet">
                {copy.contextView.quiet}
              </ToggleGroupItem>
              <ToggleGroupItem value="key_events">
                {copy.contextView.keyEvents}
              </ToggleGroupItem>
              <ToggleGroupItem value="detailed">
                {copy.contextView.detailed}
              </ToggleGroupItem>
            </ToggleGroup>
          </FieldSet>
          <Field data-invalid={invalidField === "behavior" || undefined}>
            <FieldLabel htmlFor={`${instanceId}-character-behavior`}>
              {copy.contextView.behavior}
            </FieldLabel>
            <Textarea
              aria-describedby={describedBy("behavior")}
              aria-invalid={invalidField === "behavior" || undefined}
              disabled={busy}
              id={`${instanceId}-character-behavior`}
              maxLength={4000}
              onChange={(event) =>
                model.updateCharacter({ behavior: event.currentTarget.value })
              }
              ref={(element) => {
                fieldRefs.current.behavior = element
              }}
              rows={3}
              value={model.character.draft.behavior}
            />
            {renderFieldError("behavior")}
          </Field>
          <Field
            data-invalid={invalidField === "prohibitedExpressions" || undefined}
          >
            <FieldLabel htmlFor={`${instanceId}-character-prohibited`}>
              {copy.contextView.prohibited}
            </FieldLabel>
            <Textarea
              aria-describedby={describedBy(
                "prohibitedExpressions",
                `${instanceId}-character-prohibited-description`,
              )}
              aria-invalid={
                invalidField === "prohibitedExpressions" || undefined
              }
              disabled={busy}
              id={`${instanceId}-character-prohibited`}
              maxLength={4019}
              onBlur={model.normalizeCharacterList}
              onChange={(event) =>
                model.updateCharacterList(event.currentTarget.value)
              }
              ref={(element) => {
                fieldRefs.current.prohibitedExpressions = element
              }}
              rows={3}
              value={model.character.listDrafts.prohibitedExpressions}
            />
            <FieldDescription
              id={`${instanceId}-character-prohibited-description`}
            >
              {copy.contextView.policyBoundary} · {copy.contextView.onePerLine}{" "}
              · {prohibitedCount}/20
            </FieldDescription>
            {renderFieldError("prohibitedExpressions")}
          </Field>
        </FieldGroup>
      )}

      <div className="flex flex-wrap items-center justify-between gap-md pb-xl">
        <div className="flex min-w-0 flex-col gap-xxs">
          <p className="m-0 text-caption text-muted-foreground">
            {copy.contextView.total
              .replace("{count}", String(total))
              .replace("{maximum}", String(maximum))}
          </p>
          <p className="m-0 text-caption text-muted-foreground">
            {turnActive
              ? copy.contextView.runningTurnUnaffected
              : copy.contextView.nextTurn}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-xs">
          <Button
            disabled={!state.dirty || busy}
            onClick={project ? model.discardProject : model.discardCharacter}
            size="xs"
            type="button"
            variant="ghost"
          >
            {copy.contextView.discard}
          </Button>
          <Button
            disabled={!state.dirty || busy}
            onClick={() =>
              void (project ? model.saveProject() : model.saveCharacter())
            }
            size="xs"
            type="button"
            variant="secondary"
          >
            {busy
              ? copy.contextView.saving
              : project
                ? copy.contextView.saveProject
                : copy.contextView.saveCharacter}
          </Button>
        </div>
      </div>
    </section>
  )
}
