import { useState } from "react"

import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import {
  useI18n,
  type SupportedLocale,
  type TranslationKey,
} from "@/features/localization"
import { useRuntime } from "@/features/runtime/useRuntime"
import type { IntegrationId } from "@/lib/contracts"
import { cn } from "@/lib/utils"

const integrationLabelKeys: Readonly<Record<IntegrationId, TranslationKey>> = {
  codex: "integration.codex",
  git: "integration.git",
  live2d: "integration.live2d",
  history: "integration.history",
}

function LoadingFoundation() {
  const { t } = useI18n()

  return (
    <div className="flex flex-col gap-md" role="status">
      <p className="m-0 text-body text-muted-foreground">
        {t("foundation.loading")}
      </p>
      <div className="flex flex-col gap-sm" aria-hidden="true">
        <Skeleton className="h-[18px] w-2/3" />
        <Skeleton className="h-[18px] w-full" />
        <Skeleton className="h-[18px] w-5/6" />
      </div>
    </div>
  )
}

function LocaleSwitcher() {
  const { locale, setLocale, t } = useI18n()
  const [failedLocale, setFailedLocale] = useState<SupportedLocale | null>(null)

  const persistLocale = (nextLocale: SupportedLocale) => {
    if (setLocale(nextLocale)) {
      setFailedLocale(null)
      return
    }

    setFailedLocale(nextLocale)
  }

  return (
    <div className="flex max-w-[20rem] flex-col items-end gap-xs">
      <div
        aria-label={t("locale.switchLabel")}
        className="flex flex-wrap items-center justify-end gap-xs"
        role="group"
      >
        {(["ja", "en"] as const).map((option) => (
          <Button
            aria-pressed={locale === option}
            key={option}
            onClick={() => persistLocale(option)}
            size="xs"
            type="button"
            variant={locale === option ? "secondary" : "ghost"}
          >
            {t(`locale.${option}`)}
          </Button>
        ))}
      </div>

      {failedLocale === null ? null : (
        <div
          aria-live="assertive"
          className="flex flex-wrap items-center justify-end gap-xs text-end"
        >
          <p className="m-0 text-caption text-destructive">
            {t("locale.saveError")}
          </p>
          <Button
            onClick={() => persistLocale(failedLocale)}
            size="xs"
            type="button"
            variant="secondary"
          >
            {t("action.retry")}
          </Button>
        </div>
      )}
    </div>
  )
}

export function FoundationShell() {
  const { t } = useI18n()
  const { refresh, state, transportKind } = useRuntime()

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-xl">
      <section
        aria-labelledby="foundation-heading"
        className="flex w-full max-w-[36rem] flex-col gap-lg"
      >
        <header className="flex flex-wrap items-start justify-between gap-md">
          <div className="flex flex-col gap-xxs">
            <p className="m-0 text-caption text-muted-foreground">
              {t("app.name")}
            </p>
            <h1
              className="m-0 text-display text-text-strong"
              id="foundation-heading"
            >
              {t("foundation.title")}
            </h1>
          </div>
          <LocaleSwitcher />
        </header>

        <p className="m-0 max-w-[70ch] text-body text-foreground">
          {t("foundation.description")}
        </p>

        <Separator />

        {state.status === "loading" ? <LoadingFoundation /> : null}

        {state.status === "error" ? (
          <div aria-live="assertive" className="flex flex-col gap-xs">
            <p className="m-0 text-body text-destructive">
              {t("foundation.error")}
            </p>
            <p className="m-0 font-mono text-label text-muted-foreground">
              {state.error.code}
            </p>
            <p className="m-0 text-caption text-muted-foreground">
              {t("foundation.retryHint")}
            </p>
            <div>
              <Button
                onClick={refresh}
                size="xs"
                type="button"
                variant="secondary"
              >
                {t("action.retry")}
              </Button>
            </div>
          </div>
        ) : null}

        {state.status === "ready" ? (
          <div aria-live="polite" className="flex flex-col gap-lg">
            <div className="flex items-start gap-sm">
              <span
                aria-hidden="true"
                className={cn(
                  "mt-1 size-sm shrink-0 border",
                  transportKind === "tauri"
                    ? "rounded-circle border-success bg-success/20"
                    : "rotate-45 rounded-[2px] border-running bg-running/15",
                )}
              />
              <div className="flex flex-col gap-xxs">
                <p className="m-0 text-title text-text-strong">
                  {t("runtime.modeLabel")}:{" "}
                  {t(
                    transportKind === "tauri"
                      ? "runtime.native"
                      : "runtime.demo",
                  )}
                </p>
                <p className="m-0 text-body text-muted-foreground">
                  {t(
                    transportKind === "tauri"
                      ? "runtime.nativeDescription"
                      : "runtime.demoDescription",
                  )}
                </p>
              </div>
            </div>

            <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-lg gap-y-xs text-caption">
              <dt className="text-muted-foreground">
                {t("runtime.versionLabel")}
              </dt>
              <dd className="m-0 font-mono text-foreground">
                {state.metadata.appVersion}
              </dd>
              <dt className="text-muted-foreground">
                {t("runtime.platformLabel")}
              </dt>
              <dd className="m-0 font-mono text-foreground">
                {state.metadata.platform} / {state.metadata.architecture}
              </dd>
            </dl>

            <div className="flex flex-col gap-sm">
              <h2 className="m-0 text-title text-text-strong">
                {t("runtime.integrationsLabel")}
              </h2>
              <ul className="m-0 grid list-none gap-xs p-0 sm:grid-cols-2">
                {(
                  Object.entries(state.metadata.integrations) as [
                    IntegrationId,
                    "not_configured",
                  ][]
                ).map(([integration]) => (
                  <li
                    className="flex items-center justify-between gap-md border-b border-divider py-xs text-caption"
                    key={integration}
                  >
                    <span>{t(integrationLabelKeys[integration])}</span>
                    <span className="text-muted-foreground">
                      {t("runtime.notConfigured")}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}
      </section>
    </main>
  )
}
