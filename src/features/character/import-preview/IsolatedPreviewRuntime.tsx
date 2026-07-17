import { useEffect, useMemo, useRef, useState } from "react"

import { Live2dCharacter } from "@/features/character/components/Live2dCharacter"
import type {
  CharacterControllerStatus,
  CharacterFrameMetrics,
  CharacterState,
} from "@/features/character/model"
import {
  createCharacterPreviewFailureMessage,
  createCharacterPreviewSuccessMessage,
  parseCharacterPreviewLoadMessage,
  type CharacterPreviewLoadMessage,
} from "@/features/character/import-preview/preview-protocol"
import { computeCharacterSha256 } from "@/features/character/runtime/character-pack-client"

function dataUrlBytes(dataUrl: string): ArrayBuffer {
  const separator = dataUrl.indexOf(",")
  if (separator < 0 || !dataUrl.startsWith("data:image/png;base64,")) {
    throw new Error("texture_decode_failed")
  }
  const decoded = atob(dataUrl.slice(separator + 1))
  const bytes = new Uint8Array(decoded.length)
  for (let index = 0; index < decoded.length; index++) {
    bytes[index] = decoded.charCodeAt(index)
  }
  return bytes.buffer
}

function postFailure(
  payload: CharacterPreviewLoadMessage,
  errorCode: string,
): void {
  parent.postMessage(
    createCharacterPreviewFailureMessage(
      {
        channelNonce: payload.channelNonce,
        previewNonce: payload.previewNonce,
        generation: payload.generation,
      },
      errorCode,
    ),
    "*",
  )
}

export function IsolatedPreviewRuntime() {
  const acceptedRef = useRef(false)
  const reportedRef = useRef(false)
  const [payload, setPayload] = useState<CharacterPreviewLoadMessage | null>(
    null,
  )
  const [state, setState] = useState<CharacterState>("idle")
  const [stateGeneration, setStateGeneration] = useState(1)
  const [stateCueObserved, setStateCueObserved] = useState(false)
  const [metrics, setMetrics] = useState<CharacterFrameMetrics | null>(null)
  const [thumbnailSha256, setThumbnailSha256] = useState<string | null>(null)
  const rendererNonce = useMemo(() => crypto.randomUUID(), [])
  const memoryPackRef = useMemo(() => {
    if (payload === null) return null
    return {
      kind: "memory" as const,
      manifest: payload.manifest,
      assets: new Map(
        payload.assets.map((asset) => [asset.assetId, asset.bytes] as const),
      ),
    }
  }, [payload])

  useEffect(() => {
    const receive = (event: MessageEvent<unknown>) => {
      if (
        event.source !== parent ||
        event.origin !== window.location.origin ||
        acceptedRef.current
      ) {
        return
      }
      try {
        const next = parseCharacterPreviewLoadMessage(event.data)
        acceptedRef.current = true
        setPayload(next)
      } catch {
        // Ignore messages that do not match the one narrow preview protocol.
      }
    }
    window.addEventListener("message", receive)
    parent.postMessage({ protocol: "character-preview-v1", type: "ready" }, "*")
    return () => window.removeEventListener("message", receive)
  }, [])

  useEffect(() => {
    if (
      payload === null ||
      reportedRef.current ||
      metrics === null ||
      metrics.frameCount === 0 ||
      metrics.nonTransparentSamples === 0 ||
      metrics.modelInventory === null ||
      metrics.modelInventory.textureDecodeCount !==
        payload.manifest.inventory.textureCount ||
      metrics.webglError !== 0 ||
      !stateCueObserved ||
      thumbnailSha256 === null
    ) {
      return
    }
    reportedRef.current = true
    parent.postMessage(
      createCharacterPreviewSuccessMessage(
        {
          channelNonce: payload.channelNonce,
          previewNonce: payload.previewNonce,
          generation: payload.generation,
          rendererNonce,
        },
        metrics,
        stateCueObserved,
        thumbnailSha256,
      ),
      "*",
    )
  }, [metrics, payload, rendererNonce, stateCueObserved, thumbnailSha256])

  if (payload === null || memoryPackRef === null) {
    return (
      <div
        aria-label="Preparing isolated Live2D preview"
        className="preview-wait"
      />
    )
  }

  return (
    <Live2dCharacter
      className="preview-character"
      motionPolicy="animated"
      onMetricsChange={setMetrics}
      onStaticPreviewChange={(dataUrl) => {
        void computeCharacterSha256(dataUrlBytes(dataUrl)).then(
          setThumbnailSha256,
          () => postFailure(payload, "texture_decode_failed"),
        )
      }}
      onStatusChange={(status: CharacterControllerStatus) => {
        if (status.phase === "error") {
          if (!reportedRef.current) {
            reportedRef.current = true
            postFailure(payload, status.error?.code ?? "shader_load_failed")
          }
          return
        }
        if (status.phase === "ready" && state === "idle") {
          setState("reviewing")
          setStateGeneration((generation) => generation + 1)
          return
        }
        if (status.phase === "ready" && status.state === "reviewing") {
          setStateCueObserved(true)
        }
      }}
      packRef={memoryPackRef}
      preserveDrawingBuffer
      showCaption={false}
      state={state}
      stateGeneration={stateGeneration}
    />
  )
}
