import { useEffect, useRef, useState } from "react"
import { AlertTriangleIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Separator } from "@/components/ui/separator"
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
  onRetry,
}: Pick<AppPreferencesSettingsProps, "copy"> & {
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
        <Button onClick={onRetry} size="xs" type="button" variant="secondary">
          {copy.retry}
        </Button>
      </AlertDescription>
    </Alert>
  )
}

export function AppPreferencesSettings({
  copy,
  runtimeState,
}: AppPreferencesSettingsProps) {
  const { locale, setLocale, t } = useI18n()
  const controller = useAppPreferencesController()
  const state = useAppPreferences()
  const [failedLocale, setFailedLocale] = useState<SupportedLocale | null>(null)
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
        onRetry={() => {
          if (state.status === "recovery") {
            void controller.update({
              locale: state.snapshot.preferences.locale,
            })
          } else {
            void controller.retry()
          }
        }}
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
    </section>
  )
}
