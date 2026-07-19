import { useEffect, useRef, useState } from "react"

import type { CharacterPackRef } from "@/features/character/model"
import type { CharacterPreviewSession } from "@/features/character/library/contracts"
import {
  createCharacterPreviewLoadMessage,
  parseCharacterPreviewResultMessage,
  characterPreviewProtocol,
  type CharacterPreviewSuccessMessage,
} from "@/features/character/import-preview/preview-protocol"
import { materializeCharacterPack } from "@/features/character/runtime/character-pack-client"
import { cn } from "@/lib/utils"

export type IsolatedCharacterPreviewPhase =
  | "loading_assets"
  | "starting_renderer"
  | "rendering"
  | "verified"
  | "error"

export interface IsolatedCharacterPreviewProps {
  readonly className?: string
  readonly packRef: CharacterPackRef
  readonly preview: CharacterPreviewSession
  readonly onEvidence: (evidence: CharacterPreviewSuccessMessage) => void
  readonly onFailure: (errorCode: string) => void
  readonly onProgress?: (
    completed: number,
    total: number,
    phase: IsolatedCharacterPreviewPhase,
  ) => void
}

function isReadyMessage(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false
  }
  const message = value as Record<string, unknown>
  return (
    Object.keys(message).length === 2 &&
    message.protocol === characterPreviewProtocol &&
    message.type === "ready"
  )
}

export function IsolatedCharacterPreview({
  className,
  packRef,
  preview,
  onEvidence,
  onFailure,
  onProgress,
}: IsolatedCharacterPreviewProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const iframeLoadCountRef = useRef(0)
  const sentRef = useRef(false)
  const completedRef = useRef(false)
  const callbacksRef = useRef({ onEvidence, onFailure, onProgress })
  const [channelNonce] = useState(() => crypto.randomUUID())
  const [phase, setPhase] =
    useState<IsolatedCharacterPreviewPhase>("loading_assets")
  const [ready, setReady] = useState(false)
  const [materialized, setMaterialized] = useState<Awaited<
    ReturnType<typeof materializeCharacterPack>
  > | null>(null)

  useEffect(() => {
    callbacksRef.current = { onEvidence, onFailure, onProgress }
  }, [onEvidence, onFailure, onProgress])

  useEffect(() => {
    const controller = new AbortController()
    void materializeCharacterPack(
      packRef,
      controller.signal,
      (completed, total) => {
        callbacksRef.current.onProgress?.(completed, total, "loading_assets")
      },
    ).then(
      (pack) => {
        setMaterialized(pack)
        setPhase("starting_renderer")
        callbacksRef.current.onProgress?.(
          pack.manifest.files.length,
          pack.manifest.files.length,
          "starting_renderer",
        )
      },
      () => {
        if (controller.signal.aborted) return
        setPhase("error")
        callbacksRef.current.onFailure("asset_fetch_failed")
      },
    )
    return () => controller.abort()
  }, [packRef, preview.previewToken])

  useEffect(() => {
    const receive = (event: MessageEvent<unknown>) => {
      if (
        event.source !== iframeRef.current?.contentWindow ||
        event.origin !== "null"
      ) {
        return
      }
      if (isReadyMessage(event.data)) {
        setReady(true)
        return
      }
      let result
      try {
        result = parseCharacterPreviewResultMessage(event.data)
      } catch {
        return
      }
      if (
        result.channelNonce !== channelNonce ||
        result.previewNonce !== preview.previewNonce ||
        result.generation !== preview.generation ||
        completedRef.current
      ) {
        return
      }
      completedRef.current = true
      if (result.type === "failure") {
        setPhase("error")
        callbacksRef.current.onFailure(result.errorCode)
        return
      }
      setPhase("verified")
      callbacksRef.current.onEvidence(result)
    }
    window.addEventListener("message", receive)
    return () => window.removeEventListener("message", receive)
  }, [channelNonce, preview.generation, preview.previewNonce])

  useEffect(() => {
    const target = iframeRef.current?.contentWindow
    if (!ready || materialized === null || target == null || sentRef.current) {
      return
    }
    sentRef.current = true
    const message = createCharacterPreviewLoadMessage(
      channelNonce,
      preview.previewNonce,
      preview.generation,
      materialized.manifest,
      materialized.assets,
    )
    const transfers = message.assets.map((asset) => asset.bytes)
    target.postMessage(message, "*", transfers)
    setPhase("rendering")
    callbacksRef.current.onProgress?.(
      materialized.manifest.files.length,
      materialized.manifest.files.length,
      "rendering",
    )
    const timeout = window.setTimeout(() => {
      if (completedRef.current) return
      completedRef.current = true
      setPhase("error")
      callbacksRef.current.onFailure("shader_load_failed")
    }, 15_000)
    return () => window.clearTimeout(timeout)
  }, [
    channelNonce,
    materialized,
    preview.generation,
    preview.previewNonce,
    ready,
  ])

  return (
    <iframe
      className={cn("size-full border-0 bg-background", className)}
      data-character-preview-phase={phase}
      onLoad={() => {
        iframeLoadCountRef.current += 1
        if (iframeLoadCountRef.current === 1 || completedRef.current) return
        completedRef.current = true
        setPhase("error")
        callbacksRef.current.onFailure("context_restore_failed")
      }}
      ref={iframeRef}
      sandbox="allow-scripts"
      src="/character-import-preview.html"
      title={`Isolated preview: ${preview.manifest.displayName}`}
    />
  )
}
