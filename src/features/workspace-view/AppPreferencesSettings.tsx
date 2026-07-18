import { useEffect, useRef, useState } from "react"
import { AlertTriangleIcon, DatabaseIcon } from "lucide-react"

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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useI18n, type SupportedLocale } from "@/features/localization"
import {
  useAppPreferences,
  useAppPreferencesController,
} from "@/features/preferences"
import type { RuntimeState } from "@/features/runtime"
import type { WorkspaceCopy } from "@/features/workspace-view/copy"

export interface AppPreferencesSettingsProps {
  readonly copy: WorkspaceCopy
  readonly runtimeState: RuntimeState
  readonly onResetUi: () => void
}

function PreferencesStatus({
  copy,
}: Pick<AppPreferencesSettingsProps, "copy">) {
  const state = useAppPreferences()
  const { persistence, preferences } = state.snapshot
  const label =
    persistence === "demo_memory"
      ? copy.settingsView.preferenceStatusDemo
      : `${copy.settingsView.preferenceStatusNative} · ${copy.settingsView.preferenceVersion} ${preferences.version}`

  return (
    <div className="flex flex-wrap items-center justify-end gap-xs">
      <Badge
        className="h-auto max-w-full shrink self-start break-words whitespace-normal py-xxs leading-snug"
        variant={state.status === "recovery" ? "destructive" : "outline"}
      >
        {label}
      </Badge>
      {state.status === "saving" ? (
        <span aria-live="polite" className="text-caption text-muted-foreground">
          {copy.settingsView.preferenceSaving}
        </span>
      ) : null}
    </div>
  )
}

function PreferenceAlert({
  copy,
  onReset,
  onRetry,
}: Pick<AppPreferencesSettingsProps, "copy"> & {
  readonly onReset: () => void
  readonly onRetry: () => void
}) {
  const state = useAppPreferences()
  const recovery = state.snapshot.recoveryCode
  if (state.status !== "error" && recovery === null) return null

  const recovering = recovery !== null
  const code = recovery ?? state.errorCode ?? "APP-PREFERENCES-UNAVAILABLE"
  return (
    <Alert role="alert">
      <AlertTriangleIcon aria-hidden="true" className="text-destructive" />
      <AlertTitle>
        {recovering
          ? copy.settingsView.preferenceRecoveryTitle
          : copy.settingsView.preferenceErrorTitle}
      </AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-xs">
        <span>
          {recovering
            ? copy.settingsView.preferenceRecoveryBody
            : copy.settingsView.preferenceErrorBody}
        </span>
        <span className="flex flex-wrap items-center gap-xs">
          <span>{copy.settingsView.preferenceSafeCode}</span>
          <code className="font-mono text-label text-destructive">{code}</code>
        </span>
        <span className="flex flex-wrap gap-xs">
          {!recovering ? (
            <Button
              onClick={onRetry}
              size="xs"
              type="button"
              variant="secondary"
            >
              {copy.retry}
            </Button>
          ) : null}
          <Button onClick={onReset} size="xs" type="button" variant="secondary">
            {copy.settingsView.resetPreferences}
          </Button>
        </span>
      </AlertDescription>
    </Alert>
  )
}

export function AppPreferencesSettings({
  copy,
  runtimeState,
  onResetUi,
}: AppPreferencesSettingsProps) {
  const { locale, setLocale, t } = useI18n()
  const controller = useAppPreferencesController()
  const state = useAppPreferences()
  const preferences = state.snapshot.preferences
  const controlPreferences = state.pendingPreferences ?? preferences
  const [failedLocale, setFailedLocale] = useState<SupportedLocale | null>(null)
  const [resetOpen, setResetOpen] = useState(false)
  const [resetting, setResetting] = useState(false)
  const resetTriggerRef = useRef<HTMLButtonElement>(null)
  const resetCancelRef = useRef<HTMLButtonElement>(null)
  const localeIntentRef = useRef(0)
  const mountedRef = useRef(true)
  const loading = state.status === "loading"
  const invalid = state.status === "error" || state.status === "recovery"

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const selectLocale = async (nextLocale: SupportedLocale) => {
    const intent = localeIntentRef.current + 1
    localeIntentRef.current = intent
    setFailedLocale(null)
    const succeeded = await setLocale(nextLocale).catch(() => false)
    if (!mountedRef.current || intent !== localeIntentRef.current) return
    setFailedLocale(succeeded ? null : nextLocale)
  }

  const resetPreferences = async () => {
    setResetting(true)
    const succeeded = await controller.reset().catch(() => false)
    if (!mountedRef.current) return
    setResetting(false)
    if (succeeded) {
      setFailedLocale(null)
      setResetOpen(false)
    }
  }

  return (
    <section
      aria-labelledby="settings-general-title"
      className="flex flex-col gap-xl"
    >
      <div className="flex items-center justify-between gap-md max-[700px]:flex-col max-[700px]:items-start max-[700px]:gap-sm">
        <h2
          className="m-0 text-headline text-text-strong"
          id="settings-general-title"
        >
          {copy.settingsView.generalTitle}
        </h2>
        <PreferencesStatus copy={copy} />
      </div>

      <PreferenceAlert
        copy={copy}
        onReset={() => setResetOpen(true)}
        onRetry={() => void controller.retry()}
      />

      <FieldGroup>
        <Field data-invalid={failedLocale !== null || invalid || undefined}>
          <FieldLabel>{copy.settingsView.language}</FieldLabel>
          <FieldDescription>
            {copy.settingsView.languageDescription}
          </FieldDescription>
          <ToggleGroup
            aria-label={t("locale.switchLabel")}
            disabled={loading}
            onValueChange={(value) => {
              if (value === "ja" || value === "en") void selectLocale(value)
            }}
            type="single"
            value={state.pendingPreferences?.locale ?? locale}
          >
            <ToggleGroupItem value="ja">{t("locale.ja")}</ToggleGroupItem>
            <ToggleGroupItem value="en">{t("locale.en")}</ToggleGroupItem>
          </ToggleGroup>
          {failedLocale ? (
            <div className="flex flex-wrap items-center gap-xs" role="alert">
              <span className="text-caption text-destructive">
                {copy.settingsView.languageSaveError}
              </span>
              <Button
                onClick={() => void selectLocale(failedLocale)}
                size="xs"
                type="button"
                variant="secondary"
              >
                {copy.retry}
              </Button>
            </div>
          ) : null}
        </Field>

        <Field data-invalid={invalid || undefined}>
          <FieldLabel htmlFor="app-reduced-motion">
            {copy.settingsView.motion}
          </FieldLabel>
          <FieldDescription id="app-reduced-motion-description">
            {copy.settingsView.motionDescription}
          </FieldDescription>
          <NativeSelect
            aria-describedby="app-reduced-motion-description"
            aria-invalid={invalid || undefined}
            disabled={loading}
            id="app-reduced-motion"
            onChange={(event) => {
              const value = event.currentTarget.value
              if (value === "system" || value === "on" || value === "off") {
                void controller.update({ reducedMotion: value })
              }
            }}
            value={controlPreferences.reducedMotion}
          >
            <NativeSelectOption value="system">
              {copy.settingsView.system}
            </NativeSelectOption>
            <NativeSelectOption value="on">
              {copy.settingsView.reduce}
            </NativeSelectOption>
            <NativeSelectOption value="off">
              {copy.settingsView.allow}
            </NativeSelectOption>
          </NativeSelect>
        </Field>

        <Field
          className="flex-row items-center justify-between gap-lg"
          data-invalid={invalid || undefined}
        >
          <div className="flex min-w-0 flex-col gap-xs">
            <FieldLabel htmlFor="app-character-visible">
              {copy.settingsView.characterVisibility}
            </FieldLabel>
            <FieldDescription id="app-character-visible-description">
              {copy.settingsView.characterVisibilityDescription}
            </FieldDescription>
          </div>
          <Switch
            aria-describedby="app-character-visible-description"
            aria-invalid={invalid || undefined}
            aria-label={copy.settingsView.characterVisible}
            checked={controlPreferences.characterVisibility === "visible"}
            disabled={loading}
            id="app-character-visible"
            onCheckedChange={(visible) => {
              void controller.update({
                characterVisibility: visible ? "visible" : "hidden",
              })
            }}
          />
        </Field>
      </FieldGroup>

      <Separator />
      <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-lg gap-y-xs text-caption">
        <dt className="text-muted-foreground">
          {copy.settingsView.appVersion}
        </dt>
        <dd className="m-0 font-mono text-foreground">
          {runtimeState.status === "ready"
            ? runtimeState.metadata.appVersion
            : "—"}
        </dd>
      </dl>

      <div className="flex flex-col gap-md">
        <div className="flex min-w-0 items-start justify-between gap-xl border-b border-divider py-md max-[700px]:flex-col max-[700px]:gap-sm">
          <div className="flex min-w-0 max-w-[60ch] flex-col gap-xxs">
            <span className="text-title text-text-strong">
              {copy.settingsView.resetPreferences}
            </span>
            <span className="break-words text-caption text-muted-foreground">
              {copy.settingsView.resetPreferencesDescription}
            </span>
          </div>
          <Button
            disabled={resetting || state.status === "saving"}
            onClick={() => setResetOpen(true)}
            ref={resetTriggerRef}
            size="xs"
            type="button"
            variant="secondary"
          >
            <DatabaseIcon aria-hidden="true" data-icon="inline-start" />
            {copy.settingsView.resetPreferences}
          </Button>
        </div>
        <div className="flex min-w-0 items-start justify-between gap-xl border-b border-divider py-md max-[700px]:flex-col max-[700px]:gap-sm">
          <div className="flex min-w-0 max-w-[60ch] flex-col gap-xxs">
            <span className="text-title text-text-strong">
              {copy.settingsView.resetUi}
            </span>
            <span className="break-words text-caption text-muted-foreground">
              {copy.settingsView.resetUiDescription}
            </span>
          </div>
          <Button
            onClick={onResetUi}
            size="xs"
            type="button"
            variant="secondary"
          >
            {copy.settingsView.resetUi}
          </Button>
        </div>
      </div>

      <Dialog
        onOpenChange={(open) => {
          if (!resetting) setResetOpen(open)
        }}
        open={resetOpen}
      >
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            resetTriggerRef.current?.focus()
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            resetCancelRef.current?.focus()
          }}
          showCloseButton={!resetting}
        >
          <DialogHeader>
            <DialogTitle>
              {copy.settingsView.resetPreferencesConfirmTitle}
            </DialogTitle>
            <DialogDescription>
              {copy.settingsView.resetPreferencesConfirmBody}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              disabled={resetting}
              onClick={() => setResetOpen(false)}
              ref={resetCancelRef}
              type="button"
              variant="outline"
            >
              {copy.settingsView.resetPreferencesCancel}
            </Button>
            <Button
              disabled={resetting}
              onClick={() => void resetPreferences()}
              type="button"
              variant="destructive"
            >
              {resetting
                ? copy.settingsView.resetPreferencesInProgress
                : copy.settingsView.resetPreferencesConfirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
