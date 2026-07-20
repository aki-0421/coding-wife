import { invoke as tauriInvoke } from "@tauri-apps/api/core"

import {
  NarrationContractError,
  narrationCommands,
  narrationSchemaVersion,
  narrationSettingsSchemaVersion,
  openAiTtsVoices,
  parseNarrationCommandError,
  parseNarrationRuntime,
  parseNarrationSettingsSnapshot,
  parseNarrationSpeakResponse,
  parseNarrationVoiceList,
  type NarrationCancelReason,
  type NarrationCommand,
  type NarrationCommandErrorEnvelope,
  type NarrationMuteRequestV1,
  type NarrationRuntimeSnapshotV1,
  type NarrationScopeRequestV1,
  type NarrationSettingsSnapshotV1,
  type NarrationSettingsUpdateV2,
  type NarrationSpeakRequestV1,
  type NarrationSpeakResponseV1,
  type NarrationVoiceListV1,
} from "@/features/narration/contracts"

type Invoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>

export type NarrationGatewayKind = "native" | "demo"

export interface NarrationGateway {
  readonly kind: NarrationGatewayKind
  getSettings(): Promise<NarrationSettingsSnapshotV1>
  getRuntime(): Promise<NarrationRuntimeSnapshotV1>
  listVoices(): Promise<NarrationVoiceListV1>
  updateSettings(
    request: NarrationSettingsUpdateV2,
  ): Promise<NarrationSettingsSnapshotV1>
  setMuted(
    request: NarrationMuteRequestV1,
  ): Promise<NarrationSettingsSnapshotV1>
  resetSettings(expectedVersion: number): Promise<NarrationSettingsSnapshotV1>
  setScope(request: NarrationScopeRequestV1): Promise<void>
  speak(request: NarrationSpeakRequestV1): Promise<NarrationSpeakResponseV1>
  cancel(reason: NarrationCancelReason): Promise<void>
}

export class NarrationBoundaryError
  extends Error
  implements NarrationCommandErrorEnvelope
{
  public readonly code: string
  public readonly operation: string
  public readonly recoverable: boolean
  public readonly userMessageKey: string
  public readonly detailRef: string

  public constructor(error?: NarrationCommandErrorEnvelope) {
    const envelope = error ?? {
      code: "NARRATION-IPC-UNAVAILABLE",
      operation: "narration_ipc",
      recoverable: true,
      userMessageKey: "narration.error.generic",
      detailRef: "narration-v1",
    }
    super(envelope.code)
    this.name = "NarrationBoundaryError"
    this.code = envelope.code
    this.operation = envelope.operation
    this.recoverable = envelope.recoverable
    this.userMessageKey = envelope.userMessageKey
    this.detailRef = envelope.detailRef
  }
}

function normalizeError(error: unknown): NarrationBoundaryError {
  if (error instanceof NarrationBoundaryError) return error
  if (error instanceof NarrationContractError) {
    return new NarrationBoundaryError({
      code: error.code,
      operation: "narration_contract",
      recoverable: false,
      userMessageKey: "narration.error.generic",
      detailRef: "narration-v1",
    })
  }
  return new NarrationBoundaryError(
    parseNarrationCommandError(error) ?? undefined,
  )
}

export class NativeNarrationGateway implements NarrationGateway {
  public readonly kind = "native" as const

  public constructor(private readonly invoke: Invoke = tauriInvoke) {}

  public getSettings(): Promise<NarrationSettingsSnapshotV1> {
    return this.requestWithoutPayload(
      narrationCommands.getSettings,
      parseNarrationSettingsSnapshot,
    )
  }

  public getRuntime(): Promise<NarrationRuntimeSnapshotV1> {
    return this.requestWithoutPayload(
      narrationCommands.getRuntime,
      parseNarrationRuntime,
    )
  }

  public listVoices(): Promise<NarrationVoiceListV1> {
    return this.requestWithoutPayload(
      narrationCommands.listVoices,
      parseNarrationVoiceList,
    )
  }

  public async updateSettings(
    request: NarrationSettingsUpdateV2,
  ): Promise<NarrationSettingsSnapshotV1> {
    return this.request(
      narrationCommands.updateSettings,
      request,
      parseNarrationSettingsSnapshot,
    )
  }

  public setMuted(
    request: NarrationMuteRequestV1,
  ): Promise<NarrationSettingsSnapshotV1> {
    return this.request(
      narrationCommands.setMuted,
      request,
      parseNarrationSettingsSnapshot,
    )
  }

  public resetSettings(
    expectedVersion: number,
  ): Promise<NarrationSettingsSnapshotV1> {
    return this.request(
      narrationCommands.resetSettings,
      { schemaVersion: narrationSchemaVersion, expectedVersion },
      parseNarrationSettingsSnapshot,
    )
  }

  public async setScope(request: NarrationScopeRequestV1): Promise<void> {
    await this.requestVoid(narrationCommands.setScope, request)
  }

  public speak(
    request: NarrationSpeakRequestV1,
  ): Promise<NarrationSpeakResponseV1> {
    return this.request(
      narrationCommands.speak,
      request,
      parseNarrationSpeakResponse,
    )
  }

  public async cancel(reason: NarrationCancelReason): Promise<void> {
    await this.requestVoid(narrationCommands.cancel, {
      schemaVersion: narrationSchemaVersion,
      reason,
    })
  }

  private async requestWithoutPayload<T>(
    command: NarrationCommand,
    parse: (value: unknown) => T,
  ): Promise<T> {
    try {
      return parse(await this.invoke(command))
    } catch (error) {
      throw normalizeError(error)
    }
  }

  private async request<T>(
    command: NarrationCommand,
    request: unknown,
    parse: (value: unknown) => T,
  ): Promise<T> {
    try {
      return parse(await this.invoke(command, { request }))
    } catch (error) {
      throw normalizeError(error)
    }
  }

  private async requestVoid(
    command: NarrationCommand,
    request: unknown,
  ): Promise<void> {
    try {
      const response = await this.invoke(command, { request })
      if (response !== null) throw new NarrationContractError()
    } catch (error) {
      throw normalizeError(error)
    }
  }
}

function initialRuntime(): NarrationRuntimeSnapshotV1 {
  return {
    schemaVersion: narrationSchemaVersion,
    playbackState: "idle",
    activeRequestId: null,
    queueDepth: 0,
    lastErrorCode: null,
  }
}

function initialSettings(): NarrationSettingsSnapshotV1 {
  return {
    schemaVersion: narrationSchemaVersion,
    settings: {
      schemaVersion: narrationSettingsSchemaVersion,
      version: 0,
      enabled: false,
      muted: false,
      provider: null,
      apiKeyConfigured: false,
      model: "gpt-4o-mini-tts",
      voice: "marin",
      speed: 1,
    },
    runtime: initialRuntime(),
    loadWarningCode: null,
  }
}

export class DemoNarrationGateway implements NarrationGateway {
  public readonly kind = "demo" as const
  #snapshot = initialSettings()
  #scope: NarrationScopeRequestV1 | null = null
  #playbackTimer: ReturnType<typeof setTimeout> | null = null

  public getSettings(): Promise<NarrationSettingsSnapshotV1> {
    return Promise.resolve(structuredClone(this.#snapshot))
  }

  public getRuntime(): Promise<NarrationRuntimeSnapshotV1> {
    return Promise.resolve(structuredClone(this.#snapshot.runtime))
  }

  public listVoices(): Promise<NarrationVoiceListV1> {
    return Promise.resolve({
      schemaVersion: narrationSchemaVersion,
      voices: openAiTtsVoices.flatMap((name) => [
        { name, locale: "ja_JP" },
        { name, locale: "en_US" },
      ]),
    })
  }

  public async updateSettings(
    request: NarrationSettingsUpdateV2,
  ): Promise<NarrationSettingsSnapshotV1> {
    this.requireVersion(request.expectedVersion)
    if (
      request.schemaVersion !== narrationSettingsSchemaVersion ||
      request.model !== "gpt-4o-mini-tts" ||
      !openAiTtsVoices.includes(request.voice) ||
      request.speed < 0.75 ||
      request.speed > 1.25 ||
      Math.abs(request.speed * 20 - Math.round(request.speed * 20)) > 1e-9 ||
      (request.apiKeyAction.kind === "replace" &&
        (request.apiKeyAction.value.length > 512 ||
          !/^[A-Za-z0-9._-]+$/u.test(request.apiKeyAction.value)))
    ) {
      throw new NarrationBoundaryError({
        code: "NARRATION-SETTINGS-INVALID",
        operation: "narration_update_settings",
        recoverable: false,
        userMessageKey: "narration.error.generic",
        detailRef: "narration-v2",
      })
    }
    const apiKeyConfigured =
      request.apiKeyAction.kind === "replace"
        ? request.apiKeyAction.value.trim().length > 0
        : request.apiKeyAction.kind === "clear"
          ? false
          : this.#snapshot.settings.apiKeyConfigured
    if (
      (!apiKeyConfigured && request.provider !== null) ||
      (request.enabled && (!apiKeyConfigured || request.provider !== "openai"))
    ) {
      throw new NarrationBoundaryError({
        code: "NARRATION-API-KEY-REQUIRED",
        operation: "narration_update_settings",
        recoverable: true,
        userMessageKey: "narration.error.generic",
        detailRef: "narration-v2",
      })
    }
    this.#snapshot = {
      ...this.#snapshot,
      settings: {
        schemaVersion: narrationSettingsSchemaVersion,
        version: request.expectedVersion + 1,
        enabled: request.enabled,
        muted: request.muted,
        provider: apiKeyConfigured ? request.provider : null,
        apiKeyConfigured,
        model: request.model,
        voice: request.voice,
        speed: request.speed,
      },
    }
    return this.getSettings()
  }

  public async setMuted(
    request: NarrationMuteRequestV1,
  ): Promise<NarrationSettingsSnapshotV1> {
    this.requireVersion(request.expectedVersion)
    if (request.muted) await this.cancel("mute")
    this.#snapshot = {
      ...this.#snapshot,
      settings: {
        ...this.#snapshot.settings,
        version: request.expectedVersion + 1,
        muted: request.muted,
      },
    }
    return this.getSettings()
  }

  public async resetSettings(
    expectedVersion: number,
  ): Promise<NarrationSettingsSnapshotV1> {
    this.requireVersion(expectedVersion)
    await this.cancel("reset")
    this.#snapshot = initialSettings()
    this.#snapshot = {
      ...this.#snapshot,
      settings: { ...this.#snapshot.settings, version: expectedVersion + 1 },
    }
    return this.getSettings()
  }

  public async setScope(request: NarrationScopeRequestV1): Promise<void> {
    if (
      this.#scope?.workspaceId !== request.workspaceId ||
      this.#scope.generation !== request.generation
    ) {
      await this.cancel("workspace_switch")
    }
    this.#scope = structuredClone(request)
  }

  public speak(
    request: NarrationSpeakRequestV1,
  ): Promise<NarrationSpeakResponseV1> {
    if (!this.#snapshot.settings.enabled) return this.response("disabled")
    if (this.#snapshot.settings.muted) return this.response("muted")
    if (
      this.#scope?.workspaceId !== request.workspaceId ||
      this.#scope.generation !== request.generation
    ) {
      return this.response("stale", "NARRATION-STALE")
    }
    if (
      !this.#snapshot.settings.apiKeyConfigured ||
      this.#snapshot.settings.provider !== "openai"
    ) {
      return this.response("unavailable", "NARRATION-PROVIDER-UNAVAILABLE")
    }
    if (this.#playbackTimer !== null) clearTimeout(this.#playbackTimer)
    this.#snapshot = {
      ...this.#snapshot,
      runtime: {
        schemaVersion: narrationSchemaVersion,
        playbackState: "playing",
        activeRequestId: request.requestId,
        queueDepth: 0,
        lastErrorCode: null,
      },
    }
    this.#playbackTimer = setTimeout(() => {
      this.#playbackTimer = null
      this.#snapshot = { ...this.#snapshot, runtime: initialRuntime() }
    }, 120)
    return this.response("queued")
  }

  public cancel(reason: NarrationCancelReason): Promise<void> {
    void reason
    if (this.#playbackTimer !== null) clearTimeout(this.#playbackTimer)
    this.#playbackTimer = null
    this.#snapshot = { ...this.#snapshot, runtime: initialRuntime() }
    return Promise.resolve()
  }

  private requireVersion(expectedVersion: number): void {
    if (this.#snapshot.settings.version !== expectedVersion) {
      throw new NarrationBoundaryError({
        code: "NARRATION-SETTINGS-CONFLICT",
        operation: "narration_update_settings",
        recoverable: true,
        userMessageKey: "narration.error.generic",
        detailRef: "narration-v1",
      })
    }
  }

  private response(
    disposition: NarrationSpeakResponseV1["disposition"],
    code: string | null = null,
  ): Promise<NarrationSpeakResponseV1> {
    return Promise.resolve({
      schemaVersion: narrationSchemaVersion,
      disposition,
      queueDepth: this.#snapshot.runtime.queueDepth,
      code,
    })
  }
}

export function createNarrationGateway(
  kind: NarrationGatewayKind,
): NarrationGateway {
  return kind === "native"
    ? new NativeNarrationGateway()
    : new DemoNarrationGateway()
}
