import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react"
import {
  ArrowLeftIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  CircleAlertIcon,
  FolderPlusIcon,
  RefreshCwIcon,
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
import { Skeleton } from "@/components/ui/skeleton"
import {
  IsolatedCharacterPreview,
  type IsolatedCharacterPreviewPhase,
} from "@/features/character/import-preview/IsolatedCharacterPreview"
import type { CharacterPreviewSuccessMessage } from "@/features/character/import-preview/preview-protocol"
import {
  characterLibraryScopeId,
  type CharacterPackView,
} from "@/features/character/library/contracts"
import {
  useCharacterLibrary,
  useCharacterLibraryStore,
} from "@/features/character/library/provider"
import {
  getCharacterModelLibraryCopy,
  type CharacterModelLibraryCopy,
} from "@/features/character/library/model-library-copy"
import { SemanticMappingSettings } from "@/features/character/library/SemanticMappingSettings"
import { useI18n } from "@/features/localization"

export interface CharacterModelLibrarySettingsProps {
  readonly workspaceId?: string
  readonly onDetailPackChange?: (pack: CharacterPackView | null) => void
  readonly renderCharacterContext?: (pack: CharacterPackView) => ReactNode
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

function operationErrorMessage(
  errorCode: string,
  copy: CharacterModelLibraryCopy,
): string {
  const normalized = errorCode.toUpperCase()
  if (normalized === "CHARACTER-MODEL3-SELECTION") {
    return copy.errorMessages.selection
  }
  if (
    /(?:ASSET|MOC|TEXTURE)-(?:MISSING|OPEN|READ|METADATA)/u.test(normalized) ||
    normalized === "CHARACTER-SOURCE-UNREADABLE"
  ) {
    return copy.errorMessages.missingAssets
  }
  if (
    /(?:MODEL3|MOC|MOTION|EXPRESSION|JSON)-(?:SCHEMA|VERSION|INVALID|UNSUPPORTED)/u.test(
      normalized,
    )
  ) {
    return copy.errorMessages.unsupported
  }
  if (
    /(?:TRAVERSAL|REFERENCE|UNKNOWN-REFERENCE|SYMLINK|HARDLINK|NONREGULAR|EXECUTABLE)/u.test(
      normalized,
    )
  ) {
    return copy.errorMessages.unsafe
  }
  if (/(?:LIMIT|DIMENSIONS)/u.test(normalized)) {
    return copy.errorMessages.limits
  }
  if (/(?:PREVIEW|ATTESTATION|PNG-DECODE|TRUSTED-FRAME)/u.test(normalized)) {
    return copy.errorMessages.preview
  }
  if (
    /(?:QUARANTINE|ATOMIC|STORAGE|LIBRARY|DIRECTORY|PERMISSION|REMOVE|SOURCE-CHANGED)/u.test(
      normalized,
    )
  ) {
    return copy.errorMessages.access
  }
  return copy.errorMessages.generic
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

function CharacterModelLibrarySession({
  onDetailPackChange,
  renderCharacterContext,
  workspaceId,
}: {
  readonly onDetailPackChange:
    | ((pack: CharacterPackView | null) => void)
    | undefined
  readonly renderCharacterContext:
    | ((pack: CharacterPackView) => ReactNode)
    | undefined
  workspaceId: string
}) {
  const { locale } = useI18n()
  const copy = getCharacterModelLibraryCopy(locale)
  const library = useCharacterLibrary(workspaceId)
  const store = useCharacterLibraryStore()
  const displayNameId = useId()
  const importTriggerRef = useRef<HTMLButtonElement>(null)
  const [importOpen, setImportOpen] = useState(() => library.preview !== null)
  const [previewAttempt, setPreviewAttempt] = useState(0)
  const [previewProgress, setPreviewProgress] = useState(initialPreviewProgress)
  const [previewFailure, setPreviewFailure] = useState<string | null>(null)
  const [attestedRendererNonce, setAttestedRendererNonce] = useState<
    string | null
  >(null)
  const [displayName, setDisplayName] = useState(
    () => library.preview?.manifest.displayName ?? "",
  )
  const [deleteTarget, setDeleteTarget] = useState<CharacterPackView | null>(
    null,
  )
  const [detailPackId, setDetailPackId] = useState<string | null>(null)
  const characterRowRefs = useRef(new Map<string, HTMLButtonElement>())
  const returnFocusPackIdRef = useRef<string | null>(null)

  const snapshot = library.snapshot
  const preview = library.preview
  const detailPack = snapshot?.packs.find(
    (pack) => pack.packId === detailPackId,
  )
  const customPack = snapshot?.packs.find((pack) => pack.kind === "custom")
  const replacingCustom = customPack !== undefined

  useEffect(() => {
    onDetailPackChange?.(detailPack ?? null)
  }, [detailPack, onDetailPackChange])
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

  useEffect(() => store.acquireSession(workspaceId), [store, workspaceId])

  useEffect(() => {
    if (!store.consumeRestoreFocus(workspaceId)) return
    queueMicrotask(() => importTriggerRef.current?.focus())
  }, [store, workspaceId])

  useEffect(() => {
    if (
      detailPackId === null ||
      snapshot === null ||
      detailPack !== undefined
    ) {
      return
    }
    setDetailPackId(null)
  }, [detailPack, detailPackId, snapshot])

  useEffect(() => {
    if (detailPackId !== null || returnFocusPackIdRef.current === null) return
    const originPackId = returnFocusPackIdRef.current
    returnFocusPackIdRef.current = null
    characterRowRefs.current.get(originPackId)?.focus()
  }, [detailPackId])

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
          thumbnailPng: Array.from(new Uint8Array(evidence.thumbnailPng)),
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
      setImportOpen(false)
      setAttestedRendererNonce(null)
      setPreviewFailure(null)
    } catch {
      // Keep the verified dialog open so atomic confirmation can be retried.
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

  const closeDetail = () => {
    if (detailPackId === null) return
    const originPackId = detailPackId
    returnFocusPackIdRef.current = originPackId
    setDetailPackId(null)
  }

  const deletePack = async () => {
    if (deleteTarget === null) return
    try {
      await store.deletePack(workspaceId, deleteTarget.packId)
      setDeleteTarget(null)
      setDetailPackId(null)
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
      {detailPackId === null ? (
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
            ref={importTriggerRef}
            size="xs"
            title={
              store.gateway.kind === "native"
                ? undefined
                : copy.importUnavailable
            }
            type="button"
            variant="secondary"
          >
            <FolderPlusIcon aria-hidden="true" data-icon="inline-start" />
            {library.mutation === "importing"
              ? copy.preparing
              : replacingCustom
                ? copy.replaceModel
                : copy.importModel}
          </Button>
        </div>
      ) : detailPack !== undefined ? (
        <div className="flex min-w-0 flex-col gap-sm">
          <Button
            className="self-start"
            onClick={closeDetail}
            size="xs"
            type="button"
            variant="ghost"
          >
            <ArrowLeftIcon aria-hidden="true" data-icon="inline-start" />
            {copy.backToList}
          </Button>
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-md">
            <div className="flex min-w-0 flex-wrap items-center gap-xs">
              <h3
                className="m-0 truncate text-headline text-text-strong"
                id="character-model-library-title"
              >
                {detailPack.displayName}
              </h3>
              {detailPack.packId === snapshot?.selectedPackId ? (
                <Badge variant="success">{copy.selected}</Badge>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-xs">
              {detailPack.packId !== snapshot?.selectedPackId ? (
                <Button
                  disabled={mutationActive}
                  onClick={() => selectPack(detailPack.packId)}
                  size="xs"
                  type="button"
                >
                  {copy.useCharacter}
                </Button>
              ) : null}
              {detailPack.kind === "custom" ? (
                <Button
                  disabled={mutationActive || !detailPack.deletable}
                  onClick={() => setDeleteTarget(detailPack)}
                  size="xs"
                  type="button"
                  variant="ghost"
                >
                  <Trash2Icon aria-hidden="true" data-icon="inline-start" />
                  {copy.delete}
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {snapshot?.fallbackApplied ? (
        <Alert>
          <RefreshCwIcon aria-hidden="true" />
          <AlertTitle>{copy.fallbackTitle}</AlertTitle>
          <AlertDescription>{copy.fallbackDescription}</AlertDescription>
        </Alert>
      ) : null}

      {library.errorCode !== null ? (
        <Alert>
          <CircleAlertIcon aria-hidden="true" />
          <AlertTitle>{copy.operationFailed}</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-xs">
            <span>{operationErrorMessage(library.errorCode, copy)}</span>
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

      {snapshot !== null && detailPackId === null ? (
        <div className="overflow-hidden rounded-control border border-divider">
          {snapshot.packs.map((pack) => {
            const selected = pack.packId === snapshot.selectedPackId
            return (
              <button
                aria-label={`${copy.openSettings}: ${pack.displayName}${selected ? `, ${copy.selected}` : ""}`}
                className={`flex min-h-14 w-full min-w-0 items-center gap-sm border-b border-divider px-md py-sm text-left transition-colors last:border-b-0 hover:bg-muted/60 focus-visible:z-10 ${selected ? "bg-selected-row" : "bg-surface"}`}
                data-character-pack={pack.packId}
                data-character-pack-selected={selected || undefined}
                disabled={mutationActive}
                key={pack.packId}
                onClick={() => setDetailPackId(pack.packId)}
                ref={(element) => {
                  if (element === null)
                    characterRowRefs.current.delete(pack.packId)
                  else characterRowRefs.current.set(pack.packId, element)
                }}
                type="button"
              >
                <span className="min-w-0 flex-1 truncate text-title text-text-strong">
                  {pack.displayName}
                </span>
                {selected ? (
                  <Badge className="shrink-0" variant="success">
                    {copy.selected}
                  </Badge>
                ) : null}
                <ChevronRightIcon
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted-foreground"
                />
              </button>
            )
          })}
        </div>
      ) : null}

      {library.mutation === "selecting" ? (
        <p
          aria-live="polite"
          className="m-0 text-caption text-muted-foreground"
        >
          {copy.switching}
        </p>
      ) : null}

      {detailPack !== undefined ? (
        <>
          <SemanticMappingSettings
            packId={detailPack.packId}
            workspaceId={workspaceId}
          />
          {renderCharacterContext?.(detailPack)}
        </>
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
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            importTriggerRef.current?.focus()
          }}
          showCloseButton={!importBusy}
        >
          <DialogHeader>
            <DialogTitle>{copy.importTitle}</DialogTitle>
            <DialogDescription>
              {replacingCustom
                ? copy.replaceDescription
                : copy.importDescription}
            </DialogDescription>
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
                  <CircleAlertIcon aria-hidden="true" />
                  <AlertTitle>{copy.previewFailed}</AlertTitle>
                  <AlertDescription className="flex flex-col items-start gap-xs">
                    <span>{operationErrorMessage(previewFailure, copy)}</span>
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
                : replacingCustom
                  ? copy.confirmReplace
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
            <Alert>
              <CircleAlertIcon aria-hidden="true" />
              <AlertTitle>{copy.operationFailed}</AlertTitle>
              <AlertDescription className="flex flex-col items-start gap-xs">
                <span>{operationErrorMessage(library.errorCode, copy)}</span>
                <code className="font-mono text-label text-destructive">
                  {library.errorCode}
                </code>
              </AlertDescription>
            </Alert>
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

export function CharacterModelLibrarySettings(
  props: CharacterModelLibrarySettingsProps,
) {
  return (
    <CharacterModelLibrarySession
      key={characterLibraryScopeId}
      onDetailPackChange={props.onDetailPackChange}
      renderCharacterContext={props.renderCharacterContext}
      workspaceId={characterLibraryScopeId}
    />
  )
}
