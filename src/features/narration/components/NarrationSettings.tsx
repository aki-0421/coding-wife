import { useEffect, useMemo, useState } from "react"
import {
  CircleAlertIcon,
  ShieldCheckIcon,
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
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import type {
  NarrationSettingsV1,
  NarrationVoiceSelectionV1,
} from "@/features/narration/contracts"
import { narrationCopy } from "@/features/narration/copy"
import {
  useNarrationController,
  useNarrationSnapshot,
} from "@/features/narration/hooks"
import { useI18n } from "@/features/localization"

const rateOptions = Array.from(
  { length: 11 },
  (_, index) => 0.75 + index * 0.05,
)

interface NarrationDraft {
  readonly enabled: boolean
  readonly voices: NarrationVoiceSelectionV1
  readonly rate: number
}

export interface NarrationSettingsProps {
  readonly heading: string
  readonly muted: boolean
  readonly workspaceId: string
  readonly onMutedChange: (muted: boolean) => void
}

function draftFromSettings(settings: NarrationSettingsV1): NarrationDraft {
  return {
    enabled: settings.enabled,
    voices: settings.voices,
    rate: settings.rate,
  }
}

function sameDraft(draft: NarrationDraft, settings: NarrationSettingsV1) {
  return (
    draft.enabled === settings.enabled &&
    draft.rate === settings.rate &&
    draft.voices.ja === settings.voices.ja &&
    draft.voices.en === settings.voices.en
  )
}

function NarrationSettingsForm({
  heading,
  muted,
  workspaceId,
  onMutedChange,
  settings,
}: NarrationSettingsProps & { readonly settings: NarrationSettingsV1 }) {
  const { locale } = useI18n()
  const copy = narrationCopy[locale]
  const controller = useNarrationController()
  const snapshot = useNarrationSnapshot()
  const [draft, setDraft] = useState(() => draftFromSettings(settings))
  const [resetOpen, setResetOpen] = useState(false)
  const voices = controller.voicesForLocale(locale)
  const selectedVoice = draft.voices[locale]
  const dirty = !sameDraft(draft, settings)
  const saving = snapshot.settingsStatus === "saving"
  const voiceUnavailable =
    snapshot.voiceStatus === "error" || voices.length === 0
  const currentVoiceIsValid =
    selectedVoice !== null &&
    voices.some((voice) => voice.name === selectedVoice)
  const canSave =
    dirty &&
    !saving &&
    (!draft.enabled || (currentVoiceIsValid && !voiceUnavailable))
  const canTest =
    !dirty &&
    settings.enabled &&
    !settings.muted &&
    currentVoiceIsValid &&
    !voiceUnavailable &&
    snapshot.test.status !== "playing"
  const presentation = snapshot.presentation

  useEffect(() => {
    if (settings.muted !== muted) onMutedChange(settings.muted)
  }, [muted, onMutedChange, settings.muted])

  const statusLabel = useMemo(() => {
    if (snapshot.settingsStatus === "saving") return copy.unsaved
    return dirty ? copy.unsaved : copy.saved
  }, [copy.saved, copy.unsaved, dirty, snapshot.settingsStatus])

  const setVoice = (voice: string | null) => {
    setDraft((current) => ({
      ...current,
      voices: { ...current.voices, [locale]: voice },
    }))
  }

  const setEnabled = (enabled: boolean) => {
    setDraft((current) => {
      const nextVoice =
        enabled && current.voices[locale] === null
          ? (voices[0]?.name ?? null)
          : current.voices[locale]
      return {
        ...current,
        enabled,
        voices: { ...current.voices, [locale]: nextVoice },
      }
    })
  }

  const save = async () => {
    await controller.saveSettings({
      enabled: draft.enabled,
      muted: settings.muted,
      voices: draft.voices,
      rate: draft.rate,
    })
  }

  const setMuted = async (nextMuted: boolean) => {
    if (await controller.setMuted(nextMuted)) onMutedChange(nextMuted)
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
      onMutedChange(false)
      setResetOpen(false)
    }
  }

  return (
    <section
      className="flex max-w-[780px] flex-col gap-lg"
      data-narration-settings
    >
      <div className="flex flex-wrap items-start justify-between gap-md">
        <div className="min-w-0">
          <h2 className="m-0 text-headline text-text-strong">{heading}</h2>
          <p className="m-0 mt-xs max-w-[68ch] text-caption text-muted-foreground">
            {copy.description}
          </p>
        </div>
        <Badge className="shrink-0" variant="outline">
          <ShieldCheckIcon aria-hidden="true" />
          {copy.localOnly}
        </Badge>
      </div>

      {snapshot.settingsStatus === "error" ||
      snapshot.voiceStatus === "error" ? (
        <Alert>
          <CircleAlertIcon aria-hidden="true" />
          <AlertTitle>{copy.errorTitle}</AlertTitle>
          <AlertDescription>
            {copy.unavailableDescription}
            {snapshot.lastErrorCode ? (
              <span className="mt-xxs block font-mono text-label">
                {snapshot.lastErrorCode}
              </span>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="rounded-panel border border-divider bg-surface px-lg py-md">
        <p className="m-0 text-label text-muted-foreground">
          {copy.sourceLabel}
        </p>
        <p className="m-0 mt-xxs font-mono text-caption text-text-strong">
          {copy.sourceValue}
        </p>
        <p className="m-0 mt-xs text-caption text-muted-foreground">
          {copy.sourceDescription}
        </p>
      </div>

      <FieldGroup>
        <Field className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-lg">
          <FieldLabel htmlFor="narration-enabled">{copy.enable}</FieldLabel>
          <Switch
            aria-label={copy.enable}
            checked={draft.enabled}
            disabled={saving || voiceUnavailable}
            id="narration-enabled"
            onCheckedChange={setEnabled}
          />
          <FieldDescription className="col-start-1">
            {copy.enableDescription}
          </FieldDescription>
        </Field>

        <Field className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-lg">
          <FieldLabel htmlFor="narration-muted">{copy.mute}</FieldLabel>
          <Switch
            aria-label={copy.mute}
            checked={settings.muted}
            disabled={saving}
            id="narration-muted"
            onCheckedChange={(nextMuted) => void setMuted(nextMuted)}
          />
          <FieldDescription className="col-start-1">
            {copy.muteDescription}
          </FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor="narration-voice">{copy.voice}</FieldLabel>
          <NativeSelect
            className="w-full max-w-72"
            disabled={!draft.enabled || saving || voiceUnavailable}
            id="narration-voice"
            onChange={(event) => setVoice(event.currentTarget.value || null)}
            value={selectedVoice ?? ""}
          >
            <NativeSelectOption value="">{copy.noVoice}</NativeSelectOption>
            {voices.map((voice) => (
              <NativeSelectOption
                key={`${voice.locale}:${voice.name}`}
                value={voice.name}
              >
                {voice.name} · {voice.locale}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <FieldDescription>{copy.voiceDescription}</FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor="narration-rate">{copy.rate}</FieldLabel>
          <NativeSelect
            className="w-full max-w-44"
            disabled={!draft.enabled || saving}
            id="narration-rate"
            onChange={(event) => {
              const rate = Number(event.currentTarget.value)
              setDraft((current) => ({
                ...current,
                rate,
              }))
            }}
            value={draft.rate.toFixed(2)}
          >
            {rateOptions.map((rate) => (
              <NativeSelectOption key={rate} value={rate.toFixed(2)}>
                {rate.toFixed(2)}×
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <FieldDescription>{copy.rateDescription}</FieldDescription>
        </Field>
      </FieldGroup>

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
            <Volume2Icon aria-hidden="true" />
            {copy.test}
          </Button>
          <Button
            disabled={snapshot.test.status !== "playing"}
            onClick={() => void controller.cancelTest()}
            type="button"
            variant="outline"
          >
            <VolumeXIcon aria-hidden="true" />
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

      <Separator />

      <div aria-live="polite" className="text-caption" role="status">
        <p className="m-0 text-title text-text-strong">
          {copy.activePresentation}
        </p>
        {presentation ? (
          <dl className="m-0 mt-xs grid grid-cols-[max-content_minmax(0,1fr)] gap-x-lg gap-y-xxs">
            <dt className="text-muted-foreground">Commit</dt>
            <dd className="m-0 font-mono">
              {presentation.key.commitSha.slice(0, 8)}
            </dd>
            <dt className="text-muted-foreground">{copy.status}</dt>
            <dd className="m-0">{presentation.status}</dd>
            <dt className="text-muted-foreground">{copy.speech}</dt>
            <dd className="m-0">{presentation.speechStatus}</dd>
          </dl>
        ) : (
          <p className="m-0 mt-xxs text-muted-foreground">
            {copy.noPresentation}
          </p>
        )}
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

  return (
    <NarrationSettingsForm
      key={settings.version}
      {...props}
      settings={settings}
    />
  )
}
