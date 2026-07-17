import {
  useCallback,
  useId,
  useMemo,
  useState,
  type CSSProperties,
} from "react"
import {
  CheckCircle2Icon,
  FolderPlusIcon,
  PackageIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Skeleton } from "@/components/ui/skeleton"
import {
  IsolatedCharacterPreview,
  type IsolatedCharacterPreviewPhase,
} from "@/features/character/import-preview/IsolatedCharacterPreview"
import type { CharacterPreviewSuccessMessage } from "@/features/character/import-preview/preview-protocol"
import type { CharacterPackView } from "@/features/character/library/contracts"
import {
  useCharacterLibrary,
  useCharacterLibraryStore,
} from "@/features/character/library/provider"
import {
  getCharacterModelLibraryCopy,
  type CharacterModelLibraryCopy,
} from "@/features/character/library/model-library-copy"
import { useI18n, type SupportedLocale } from "@/features/localization"
import { cn } from "@/lib/utils"

export interface CharacterModelLibrarySettingsProps {
  readonly workspaceId: string
}

interface PreviewProgress {
  readonly completed: number
  readonly total: number
  readonly phase: IsolatedCharacterPreviewPhase
}

const initialPreviewProgress: PreviewProgress = {
  completed: 0,
  total: 0,
  phase: "loading_assets",
}

function characterLength(value: string): number {
  return [...value].length
}

function formatBytes(value: number, locale: SupportedLocale): string {
  if (value < 1024) return `${String(value)} B`
  const units = ["KB", "MB", "GB"] as const
  let size = value / 1024
  let unit: (typeof units)[number] = units[0]
  for (const candidate of units.slice(1)) {
    if (size < 1024) break
    size /= 1024
    unit = candidate
  }
  return `${new Intl.NumberFormat(locale, {
    maximumFractionDigits: size >= 10 ? 0 : 1,
  }).format(size)} ${unit}`
}

function formatImportedAt(value: string, locale: SupportedLocale): string {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return value
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
  }).format(date)
}

function replaceCount(template: string, count: number): string {
  return template.replace("{count}", String(count))
}

function replaceDate(template: string, date: string): string {
  return template.replace("{date}", date)
}

function phaseLabel(
  phase: IsolatedCharacterPreviewPhase,
  copy: CharacterModelLibraryCopy,
): string {
  switch (phase) {
    case "loading_assets":
      return copy.preparing
    case "starting_renderer":
      return copy.starting
    case "rendering":
      return copy.rendering
    case "verified":
      return copy.verified
    case "error":
      return copy.previewFailed
  }
}

function ModelCard({
  copy,
  disabled,
  locale,
  pack,
  selected,
  onRequestDelete,
}: {
  readonly copy: CharacterModelLibraryCopy
  readonly disabled: boolean
  readonly locale: SupportedLocale
  readonly pack: CharacterPackView
  readonly selected: boolean
  readonly onRequestDelete: (pack: CharacterPackView) => void
}) {
  const inputId = `character-pack-${pack.packId}`
  const detailId = `${inputId}-details`
  return (
    <div
      className={cn(
        "grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-md rounded-control border border-divider bg-surface px-md py-md transition-colors",
        selected && "border-primary/60 bg-selected-row",
      )}
      data-character-pack={pack.packId}
      data-character-pack-selected={selected || undefined}
    >
      <RadioGroupItem
        aria-describedby={detailId}
        className="mt-xxs"
        disabled={disabled}
        id={inputId}
        value={pack.packId}
      />
      <label className="min-w-0 cursor-pointer" htmlFor={inputId}>
        <span className="flex min-w-0 flex-wrap items-center gap-xs">
          <span className="truncate text-title text-text-strong">
            {pack.displayName}
          </span>
          {selected ? <Badge variant="success">{copy.selected}</Badge> : null}
          <Badge variant="outline">
            {pack.kind === "builtin" ? copy.bundled : copy.imported}
          </Badge>
        </span>
        <span
          className="mt-xs flex min-w-0 flex-wrap gap-x-md gap-y-xxs text-label text-muted-foreground"
          id={detailId}
        >
          <span>{formatBytes(pack.totalBytes, locale)}</span>
          <span>
            {pack.textureCount} {copy.textures}
          </span>
          <span>
            {pack.motionCount} {copy.motions}
          </span>
          {pack.expressionCount > 0 ? (
            <span>
              {pack.expressionCount} {copy.expressions}
            </span>
          ) : null}
          <span>
            {pack.runtimeFileCount} {copy.files}
          </span>
        </span>
        <span className="mt-xs block truncate text-label text-muted-foreground">
          {pack.provenanceLabel}
        </span>
        {pack.importedAt !== null ? (
          <span className="mt-xxs block text-label text-muted-foreground">
            {replaceDate(
              copy.importedAt,
              formatImportedAt(pack.importedAt, locale),
            )}
          </span>
        ) : null}
        {pack.kind === "custom" && pack.selectedWorkspaceCount > 0 ? (
          <span className="mt-xxs block text-label text-muted-foreground">
            {replaceCount(copy.usedByWorkspaces, pack.selectedWorkspaceCount)}
          </span>
        ) : null}
      </label>
      {pack.kind === "custom" ? (
        <Button
          aria-label={`${copy.delete}: ${pack.displayName}`}
          disabled={disabled || !pack.deletable}
          onClick={() => onRequestDelete(pack)}
          size="xs"
          type="button"
          variant="ghost"
        >
          <Trash2Icon aria-hidden="true" />
          {copy.delete}
        </Button>
      ) : (
        <PackageIcon
          aria-hidden="true"
          className="mt-xxs size-4 text-muted-foreground"
        />
      )}
    </div>
  )
}

function CharacterModelLibrarySession({
  workspaceId,
}: {
  workspaceId: string
}) {
  const { locale } = useI18n()
  const copy = getCharacterModelLibraryCopy(locale)
  const library = useCharacterLibrary(workspaceId)
  const store = useCharacterLibraryStore()
  const displayNameId = useId()
  const [importOpen, setImportOpen] = useState(false)
  const [previewAttempt, setPreviewAttempt] = useState(0)
  const [previewProgress, setPreviewProgress] = useState(initialPreviewProgress)
  const [previewFailure, setPreviewFailure] = useState<string | null>(null)
  const [attestedRendererNonce, setAttestedRendererNonce] = useState<
    string | null
  >(null)
  const [displayName, setDisplayName] = useState("")
  const [deleteTarget, setDeleteTarget] = useState<CharacterPackView | null>(
    null,
  )

  const snapshot = library.snapshot
  const preview = library.preview
  const previewPackRef = useMemo(
    () => (preview === null ? null : store.previewPackRef(workspaceId)),
    [preview, store, workspaceId],
  )
  const trimmedDisplayName = displayName.trim()
  const displayNameValid =
    characterLength(trimmedDisplayName) >= 1 &&
    characterLength(trimmedDisplayName) <= 80
  const mutationActive = library.mutation !== null
  const importBusy =
    library.mutation === "importing" ||
    library.mutation === "attesting" ||
    library.mutation === "confirming" ||
    library.mutation === "canceling"
  const previewPercent =
    previewProgress.total > 0
      ? Math.min(
          100,
          Math.round((previewProgress.completed / previewProgress.total) * 100),
        )
      : 0
  const progressStyle = {
    "--character-preview-progress": `${String(previewPercent)}%`,
  } as CSSProperties

  const beginImport = async () => {
    setPreviewFailure(null)
    try {
      const response = await store.beginImport(workspaceId)
      if (response.outcome === "canceled" || response.preview === null) return
      setPreviewAttempt(0)
      setPreviewProgress(initialPreviewProgress)
      setAttestedRendererNonce(null)
      setDisplayName(response.preview.manifest.displayName)
      setImportOpen(true)
    } catch {
      // The store exposes a safe error code without surfacing native details.
    }
  }

  const cancelImport = async () => {
    if (preview === null) {
      setImportOpen(false)
      return
    }
    try {
      await store.cancelImport(workspaceId)
      setImportOpen(false)
      setAttestedRendererNonce(null)
      setPreviewFailure(null)
    } catch {
      // Keep the dialog open so cancellation can be retried.
    }
  }

  const attestPreview = useCallback(
    async (evidence: CharacterPreviewSuccessMessage) => {
      if (preview === null) return
      setPreviewFailure(null)
      try {
        const response = await store.attestPreview(workspaceId, {
          previewToken: preview.previewToken,
          previewNonce: preview.previewNonce,
          rendererNonce: evidence.rendererNonce,
          generation: preview.generation,
          manifestHash: preview.manifestHash,
          frameCount: evidence.frameCount,
          nonTransparentSamples: evidence.nonTransparentSamples,
          signature: evidence.signature,
          textureDecodeCount: evidence.textureDecodeCount,
          stateCueObserved: evidence.stateCueObserved,
          webglError: evidence.webglError,
          parameterCount: evidence.parameterCount,
          partCount: evidence.partCount,
          drawableCount: evidence.drawableCount,
          thumbnailSha256: evidence.thumbnailSha256,
        })
        if (response.rendererNonce !== evidence.rendererNonce) {
          setPreviewFailure("attestation_identity_mismatch")
          setPreviewProgress((current) => ({ ...current, phase: "error" }))
          return
        }
        setAttestedRendererNonce(response.rendererNonce)
        setPreviewProgress((current) => ({ ...current, phase: "verified" }))
      } catch {
        setPreviewFailure("attestation_failed")
        setPreviewProgress((current) => ({ ...current, phase: "error" }))
      }
    },
    [preview, store, workspaceId],
  )

  const confirmImport = async () => {
    if (
      preview === null ||
      attestedRendererNonce === null ||
      !displayNameValid
    ) {
      return
    }
    try {
      await store.confirmImport({
        workspaceId,
        previewToken: preview.previewToken,
        previewNonce: preview.previewNonce,
        rendererNonce: attestedRendererNonce,
        generation: preview.generation,
        manifestHash: preview.manifestHash,
        displayName: trimmedDisplayName,
      })
      await store.selectPack(workspaceId, preview.packId)
      setImportOpen(false)
      setAttestedRendererNonce(null)
      setPreviewFailure(null)
    } catch {
      // The imported pack remains visible if publication succeeded but selection failed.
    }
  }

  const retryPreview = () => {
    setPreviewFailure(null)
    setAttestedRendererNonce(null)
    setPreviewProgress(initialPreviewProgress)
    setPreviewAttempt((attempt) => attempt + 1)
  }

  const selectPack = (packId: string) => {
    if (snapshot === null || packId === snapshot.selectedPackId) return
    void store.selectPack(workspaceId, packId).catch(() => undefined)
  }

  const deletePack = async () => {
    if (deleteTarget === null) return
    try {
      await store.deletePack(workspaceId, deleteTarget.packId)
      setDeleteTarget(null)
    } catch {
      // Keep confirmation open and expose only the normalized store error.
    }
  }

  return (
    <section
      aria-labelledby="character-model-library-title"
      className="flex min-w-0 flex-col gap-md"
      data-character-library={library.status}
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-md">
        <div className="min-w-0 max-w-[62ch]">
          <h3
            className="m-0 text-title text-text-strong"
            id="character-model-library-title"
          >
            {copy.title}
          </h3>
          <p className="m-0 mt-xxs text-caption text-muted-foreground">
            {copy.description}
          </p>
        </div>
        <Button
          disabled={
            mutationActive ||
            preview !== null ||
            store.gateway.kind !== "native"
          }
          onClick={() => void beginImport()}
          size="xs"
          type="button"
          variant="secondary"
        >
          <FolderPlusIcon aria-hidden="true" />
          {library.mutation === "importing" ? copy.preparing : copy.importModel}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-xs text-label text-muted-foreground">
        <ShieldCheckIcon aria-hidden="true" className="size-3" />
        <span>{copy.privateLibrary}</span>
        {store.gateway.kind !== "native" ? (
          <span>· {copy.importUnavailable}</span>
        ) : null}
      </div>

      {snapshot?.fallbackApplied ? (
        <Alert>
          <RefreshCwIcon aria-hidden="true" />
          <AlertTitle>{copy.fallbackTitle}</AlertTitle>
          <AlertDescription>{copy.fallbackDescription}</AlertDescription>
        </Alert>
      ) : null}

      {library.errorCode !== null ? (
        <Alert>
          <AlertTitle>{copy.operationFailed}</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-xs">
            <code className="font-mono text-label text-destructive">
              {library.errorCode}
            </code>
            {library.status === "error" ? (
              <Button
                onClick={() =>
                  void store.load(workspaceId).catch(() => undefined)
                }
                size="xs"
                type="button"
                variant="secondary"
              >
                {copy.retry}
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      {snapshot === null && library.status !== "error" ? (
        <div
          aria-label={copy.loading}
          className="flex flex-col gap-xs"
          role="status"
        >
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : null}

      {snapshot !== null ? (
        <RadioGroup
          aria-label={copy.selectModel}
          disabled={mutationActive}
          onValueChange={selectPack}
          value={snapshot.selectedPackId}
        >
          {snapshot.packs.map((pack) => (
            <ModelCard
              copy={copy}
              disabled={mutationActive}
              key={pack.packId}
              locale={locale}
              onRequestDelete={setDeleteTarget}
              pack={pack}
              selected={pack.packId === snapshot.selectedPackId}
            />
          ))}
        </RadioGroup>
      ) : null}

      {library.mutation === "selecting" ? (
        <p
          aria-live="polite"
          className="m-0 text-caption text-muted-foreground"
        >
          {copy.switching}
        </p>
      ) : null}

      <Dialog
        onOpenChange={(open) => {
          if (open) {
            setImportOpen(true)
          } else if (!importBusy) {
            void cancelImport()
          }
        }}
        open={importOpen && preview !== null}
      >
        <DialogContent
          className="w-[min(52rem,calc(100dvw-36px))]"
          showCloseButton={!importBusy}
        >
          <DialogHeader>
            <DialogTitle>{copy.importTitle}</DialogTitle>
            <DialogDescription>{copy.importDescription}</DialogDescription>
          </DialogHeader>

          {preview !== null && previewPackRef !== null ? (
            <>
              <div className="overflow-hidden rounded-control border border-divider bg-app-bg">
                <div className="flex items-center justify-between gap-md border-b border-divider px-md py-xs text-label text-muted-foreground">
                  <span>{copy.previewLabel}</span>
                  {attestedRendererNonce !== null ? (
                    <Badge variant="success">
                      <CheckCircle2Icon aria-hidden="true" />
                      {copy.verified}
                    </Badge>
                  ) : null}
                </div>
                <div className="aspect-video min-h-48 w-full">
                  <IsolatedCharacterPreview
                    key={`${preview.previewToken}:${String(previewAttempt)}`}
                    onEvidence={(evidence) => void attestPreview(evidence)}
                    onFailure={(errorCode) => {
                      setPreviewFailure(errorCode)
                      setPreviewProgress((current) => ({
                        ...current,
                        phase: "error",
                      }))
                    }}
                    onProgress={(completed, total, phase) => {
                      setPreviewProgress({ completed, total, phase })
                    }}
                    packRef={previewPackRef}
                    preview={preview}
                  />
                </div>
              </div>

              <div
                aria-live="polite"
                className="flex min-w-0 items-center gap-sm"
                style={progressStyle}
              >
                <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-circle bg-muted">
                  <div
                    className="h-full w-(--character-preview-progress) bg-primary transition-[width]"
                    role="progressbar"
                    aria-label={phaseLabel(previewProgress.phase, copy)}
                    aria-valuemax={100}
                    aria-valuemin={0}
                    aria-valuenow={previewPercent}
                  />
                </div>
                <span className="shrink-0 text-label text-muted-foreground">
                  {phaseLabel(previewProgress.phase, copy)}
                </span>
              </div>

              {previewFailure !== null ? (
                <Alert>
                  <AlertTitle>{copy.previewFailed}</AlertTitle>
                  <AlertDescription className="flex flex-wrap items-center gap-xs">
                    <code className="font-mono text-label text-destructive">
                      {previewFailure}
                    </code>
                    <Button
                      disabled={importBusy}
                      onClick={retryPreview}
                      size="xs"
                      type="button"
                      variant="secondary"
                    >
                      {copy.retryPreview}
                    </Button>
                  </AlertDescription>
                </Alert>
              ) : null}

              <Field>
                <FieldLabel htmlFor={displayNameId}>
                  {copy.displayName}
                </FieldLabel>
                <Input
                  aria-invalid={displayName.length > 0 && !displayNameValid}
                  disabled={importBusy}
                  id={displayNameId}
                  onChange={(event) =>
                    setDisplayName(event.currentTarget.value)
                  }
                  value={displayName}
                />
                <FieldDescription>
                  {copy.displayNameDescription}
                </FieldDescription>
              </Field>
            </>
          ) : null}

          <DialogFooter>
            <Button
              disabled={importBusy}
              onClick={() => void cancelImport()}
              type="button"
              variant="outline"
            >
              {library.mutation === "canceling" ? copy.canceling : copy.cancel}
            </Button>
            <Button
              disabled={
                importBusy ||
                attestedRendererNonce === null ||
                !displayNameValid
              }
              onClick={() => void confirmImport()}
              type="button"
            >
              {library.mutation === "confirming"
                ? copy.confirming
                : copy.confirmImport}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        onOpenChange={(open) => {
          if (!open && library.mutation !== "deleting") setDeleteTarget(null)
        }}
        open={deleteTarget !== null}
      >
        <DialogContent showCloseButton={library.mutation !== "deleting"}>
          <DialogHeader>
            <DialogTitle>{copy.deleteTitle}</DialogTitle>
            <DialogDescription>
              {deleteTarget === null
                ? copy.deleteDescription
                : `${deleteTarget.displayName} — ${copy.deleteDescription}`}
            </DialogDescription>
          </DialogHeader>
          {library.errorCode !== null ? (
            <code className="font-mono text-label text-destructive">
              {library.errorCode}
            </code>
          ) : null}
          <DialogFooter>
            <Button
              disabled={library.mutation === "deleting"}
              onClick={() => setDeleteTarget(null)}
              type="button"
              variant="outline"
            >
              {copy.cancel}
            </Button>
            <Button
              disabled={library.mutation === "deleting"}
              onClick={() => void deletePack()}
              type="button"
              variant="destructive"
            >
              {library.mutation === "deleting"
                ? copy.deleting
                : copy.deleteConfirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}

export function CharacterModelLibrarySettings({
  workspaceId,
}: CharacterModelLibrarySettingsProps) {
  return (
    <CharacterModelLibrarySession key={workspaceId} workspaceId={workspaceId} />
  )
}
