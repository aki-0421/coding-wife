import { useLayoutEffect, useMemo, useRef, useState } from "react"
import {
  AudioLinesIcon,
  CircleAlertIcon,
  KeyRoundIcon,
  Volume2Icon,
  VolumeXIcon,
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
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  isCaptionTargetFullyVisible,
  scheduleAfterCaptionPaint,
} from "@/features/narration/components/caption-visibility"
import {
  openAiTtsModels,
  openAiTtsVoices,
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

const speedOptions = Array.from(
  { length: 11 },
  (_, index) => 0.75 + index * 0.05,
)

interface NarrationDraft {
  readonly enabled: boolean
  readonly provider: NarrationTtsProvider | null
  readonly model: OpenAiTtsModel
  readonly voice: OpenAiTtsVoice
  readonly speed: number
  readonly apiKey: string
  readonly clearApiKey: boolean
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
    clearApiKey: false,
  }
}

function sameDraft(draft: NarrationDraft, settings: NarrationSettingsV2) {
  return (
    draft.enabled === settings.enabled &&
    draft.provider === settings.provider &&
    draft.model === settings.model &&
    draft.voice === settings.voice &&
    draft.speed === settings.speed &&
    draft.apiKey.length === 0 &&
    !draft.clearApiKey
  )
}

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
  const [resetOpen, setResetOpen] = useState(false)
  const testCaptionRef = useRef<HTMLDivElement>(null)
  const dirty = !sameDraft(draft, settings)
  const saving = snapshot.settingsStatus === "saving"
  const apiKeyValid =
    draft.apiKey.length === 0 ||
    (draft.apiKey.length <= 512 && /^[A-Za-z0-9._-]+$/u.test(draft.apiKey))
  const providerAvailable =
    !draft.clearApiKey &&
    (settings.apiKeyConfigured || (draft.apiKey.length > 0 && apiKeyValid))
  const canSave = dirty && !saving && apiKeyValid
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

  const statusLabel = useMemo(() => {
    if (snapshot.settingsStatus === "saving") return copy.unsaved
    return dirty ? copy.unsaved : copy.saved
  }, [copy.saved, copy.unsaved, dirty, snapshot.settingsStatus])

  const save = async () => {
    const nextHasKey =
      draft.apiKey.length > 0 ||
      (settings.apiKeyConfigured && !draft.clearApiKey)
    const saved = await controller.saveSettings({
      enabled: nextHasKey ? draft.enabled : false,
      muted: settings.muted,
      provider: nextHasKey ? (draft.provider ?? "openai") : null,
      apiKeyAction: draft.clearApiKey
        ? { kind: "clear" }
        : draft.apiKey.length > 0
          ? { kind: "replace", value: draft.apiKey }
          : { kind: "keep" },
      model: draft.model,
      voice: draft.voice,
      speed: draft.speed,
    })
    if (saved) {
      const savedSettings = controller.getSnapshot().settingsSnapshot?.settings
      if (savedSettings !== undefined) {
        setDraft(draftFromSettings(savedSettings))
      }
    }
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

  const reset = async () => {
    if (await controller.resetSettings()) {
      const resetSettings = controller.getSnapshot().settingsSnapshot?.settings
      if (resetSettings !== undefined) {
        setDraft(draftFromSettings(resetSettings))
      }
      setResetOpen(false)
    }
  }

  return (
    <section
      className="flex max-w-[780px] flex-col gap-xl"
      data-narration-settings
    >
      <div className="min-w-0">
        <h2 className="m-0 text-headline text-text-strong">{heading}</h2>
        <p className="m-0 mt-xs max-w-[68ch] text-caption text-muted-foreground">
          {copy.description}
        </p>
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
            onCheckedChange={(enabled) =>
              setDraft((current) => ({ ...current, enabled }))
            }
          />
          <FieldDescription className="col-start-1">
            {copy.enableDescription}
          </FieldDescription>
        </Field>

        <Field data-disabled={!providerAvailable || undefined}>
          <FieldLabel htmlFor="narration-provider">{copy.provider}</FieldLabel>
          <NativeSelect
            className="w-full max-w-72"
            disabled={saving || !providerAvailable}
            id="narration-provider"
            onChange={(event) => {
              const provider =
                event.currentTarget.value === "openai" ? "openai" : null
              setDraft((current) => ({
                ...current,
                provider,
              }))
            }}
            value={providerAvailable ? (draft.provider ?? "openai") : ""}
          >
            {!providerAvailable ? (
              <NativeSelectOption value="">
                {copy.noProvider}
              </NativeSelectOption>
            ) : null}
            {providerAvailable ? (
              <NativeSelectOption value="openai">OpenAI</NativeSelectOption>
            ) : null}
          </NativeSelect>
          <FieldDescription>{copy.providerDescription}</FieldDescription>
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
                  variant={
                    settings.apiKeyConfigured && !draft.clearApiKey
                      ? "success"
                      : "outline"
                  }
                >
                  <KeyRoundIcon aria-hidden="true" className="size-3" />
                  {settings.apiKeyConfigured && !draft.clearApiKey
                    ? copy.apiKeyConfigured
                    : copy.apiKeyNotConfigured}
                </Badge>
              </div>
              <Input
                aria-describedby={
                  apiKeyValid
                    ? "narration-openai-api-key-description"
                    : "narration-openai-api-key-description narration-openai-api-key-error"
                }
                aria-invalid={!apiKeyValid}
                autoComplete="off"
                className="max-w-[28rem]"
                disabled={saving || draft.clearApiKey}
                id="narration-openai-api-key"
                maxLength={512}
                onChange={(event) => {
                  const apiKey = event.currentTarget.value
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
              <FieldDescription id="narration-openai-api-key-description">
                {copy.apiKeyDescription}
              </FieldDescription>
              {!apiKeyValid ? (
                <p
                  className="m-0 text-caption text-destructive"
                  id="narration-openai-api-key-error"
                >
                  {copy.apiKeyInvalid}
                </p>
              ) : null}
              {settings.apiKeyConfigured ? (
                <div className="flex flex-wrap items-center gap-sm">
                  <Button
                    disabled={saving}
                    onClick={() =>
                      setDraft((current) => ({
                        ...current,
                        enabled: current.clearApiKey ? settings.enabled : false,
                        provider: current.clearApiKey
                          ? settings.provider
                          : null,
                        apiKey: "",
                        clearApiKey: !current.clearApiKey,
                      }))
                    }
                    size="xs"
                    type="button"
                    variant="outline"
                  >
                    {draft.clearApiKey ? copy.resetCancel : copy.clearApiKey}
                  </Button>
                  {draft.clearApiKey ? (
                    <span className="text-caption text-destructive">
                      {copy.apiKeyWillBeRemoved}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </Field>

            <Field>
              <FieldLabel htmlFor="narration-model">{copy.model}</FieldLabel>
              <NativeSelect
                className="w-full max-w-72"
                disabled={saving}
                id="narration-model"
                onChange={(event) => {
                  const model = event.currentTarget.value as OpenAiTtsModel
                  setDraft((current) => ({
                    ...current,
                    model,
                  }))
                }}
                value={draft.model}
              >
                {openAiTtsModels.map((model) => (
                  <NativeSelectOption key={model} value={model}>
                    {model}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <FieldDescription>{copy.modelDescription}</FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor="narration-voice">{copy.voice}</FieldLabel>
              <NativeSelect
                className="w-full max-w-72"
                disabled={saving}
                id="narration-voice"
                onChange={(event) => {
                  const voice = event.currentTarget.value as OpenAiTtsVoice
                  setDraft((current) => ({
                    ...current,
                    voice,
                  }))
                }}
                value={draft.voice}
              >
                {openAiTtsVoices.map((voice) => (
                  <NativeSelectOption key={voice} value={voice}>
                    {voice}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <FieldDescription>{copy.voiceDescription}</FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor="narration-speed">{copy.speed}</FieldLabel>
              <NativeSelect
                className="w-full max-w-44"
                disabled={saving}
                id="narration-speed"
                onChange={(event) => {
                  const speed = Number(event.currentTarget.value)
                  setDraft((current) => ({ ...current, speed }))
                }}
                value={draft.speed.toFixed(2)}
              >
                {speedOptions.map((speed) => (
                  <NativeSelectOption key={speed} value={speed.toFixed(2)}>
                    {speed.toFixed(2)}×
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <FieldDescription>{copy.speedDescription}</FieldDescription>
            </Field>
          </FieldGroup>

          <Alert className="mt-lg">
            <AudioLinesIcon aria-hidden="true" />
            <AlertTitle>{copy.openAi}</AlertTitle>
            <AlertDescription>{copy.aiDisclosure}</AlertDescription>
          </Alert>
        </TabsContent>
      </Tabs>

      <div className="flex flex-wrap items-center gap-sm border-t border-divider pt-md">
        <Button disabled={!canSave} onClick={() => void save()} type="button">
          {copy.save}
        </Button>
        <Button
          disabled={!dirty || saving}
          onClick={() => setDraft(draftFromSettings(settings))}
          type="button"
          variant="secondary"
        >
          {copy.discard}
        </Button>
        <Badge variant={dirty ? "running" : "outline"}>{statusLabel}</Badge>
      </div>

      <Separator />

      <div className="flex flex-col gap-sm">
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
          <Button
            onClick={() => setResetOpen(true)}
            type="button"
            variant="destructive"
          >
            {copy.reset}
          </Button>
        </div>
        {snapshot.test.text ? (
          <div
            aria-live="polite"
            className="rounded-control border border-divider bg-app-bg px-md py-sm"
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
      </div>

      <Dialog onOpenChange={setResetOpen} open={resetOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{copy.resetTitle}</DialogTitle>
            <DialogDescription>{copy.resetDescription}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              onClick={() => setResetOpen(false)}
              type="button"
              variant="secondary"
            >
              {copy.resetCancel}
            </Button>
            <Button
              onClick={() => void reset()}
              type="button"
              variant="destructive"
            >
              {copy.resetConfirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
