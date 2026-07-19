import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { getCharacterCaption } from "@/features/character/copy"
import type {
  CharacterControllerStatus,
  CharacterFrameMetrics,
  CharacterMotionPolicy,
  CharacterPackRef,
  CharacterState,
} from "@/features/character/model"
import type { SemanticCueSelection } from "@/features/character/library/contracts"
import { CharacterController } from "@/features/character/runtime/character-controller"
import { loadTrustedCharacterFrame } from "@/features/character/runtime/character-pack-client"
import type { SupportedLocale } from "@/features/localization"
import { cn } from "@/lib/utils"

export const BUILTIN_HIYORI_MANIFEST_URL =
  "/characters/builtin-hiyori/pack.json"

const initialStatus: CharacterControllerStatus = {
  phase: "idle",
  state: "idle",
  motionPolicy: "animated",
  fallbackLevel: "text_only",
  error: null,
  pack: null,
}

export interface Live2dCharacterProps {
  readonly className?: string
  readonly state: CharacterState
  readonly stateGeneration: number
  readonly semanticCue?: SemanticCueSelection
  readonly motionPolicy?: CharacterMotionPolicy
  readonly locale?: SupportedLocale
  readonly manifestUrl?: string
  readonly packRef?: CharacterPackRef
  readonly reloadToken?: string | number
  readonly preserveDrawingBuffer?: boolean
  readonly showCaption?: boolean
  readonly onControllerChange?: (controller: CharacterController | null) => void
  readonly onStatusChange?: (status: CharacterControllerStatus) => void
  readonly onMetricsChange?: (metrics: CharacterFrameMetrics) => void
  readonly onStaticPreviewChange?: (dataUrl: string) => void
}

interface CallbackProps {
  readonly onControllerChange?: Live2dCharacterProps["onControllerChange"]
  readonly onStatusChange?: Live2dCharacterProps["onStatusChange"]
  readonly onMetricsChange?: Live2dCharacterProps["onMetricsChange"]
  readonly onStaticPreviewChange?: Live2dCharacterProps["onStaticPreviewChange"]
}

function pngDataUrl(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768))
  }
  return `data:image/png;base64,${btoa(binary)}`
}

export function Live2dCharacter({
  className,
  state,
  stateGeneration,
  semanticCue = { kind: "neutral" },
  motionPolicy = "animated",
  locale = "ja",
  manifestUrl = BUILTIN_HIYORI_MANIFEST_URL,
  packRef,
  reloadToken = 0,
  preserveDrawingBuffer = false,
  showCaption = true,
  onControllerChange,
  onStatusChange,
  onMetricsChange,
  onStaticPreviewChange,
}: Live2dCharacterProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const controllerRef = useRef<CharacterController | null>(null)
  const callbackPropsRef = useRef<CallbackProps>({})
  const committedPackIdRef = useRef<string | null>(null)
  const pendingTrustedPreviewRef = useRef<Readonly<{
    packId: string
    dataUrl: string
  }> | null>(null)
  const initialPresentationRef = useRef({
    state,
    stateGeneration,
    motionPolicy,
    semanticCue,
  })
  const [status, setStatus] = useState<CharacterControllerStatus>(() => ({
    ...initialStatus,
    state,
    motionPolicy,
  }))
  const [staticPreview, setStaticPreview] = useState<string | null>(null)
  const [mountedController, setMountedController] =
    useState<CharacterController | null>(null)
  const activePackRef = useMemo<CharacterPackRef>(
    () => packRef ?? { kind: "url", manifestUrl },
    [manifestUrl, packRef],
  )

  const updateStaticPreview = useCallback((dataUrl: string) => {
    setStaticPreview(dataUrl)
    callbackPropsRef.current.onStaticPreviewChange?.(dataUrl)
  }, [])

  useEffect(() => {
    callbackPropsRef.current = {
      onControllerChange,
      onStatusChange,
      onMetricsChange,
      onStaticPreviewChange,
    }
  }, [
    onControllerChange,
    onMetricsChange,
    onStaticPreviewChange,
    onStatusChange,
  ])

  useEffect(() => {
    const canvas = canvasRef.current
    const host = hostRef.current
    if (canvas === null || host === null) return

    const controller = new CharacterController({
      preserveDrawingBuffer,
      callbacks: {
        onStatus: (nextStatus) => {
          const pending = pendingTrustedPreviewRef.current
          if (nextStatus.phase === "ready" && nextStatus.pack !== null) {
            committedPackIdRef.current = nextStatus.pack.packId
            if (pending?.packId === nextStatus.pack.packId) {
              pendingTrustedPreviewRef.current = null
              updateStaticPreview(pending.dataUrl)
            }
          }
          setStatus(nextStatus)
          callbackPropsRef.current.onStatusChange?.(nextStatus)
        },
        onMetrics: (metrics) => {
          host.dataset.characterFrameCount = String(metrics.frameCount)
          host.dataset.characterNonTransparentSamples = String(
            metrics.nonTransparentSamples,
          )
          host.dataset.characterSignature = metrics.signature
          host.dataset.characterSignatureChanges = String(
            metrics.signatureChanges,
          )
          host.dataset.characterBackingWidth = String(metrics.backingWidth)
          host.dataset.characterBackingHeight = String(metrics.backingHeight)
          host.dataset.characterLastDeltaMilliseconds = String(
            metrics.lastDeltaMilliseconds,
          )
          host.dataset.characterWebglError = String(metrics.webglError)
          host.dataset.characterParameterCount = String(
            metrics.modelInventory?.parameterCount ?? 0,
          )
          host.dataset.characterPartCount = String(
            metrics.modelInventory?.partCount ?? 0,
          )
          host.dataset.characterDrawableCount = String(
            metrics.modelInventory?.drawableCount ?? 0,
          )
          host.dataset.characterTextureDecodeCount = String(
            metrics.modelInventory?.textureDecodeCount ?? 0,
          )
          callbackPropsRef.current.onMetricsChange?.(metrics)
        },
        onStaticPreview: (dataUrl) => {
          updateStaticPreview(dataUrl)
        },
      },
    })
    controllerRef.current = controller
    callbackPropsRef.current.onControllerChange?.(controller)
    controller.setState(
      initialPresentationRef.current.state,
      initialPresentationRef.current.stateGeneration,
    )
    controller.setMotionPolicy(initialPresentationRef.current.motionPolicy)
    controller.setSemanticCue(initialPresentationRef.current.semanticCue)

    const mediaQuery =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null
    const syncReducedMotion = () => {
      controller.setSystemPrefersReducedMotion(mediaQuery?.matches ?? false)
    }
    syncReducedMotion()
    mediaQuery?.addEventListener("change", syncReducedMotion)

    const syncDocumentVisibility = () => {
      controller.syncDocumentVisibility()
    }
    const syncSize = () => {
      syncDocumentVisibility()
      const bounds = host.getBoundingClientRect()
      controller.resize(bounds.width, bounds.height, window.devicePixelRatio)
    }
    let resizeObserver: ResizeObserver | null = null
    if (typeof ResizeObserver === "function") {
      resizeObserver = new ResizeObserver(syncSize)
      resizeObserver.observe(host)
    }
    window.addEventListener("resize", syncSize)
    window.addEventListener("focus", syncDocumentVisibility)
    window.addEventListener("pageshow", syncDocumentVisibility)

    let active = true
    void controller.mount(canvas).then(
      () => {
        if (!active) return
        syncSize()
        setMountedController(controller)
      },
      () => {
        // CharacterController emits a localized, non-blocking fallback status.
      },
    )

    return () => {
      active = false
      resizeObserver?.disconnect()
      window.removeEventListener("resize", syncSize)
      window.removeEventListener("focus", syncDocumentVisibility)
      window.removeEventListener("pageshow", syncDocumentVisibility)
      mediaQuery?.removeEventListener("change", syncReducedMotion)
      controller.dispose()
      setMountedController((current) =>
        current === controller ? null : current,
      )
      if (controllerRef.current === controller) controllerRef.current = null
      callbackPropsRef.current.onControllerChange?.(null)
    }
  }, [preserveDrawingBuffer, updateStaticPreview])

  useEffect(() => {
    controllerRef.current?.setSemanticCue(semanticCue)
  }, [semanticCue])

  useEffect(() => {
    if (mountedController === null) return
    const loadController = new AbortController()
    void (async () => {
      let trustedPreview: string | null = null
      try {
        const bytes = await loadTrustedCharacterFrame(
          activePackRef,
          loadController.signal,
        )
        if (bytes !== null) trustedPreview = pngDataUrl(bytes)
      } catch {
        // The normal pack load will apply the same native integrity boundary.
      }
      if (loadController.signal.aborted) return
      const candidatePackId =
        activePackRef.kind === "native" ? activePackRef.manifest.packId : null
      pendingTrustedPreviewRef.current =
        trustedPreview === null || candidatePackId === null
          ? null
          : { packId: candidatePackId, dataUrl: trustedPreview }
      if (committedPackIdRef.current === null && trustedPreview !== null) {
        updateStaticPreview(trustedPreview)
      }
      try {
        await mountedController.loadPack(
          activePackRef,
          loadController.signal,
          trustedPreview !== null,
        )
      } catch {
        if (
          committedPackIdRef.current !== null &&
          pendingTrustedPreviewRef.current?.packId === candidatePackId
        ) {
          pendingTrustedPreviewRef.current = null
        }
        // CharacterController emits a localized, non-blocking fallback status.
      }
    })()
    return () => loadController.abort()
  }, [activePackRef, mountedController, reloadToken, updateStaticPreview])

  useEffect(() => {
    controllerRef.current?.setState(state, stateGeneration)
  }, [state, stateGeneration])

  useEffect(() => {
    controllerRef.current?.setMotionPolicy(motionPolicy)
  }, [motionPolicy])

  const reducedPresentation = status.motionPolicy === "reduced"
  const showStaticPreview =
    staticPreview !== null &&
    (reducedPresentation || status.fallbackLevel === "static")
  const hideCanvas =
    status.motionPolicy === "hidden" || reducedPresentation || showStaticPreview
  const caption = useMemo(
    () =>
      getCharacterCaption(
        locale,
        reducedPresentation
          ? {
              ...status,
              fallbackLevel: showStaticPreview ? "static" : "text_only",
            }
          : status,
      ),
    [locale, reducedPresentation, showStaticPreview, status],
  )

  return (
    <div
      className={cn(
        "relative isolate size-full min-h-0 overflow-hidden bg-app-bg",
        className,
      )}
      data-character-fallback={status.fallbackLevel}
      data-character-phase={status.phase}
      data-character-policy={status.motionPolicy}
      data-character-reduced-presentation={
        reducedPresentation
          ? showStaticPreview
            ? "static"
            : "text_only"
          : undefined
      }
      data-character-state={status.state}
      ref={hostRef}
    >
      {showStaticPreview ? (
        <img
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 size-full object-contain object-bottom"
          data-character-static-preview="trusted-frame"
          src={staticPreview}
        />
      ) : null}

      <canvas
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-0 size-full",
          hideCanvas ? "opacity-0" : "opacity-100",
        )}
        data-character-canvas="live2d"
        hidden={hideCanvas}
        ref={canvasRef}
      />

      {showCaption ? (
        <div
          aria-live="polite"
          className="pointer-events-none absolute inset-x-xl bottom-lg z-10 max-w-80"
          role="status"
        >
          <p className="m-0 text-caption font-medium text-foreground">
            {caption.state}
          </p>
          {caption.detail !== null ? (
            <p className="mt-xxs mb-0 text-caption text-muted-foreground">
              {caption.detail}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
