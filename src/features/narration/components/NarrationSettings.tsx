import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import {
  CircleAlertIcon,
  KeyRoundIcon,
  Volume2Icon,
  VolumeXIcon,
} from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  isCaptionTargetFullyVisible,
  scheduleAfterCaptionPaint,
} from "@/features/narration/components/caption-visibility"
import {
  openAiTtsModels,
  openAiTtsVoices,
  type NarrationApiKeyActionV2,
  type NarrationTtsProvider,
  type NarrationSettingsV2,
  type OpenAiTtsModel,
  type OpenAiTtsVoice,
} from "@/features/narration/contracts"
import { narrationCopy } from "@/features/narration/copy"
import {
  useNarrationController,
  useNarrationSnapshot,
} from "@/features/narration/hooks"
import { useI18n } from "@/features/localization"

interface NarrationDraft {
  readonly enabled: boolean
  readonly provider: NarrationTtsProvider | null
  readonly model: OpenAiTtsModel
  readonly voice: OpenAiTtsVoice
  readonly speed: number
  readonly apiKey: string
}

export interface NarrationSettingsProps {
  readonly heading: string
  readonly workspaceId: string
}

function draftFromSettings(settings: NarrationSettingsV2): NarrationDraft {
  return {
    enabled: settings.enabled,
    provider: settings.provider,
    model: settings.model,
    voice: settings.voice,
    speed: settings.speed,
    apiKey: "",
  }
}

function sameDraft(draft: NarrationDraft, settings: NarrationSettingsV2) {
  return (
    draft.enabled === settings.enabled &&
    draft.provider === settings.provider &&
    draft.model === settings.model &&
    draft.voice === settings.voice &&
    draft.speed === settings.speed &&
    draft.apiKey.length === 0
  )
}

const apiKeySaveDelayMilliseconds = 500

function NarrationSettingsForm({
  heading,
  workspaceId,
  settings,
}: NarrationSettingsProps & { readonly settings: NarrationSettingsV2 }) {
  const { locale } = useI18n()
  const copy = narrationCopy[locale]
  const controller = useNarrationController()
  const snapshot = useNarrationSnapshot()
  const [draft, setDraft] = useState(() => draftFromSettings(settings))
  const testCaptionRef = useRef<HTMLDivElement>(null)
  const apiKeySaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const apiKeyEditRevisionRef = useRef(0)
  const lastApiKeyAttemptRevisionRef = useRef(-1)
  const saveInFlightRef = useRef(false)
  const dirty = !sameDraft(draft, settings)
  const saving = snapshot.settingsStatus === "saving"
  const apiKeyValid =
    draft.apiKey.length === 0 ||
    (draft.apiKey.length <= 512 && /^[A-Za-z0-9._-]+$/u.test(draft.apiKey))
  const providerAvailable = settings.apiKeyConfigured
  const canTest =
    !dirty &&
    settings.enabled &&
    settings.apiKeyConfigured &&
    settings.provider === "openai" &&
    snapshot.test.status !== "preparing" &&
    snapshot.test.status !== "playing"

  useLayoutEffect(() => {
    const caption = testCaptionRef.current
    if (caption === null || snapshot.test.status !== "preparing") return
    return scheduleAfterCaptionPaint(() => {
      if (!isCaptionTargetFullyVisible(caption)) return
      controller.acknowledgeTestCaptionVisible({
        testGeneration: snapshot.test.generation,
      })
    })
  }, [controller, snapshot.test.generation, snapshot.test.status])

  const statusLabel =
    snapshot.settingsStatus === "saving"
      ? copy.saving
      : snapshot.settingsStatus === "error"
        ? copy.saveFailed
        : dirty
          ? copy.savePending
          : copy.saved

  const persistDraft = useCallback(
    async (
      nextDraft: NarrationDraft,
      apiKeyAction?: NarrationApiKeyActionV2,
    ) => {
      if (saveInFlightRef.current) return
      const currentSettings =
        controller.getSnapshot().settingsSnapshot?.settings
      if (currentSettings === undefined) return

      saveInFlightRef.current = true
      const nextApiKeyAction =
        apiKeyAction ??
        (nextDraft.apiKey.length > 0
          ? { kind: "replace" as const, value: nextDraft.apiKey }
          : { kind: "keep" as const })
      if (nextApiKeyAction.kind === "replace") {
        lastApiKeyAttemptRevisionRef.current = apiKeyEditRevisionRef.current
      }
      const nextHasKey =
        nextApiKeyAction.kind === "replace" ||
        (currentSettings.apiKeyConfigured && nextApiKeyAction.kind !== "clear")

      try {
        const saved = await controller.saveSettings({
          enabled: nextHasKey ? nextDraft.enabled : false,
          muted: currentSettings.muted,
          provider: nextHasKey ? (nextDraft.provider ?? "openai") : null,
          apiKeyAction: nextApiKeyAction,
          model: nextDraft.model,
          voice: nextDraft.voice,
          speed: nextDraft.speed,
        })
        if (!saved) return

        const savedSettings =
          controller.getSnapshot().settingsSnapshot?.settings
        if (savedSettings !== undefined) {
          setDraft(draftFromSettings(savedSettings))
        }
      } finally {
        saveInFlightRef.current = false
      }
    },
    [controller],
  )

  useEffect(() => {
    if (apiKeySaveTimerRef.current !== null) {
      clearTimeout(apiKeySaveTimerRef.current)
      apiKeySaveTimerRef.current = null
    }
    if (
      saving ||
      !apiKeyValid ||
      draft.apiKey.length === 0 ||
      lastApiKeyAttemptRevisionRef.current === apiKeyEditRevisionRef.current
    ) {
      return
    }

    apiKeySaveTimerRef.current = setTimeout(() => {
      apiKeySaveTimerRef.current = null
      void persistDraft(draft)
    }, apiKeySaveDelayMilliseconds)

    return () => {
      if (apiKeySaveTimerRef.current !== null) {
        clearTimeout(apiKeySaveTimerRef.current)
        apiKeySaveTimerRef.current = null
      }
    }
  }, [apiKeyValid, draft, persistDraft, saving])

  const saveApiKeyOnBlur = () => {
    if (saving || !apiKeyValid || draft.apiKey.length === 0) return
    if (apiKeySaveTimerRef.current !== null) {
      clearTimeout(apiKeySaveTimerRef.current)
      apiKeySaveTimerRef.current = null
    }
    void persistDraft(draft)
  }

  const playTest = async () => {
    const activeScope = snapshot.scope
    const generation =
      activeScope?.workspaceId === workspaceId ? activeScope.generation : 0
    await controller.playTest(
      { workspaceId, generation },
      locale,
      copy.testSample,
    )
  }

  return (
    <section
      className="flex max-w-[780px] flex-col gap-xl"
      data-narration-settings
    >
      <div className="flex flex-wrap items-center justify-between gap-sm">
        <h2 className="m-0 text-headline text-text-strong">{heading}</h2>
        <Badge
          aria-live="polite"
          variant={
            snapshot.settingsStatus === "error"
              ? "destructive"
              : saving || dirty
                ? "running"
                : "outline"
          }
        >
          {statusLabel}
        </Badge>
      </div>

      {snapshot.settingsStatus === "error" ? (
        <Alert>
          <CircleAlertIcon aria-hidden="true" />
          <AlertTitle>{copy.errorTitle}</AlertTitle>
          <AlertDescription>
            {copy.unavailableDescription}
            <span className="mt-xxs block font-mono text-label">
              {snapshot.lastErrorCode ?? "NARRATION-SETTINGS-UNAVAILABLE"}
            </span>
          </AlertDescription>
        </Alert>
      ) : null}

      <FieldGroup>
        <Field
          className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-lg"
          data-disabled={!providerAvailable || undefined}
        >
          <FieldLabel htmlFor="narration-enabled">{copy.enable}</FieldLabel>
          <Switch
            aria-label={copy.enable}
            checked={draft.enabled}
            disabled={saving || !providerAvailable}
            id="narration-enabled"
            onCheckedChange={(enabled) => {
              const nextDraft = { ...draft, enabled }
              setDraft(nextDraft)
              void persistDraft(nextDraft)
            }}
          />
        </Field>

        <Field data-disabled={!providerAvailable || undefined}>
          <FieldLabel htmlFor="narration-provider">{copy.provider}</FieldLabel>
          <Select
            disabled={saving || !providerAvailable}
            onValueChange={(value) => {
              const provider: NarrationTtsProvider | null =
                value === "openai" ? "openai" : null
              const nextDraft = { ...draft, provider }
              setDraft(nextDraft)
              void persistDraft(nextDraft)
            }}
            value={providerAvailable ? (draft.provider ?? "openai") : ""}
          >
            <SelectTrigger className="w-full max-w-72" id="narration-provider">
              <SelectValue placeholder={copy.noProvider} />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="openai">OpenAI</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      </FieldGroup>

      <Tabs defaultValue="openai">
        <TabsList
          aria-label={copy.providerTabsLabel}
          className="min-h-10 gap-xl overflow-x-auto border-b border-divider"
        >
          <TabsTrigger
            className="px-xxs after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-transparent data-[state=active]:after:bg-warm-active"
            value="openai"
          >
            {copy.openAi}
          </TabsTrigger>
        </TabsList>
        <TabsContent className="pt-lg" value="openai">
          <FieldGroup>
            <Field data-invalid={!apiKeyValid || undefined}>
              <div className="flex flex-wrap items-center justify-between gap-sm">
                <FieldLabel htmlFor="narration-openai-api-key">
                  {copy.apiKey}
                </FieldLabel>
                <Badge
                  variant={settings.apiKeyConfigured ? "success" : "outline"}
                >
                  <KeyRoundIcon aria-hidden="true" className="size-3" />
                  {settings.apiKeyConfigured
                    ? copy.apiKeyConfigured
                    : copy.apiKeyNotConfigured}
                </Badge>
              </div>
              <Input
                aria-describedby={
                  apiKeyValid ? undefined : "narration-openai-api-key-error"
                }
                aria-invalid={!apiKeyValid}
                autoComplete="off"
                className="max-w-[28rem]"
                disabled={saving}
                id="narration-openai-api-key"
                maxLength={512}
                onBlur={saveApiKeyOnBlur}
                onChange={(event) => {
                  const apiKey = event.currentTarget.value
                  apiKeyEditRevisionRef.current += 1
                  setDraft((current) => ({
                    ...current,
                    apiKey,
                  }))
                }}
                placeholder={copy.apiKeyPlaceholder}
                spellCheck={false}
                type="password"
                value={draft.apiKey}
              />
              {!apiKeyValid ? (
                <p
                  className="m-0 text-caption text-destructive"
                  id="narration-openai-api-key-error"
                >
                  {copy.apiKeyInvalid}
                </p>
              ) : null}
              {settings.apiKeyConfigured ? (
                <Button
                  className="self-start"
                  disabled={saving}
                  onClick={() => {
                    const nextDraft = {
                      ...draft,
                      enabled: false,
                      provider: null,
                      apiKey: "",
                    }
                    setDraft(nextDraft)
                    void persistDraft(nextDraft, { kind: "clear" })
                  }}
                  size="xs"
                  type="button"
                  variant="outline"
                >
                  {copy.clearApiKey}
                </Button>
              ) : null}
            </Field>

            <div className="grid gap-lg sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="narration-model">{copy.model}</FieldLabel>
                <Select
                  disabled={saving}
                  onValueChange={(value) => {
                    const model = value as OpenAiTtsModel
                    const nextDraft = { ...draft, model }
                    setDraft(nextDraft)
                    void persistDraft(nextDraft)
                  }}
                  value={draft.model}
                >
                  <SelectTrigger
                    className="w-52 max-w-full"
                    id="narration-model"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {openAiTtsModels.map((model) => (
                        <SelectItem key={model} value={model}>
                          {model}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>

              <Field>
                <FieldLabel htmlFor="narration-voice">{copy.voice}</FieldLabel>
                <Select
                  disabled={saving}
                  onValueChange={(value) => {
                    const voice = value as OpenAiTtsVoice
                    const nextDraft = { ...draft, voice }
                    setDraft(nextDraft)
                    void persistDraft(nextDraft)
                  }}
                  value={draft.voice}
                >
                  <SelectTrigger
                    className="w-52 max-w-full"
                    id="narration-voice"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {openAiTtsVoices.map((voice) => (
                        <SelectItem key={voice} value={voice}>
                          {voice}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            </div>

            <div className="grid items-end gap-lg sm:grid-cols-2">
              <Field>
                <div className="flex items-center justify-between gap-sm">
                  <FieldLabel
                    htmlFor="narration-speed"
                    id="narration-speed-label"
                  >
                    {copy.speed}
                  </FieldLabel>
                  <output
                    className="font-mono text-label text-muted-foreground"
                    htmlFor="narration-speed"
                  >
                    {draft.speed.toFixed(2)}×
                  </output>
                </div>
                <Slider
                  aria-labelledby="narration-speed-label"
                  disabled={saving}
                  id="narration-speed"
                  max={1.25}
                  min={0.75}
                  onValueChange={(value) => {
                    const rawSpeed = value[0]
                    if (rawSpeed === undefined) return
                    const speed = Math.round(rawSpeed * 100) / 100
                    setDraft((current) => ({ ...current, speed }))
                  }}
                  onValueCommit={(value) => {
                    const rawSpeed = value[0]
                    if (rawSpeed === undefined) return
                    const speed = Math.round(rawSpeed * 100) / 100
                    const nextDraft = { ...draft, speed }
                    setDraft(nextDraft)
                    void persistDraft(nextDraft)
                  }}
                  step={0.05}
                  value={[draft.speed]}
                />
              </Field>

              <div className="flex flex-wrap items-center gap-sm">
                <Button
                  disabled={!canTest}
                  onClick={() => void playTest()}
                  type="button"
                  variant="secondary"
                >
                  <Volume2Icon aria-hidden="true" data-icon="inline-start" />
                  {copy.test}
                </Button>
                <Button
                  disabled={
                    snapshot.test.status !== "preparing" &&
                    snapshot.test.status !== "playing"
                  }
                  onClick={() => void controller.cancelTest()}
                  type="button"
                  variant="outline"
                >
                  <VolumeXIcon aria-hidden="true" data-icon="inline-start" />
                  {copy.cancelTest}
                </Button>
              </div>
            </div>
          </FieldGroup>

          {snapshot.test.text ? (
            <div
              aria-live="polite"
              className="mt-lg rounded-control border border-divider bg-app-bg px-md py-sm"
              data-narration-test-status={snapshot.test.status}
              ref={testCaptionRef}
              role={snapshot.test.status === "unavailable" ? "alert" : "status"}
            >
              <p className="m-0 text-label text-muted-foreground">
                {copy.testCaption}
              </p>
              <p className="m-0 mt-xxs text-caption text-foreground">
                {snapshot.test.text}
              </p>
              {snapshot.test.errorCode ? (
                <p className="m-0 mt-xs font-mono text-label text-destructive">
                  {snapshot.test.errorCode}
                </p>
              ) : null}
            </div>
          ) : null}
        </TabsContent>
      </Tabs>
    </section>
  )
}

export function NarrationSettings(props: NarrationSettingsProps) {
  const { locale } = useI18n()
  const copy = narrationCopy[locale]
  const controller = useNarrationController()
  const snapshot = useNarrationSnapshot()
  const settings = snapshot.settingsSnapshot?.settings

  if (settings === undefined && snapshot.settingsStatus === "error") {
    return (
      <section
        className="flex max-w-[780px] flex-col gap-md"
        data-narration-settings
      >
        <h2 className="m-0 text-headline text-text-strong">{props.heading}</h2>
        <Alert>
          <CircleAlertIcon aria-hidden="true" />
          <AlertTitle>{copy.unavailable}</AlertTitle>
          <AlertDescription>
            {copy.unavailableDescription}
            {snapshot.lastErrorCode ? (
              <span className="mt-xxs block font-mono text-label">
                {snapshot.lastErrorCode}
              </span>
            ) : null}
          </AlertDescription>
        </Alert>
        <Button
          className="self-start"
          onClick={() => void controller.refresh()}
          type="button"
          variant="secondary"
        >
          {copy.retry}
        </Button>
      </section>
    )
  }

  if (settings === undefined || snapshot.settingsStatus === "loading") {
    return (
      <section
        className="flex max-w-[780px] flex-col gap-md"
        data-narration-settings
      >
        <h2 className="m-0 text-headline text-text-strong">{props.heading}</h2>
        <p
          aria-live="polite"
          className="m-0 text-caption text-muted-foreground"
          role="status"
        >
          {copy.loading}
        </p>
      </section>
    )
  }

  return <NarrationSettingsForm {...props} settings={settings} />
}
