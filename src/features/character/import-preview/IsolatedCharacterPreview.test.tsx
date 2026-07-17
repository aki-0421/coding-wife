import { act, fireEvent, render, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import fixture from "@/test/fixtures/character-library.v1.json"
import type { CharacterPackRef } from "@/features/character/model"
import { parseCharacterImportResponse } from "@/features/character/library/contracts"
import { IsolatedCharacterPreview } from "@/features/character/import-preview/IsolatedCharacterPreview"
import {
  characterPreviewProtocol,
  createCharacterPreviewSuccessMessage,
  type CharacterPreviewLoadMessage,
} from "@/features/character/import-preview/preview-protocol"
import { parseCharacterPackManifest } from "@/features/character/runtime/character-pack-client"

const materializeMock = vi.hoisted(() => vi.fn())

vi.mock(
  "@/features/character/runtime/character-pack-client",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/features/character/runtime/character-pack-client")
    >()),
    materializeCharacterPack: materializeMock,
  }),
)

const preview = parseCharacterImportResponse(fixture.importResponse).preview!
const packRef: CharacterPackRef = {
  kind: "native",
  manifest: preview.manifest,
  manifestHash: preview.manifestHash,
  previewToken: preview.previewToken,
  readAsset: vi.fn(),
}

function materializedPack() {
  const manifest = parseCharacterPackManifest(preview.manifest)
  return {
    manifest,
    assets: new Map(
      manifest.files.map((file) => [file.assetId, new ArrayBuffer(file.bytes)]),
    ),
  }
}

function childMessage(
  iframe: HTMLIFrameElement,
  data: unknown,
  origin = "null",
) {
  window.dispatchEvent(
    new MessageEvent("message", {
      data,
      origin,
      source: iframe.contentWindow,
    }),
  )
}

beforeEach(() => {
  materializeMock.mockReset()
  materializeMock.mockResolvedValue(materializedPack())
})

afterEach(() => {
  vi.useRealTimers()
})

describe("IsolatedCharacterPreview", () => {
  it("sends assets only after a null-origin child handshake", async () => {
    const onEvidence = vi.fn()
    const onFailure = vi.fn()
    const { container } = render(
      <IsolatedCharacterPreview
        onEvidence={onEvidence}
        onFailure={onFailure}
        packRef={packRef}
        preview={preview}
      />,
    )
    const iframe = container.querySelector("iframe")!
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage")

    await waitFor(() => expect(materializeMock).toHaveBeenCalledOnce())
    childMessage(
      iframe,
      {
        protocol: characterPreviewProtocol,
        type: "ready",
      },
      "https://attacker.test",
    )
    expect(postMessage).not.toHaveBeenCalled()

    childMessage(iframe, {
      protocol: characterPreviewProtocol,
      type: "ready",
    })
    await waitFor(() => expect(postMessage).toHaveBeenCalledOnce())
    const message = postMessage.mock.calls[0]![0] as CharacterPreviewLoadMessage
    expect(message).toMatchObject({
      protocol: characterPreviewProtocol,
      type: "load",
      previewNonce: preview.previewNonce,
      generation: preview.generation,
    })
    expect(message).not.toHaveProperty("previewToken")
    expect(postMessage.mock.calls[0]![1]).toBe("*")
    const postCall = postMessage.mock.calls[0] as unknown as [
      CharacterPreviewLoadMessage,
      string,
      readonly ArrayBuffer[],
    ]
    expect(postCall[2]).toHaveLength(preview.manifest.files.length)
  })

  it("accepts one matching result and ignores stale or wrong-origin evidence", async () => {
    const onEvidence = vi.fn()
    const onFailure = vi.fn()
    const { container } = render(
      <IsolatedCharacterPreview
        onEvidence={onEvidence}
        onFailure={onFailure}
        packRef={packRef}
        preview={preview}
      />,
    )
    const iframe = container.querySelector("iframe")!
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage")
    childMessage(iframe, {
      protocol: characterPreviewProtocol,
      type: "ready",
    })
    await waitFor(() => expect(postMessage).toHaveBeenCalledOnce())
    const load = postMessage.mock.calls[0]![0] as CharacterPreviewLoadMessage
    const success = createCharacterPreviewSuccessMessage(
      {
        channelNonce: load.channelNonce,
        previewNonce: preview.previewNonce,
        generation: preview.generation,
        rendererNonce: fixture.attestationRequest.rendererNonce,
      },
      {
        frameCount: 1,
        nonTransparentSamples: 16,
        signature: "deadbeef",
        signatureChanges: 0,
        backingWidth: 640,
        backingHeight: 640,
        lastDeltaMilliseconds: 0,
        webglError: 0,
        modelInventory: {
          parameterCount: 70,
          partCount: 24,
          drawableCount: 134,
          textureDecodeCount: 1,
        },
      },
      true,
      "e".repeat(64),
    )

    childMessage(iframe, { ...success, generation: success.generation + 1 })
    childMessage(iframe, success, "https://attacker.test")
    expect(onEvidence).not.toHaveBeenCalled()
    childMessage(iframe, success)
    childMessage(iframe, success)
    expect(onEvidence).toHaveBeenCalledOnce()
    expect(onFailure).not.toHaveBeenCalled()
  })

  it("aborts asset loading on cancellation", () => {
    const observed: { signal?: AbortSignal } = {}
    materializeMock.mockImplementation(
      (_pack: CharacterPackRef, signal: AbortSignal) => {
        observed.signal = signal
        return new Promise(() => undefined)
      },
    )
    const { unmount } = render(
      <IsolatedCharacterPreview
        onEvidence={vi.fn()}
        onFailure={vi.fn()}
        packRef={packRef}
        preview={preview}
      />,
    )
    expect(observed.signal?.aborted).toBe(false)
    unmount()
    expect(observed.signal?.aborted).toBe(true)
  })

  it("fails closed on renderer timeout and iframe reload", async () => {
    vi.useFakeTimers()
    const onFailure = vi.fn()
    const { container } = render(
      <IsolatedCharacterPreview
        onEvidence={vi.fn()}
        onFailure={onFailure}
        packRef={packRef}
        preview={preview}
      />,
    )
    const iframe = container.querySelector("iframe")!
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage")
    fireEvent.load(iframe)
    childMessage(iframe, {
      protocol: characterPreviewProtocol,
      type: "ready",
    })
    await act(async () => Promise.resolve())
    expect(postMessage).toHaveBeenCalledOnce()
    fireEvent.load(iframe)
    expect(onFailure).toHaveBeenCalledWith("context_restore_failed")

    onFailure.mockClear()
    const timeoutView = render(
      <IsolatedCharacterPreview
        onEvidence={vi.fn()}
        onFailure={onFailure}
        packRef={packRef}
        preview={{ ...preview, previewToken: crypto.randomUUID() }}
      />,
    )
    const timeoutFrame = timeoutView.container.querySelector("iframe")!
    vi.spyOn(timeoutFrame.contentWindow!, "postMessage")
    childMessage(timeoutFrame, {
      protocol: characterPreviewProtocol,
      type: "ready",
    })
    await act(async () => Promise.resolve())
    await act(async () => vi.advanceTimersByTimeAsync(15_000))
    expect(onFailure).toHaveBeenCalledWith("shader_load_failed")
  })
})
