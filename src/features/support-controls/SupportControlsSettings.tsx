import { useEffect, useMemo, useSyncExternalStore } from "react"
import { AlertTriangleIcon, RefreshCwIcon, ShieldCheckIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { useI18n, type SupportedLocale } from "@/features/localization"
import { SupportControlsController } from "@/features/support-controls/controller"
import type {
  SupportControlSnapshotV1,
  SupportEffectiveState,
  SupportOutcomeStatus,
  SupportReadinessStatus,
  SupportTrigger,
} from "@/features/support-controls/contracts"
import {
  createSupportControlsGateway,
  type SupportControlsGateway,
  type SupportControlsGatewayKind,
} from "@/features/support-controls/transport"

interface SupportCopy {
  readonly title: string
  readonly intro: string
  readonly global: string
  readonly globalDescription: string
  readonly commit: string
  readonly commitDescription: string
  readonly desired: string
  readonly effective: string
  readonly states: Readonly<Record<SupportEffectiveState, string>>
  readonly readiness: Readonly<Record<SupportReadinessStatus, string>>
  readonly fallbackTitle: string
  readonly fallbackBody: string
  readonly disabledBody: string
  readonly errorTitle: string
  readonly retry: string
  readonly refresh: string
  readonly loading: string
  readonly saving: string
  readonly identityTitle: string
  readonly approvedIdentity: string
  readonly observedIdentity: string
  readonly schema: string
  readonly notObserved: string
  readonly skill: string
  readonly capacityTitle: string
  readonly active: string
  readonly queued: string
  readonly taskUsage: string
  readonly attempted: string
  readonly started: string
  readonly generated: string
  readonly failed: string
  readonly canceled: string
  readonly unavailable: string
  readonly tokenUsage: string
  readonly latency: string
  readonly auditTitle: string
  readonly model: string
  readonly permission: string
  readonly limits: string
  readonly rawHistory: string
  readonly never: string
  readonly latest: string
  readonly none: string
  readonly outcomes: Readonly<Record<SupportOutcomeStatus, string>>
  readonly triggers: Readonly<Record<SupportTrigger, string>>
  readonly demo: string
  readonly native: string
}

const copy: Readonly<Record<SupportedLocale, SupportCopy>> = {
  en: {
    title: "Support",
    intro:
      "Control the isolated commit explainer and inspect the exact safety gate. Main coding turns never depend on this service.",
    global: "Enable isolated support",
    globalDescription:
      "Allows implemented support roles only when the pinned Codex identity and bundled skill are approved.",
    commit: "Commit explainer",
    commitDescription:
      "Explains verified commits from redacted evidence. Turning it off cancels queued and active explanation jobs without stopping the main turn.",
    desired: "Saved preference",
    effective: "Effective state",
    states: {
      enabled: "Enabled",
      user_disabled: "Disabled globally",
      role_disabled: "Commit explainer disabled",
      release_blocked: "Release blocked",
      settings_recovery: "Settings recovery",
    },
    readiness: {
      approved: "Approved",
      blocked: "Blocked",
      unavailable: "Unavailable",
    },
    fallbackTitle: "Deterministic fallback is active",
    fallbackBody:
      "The observed runtime is not approved, so no support process or model request is started. Commit evidence and the main turn remain available.",
    disabledBody:
      "Support is disabled by your saved preference. New jobs are not invoked; the main turn is unchanged.",
    errorTitle: "Support settings were not updated",
    retry: "Retry",
    refresh: "Refresh status",
    loading: "Loading support controls",
    saving: "Saving and stopping affected jobs…",
    identityTitle: "Release identity",
    approvedIdentity: "Approved CLI / binary",
    observedIdentity: "Observed CLI / binary",
    schema: "Schema fingerprint",
    notObserved: "Not observed",
    skill: "Bundled skill",
    capacityTitle: "Capacity & usage",
    active: "Active",
    queued: "Queued",
    taskUsage: "Tasks",
    attempted: "attempted",
    started: "started",
    generated: "generated",
    failed: "failed",
    canceled: "canceled",
    unavailable: "unavailable",
    tokenUsage: "Tokens",
    latency: "Total latency",
    auditTitle: "Policy audit",
    model: "Model / effort",
    permission: "Permission profile",
    limits: "Limits",
    rawHistory: "Raw support transcript",
    never: "Never persisted",
    latest: "Latest outcome",
    none: "No invocation recorded",
    outcomes: {
      generated: "Generated",
      failed: "Failed",
      canceled: "Canceled",
      unavailable: "Unavailable",
    },
    triggers: {
      auto_verified_commit: "Verified commit",
      user_request: "User request",
      user_retry: "User retry",
    },
    demo: "Demo memory",
    native: "Native settings",
  },
  ja: {
    title: "支援",
    intro:
      "分離されたコミット説明の動作と安全gateを管理します。main coding turnはこのserviceに依存しません。",
    global: "分離支援を有効化",
    globalDescription:
      "固定されたCodex identityと同梱skillが承認済みの場合だけ、実装済みの支援roleを許可します。",
    commit: "コミット説明",
    commitDescription:
      "redacted evidenceから検証済みcommitを説明します。offにすると待機中・実行中の説明jobを停止し、main turnは継続します。",
    desired: "保存済み希望値",
    effective: "実効状態",
    states: {
      enabled: "有効",
      user_disabled: "全体を無効化",
      role_disabled: "コミット説明を無効化",
      release_blocked: "release未承認",
      settings_recovery: "設定の復旧が必要",
    },
    readiness: {
      approved: "承認済み",
      blocked: "ブロック中",
      unavailable: "利用不可",
    },
    fallbackTitle: "決定的fallbackを使用中",
    fallbackBody:
      "観測したruntimeが未承認のため、支援processもmodel requestも起動しません。commit evidenceとmain turnは引き続き利用できます。",
    disabledBody:
      "保存済み設定で支援を無効化しています。新しいjobは起動せず、main turnには影響しません。",
    errorTitle: "支援設定を更新できませんでした",
    retry: "再試行",
    refresh: "状態を更新",
    loading: "支援設定を読込中",
    saving: "保存し、対象jobを停止しています…",
    identityTitle: "release identity",
    approvedIdentity: "承認CLI / binary",
    observedIdentity: "観測CLI / binary",
    schema: "schema fingerprint",
    notObserved: "未観測",
    skill: "同梱skill",
    capacityTitle: "capacityと利用量",
    active: "実行中",
    queued: "待機中",
    taskUsage: "task",
    attempted: "試行",
    started: "開始",
    generated: "生成完了",
    failed: "失敗",
    canceled: "キャンセル",
    unavailable: "利用不可",
    tokenUsage: "token",
    latency: "合計latency",
    auditTitle: "policy監査",
    model: "model / effort",
    permission: "permission profile",
    limits: "上限",
    rawHistory: "支援の入出力本文",
    never: "永続化しない",
    latest: "直近の結果",
    none: "実行記録はありません",
    outcomes: {
      generated: "生成完了",
      failed: "失敗",
      canceled: "キャンセル",
      unavailable: "利用不可",
    },
    triggers: {
      auto_verified_commit: "検証済みcommit",
      user_request: "利用者の要求",
      user_retry: "利用者の再試行",
    },
    demo: "デモ用メモリ",
    native: "native設定",
  },
}

export interface SupportControlsSettingsProps {
  readonly gatewayKind: SupportControlsGatewayKind
  readonly gateway?: SupportControlsGateway
}

function SettingRow({
  action,
  description,
  label,
}: {
  readonly action: React.ReactNode
  readonly description: string
  readonly label: string
}) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-xl border-b border-divider py-md max-[700px]:flex-col max-[700px]:gap-sm">
      <div className="flex min-w-0 max-w-[65ch] flex-col gap-xxs">
        <span className="text-title text-text-strong">{label}</span>
        <span className="text-pretty break-words text-caption text-muted-foreground">
          {description}
        </span>
      </div>
      <div className="max-w-full shrink-0 max-[700px]:shrink">{action}</div>
    </div>
  )
}

function DetailRows({ children }: { readonly children: React.ReactNode }) {
  return (
    <dl className="m-0 grid min-w-0 grid-cols-[minmax(9rem,max-content)_minmax(0,1fr)] gap-x-xl gap-y-xs text-caption max-[520px]:grid-cols-1 max-[520px]:gap-y-xxs [&_dd]:mb-xs [&_dd]:ml-0 [&_dd]:min-w-0 [&_dt]:text-muted-foreground">
      {children}
    </dl>
  )
}

function identity(
  version: string | null,
  hash: string | null,
  empty: string,
): string {
  return version === null || hash === null ? empty : `${version} · ${hash}`
}

function LoadingState({ text }: { readonly text: string }) {
  return (
    <div className="flex flex-col gap-sm" role="status">
      <span className="text-caption text-muted-foreground">{text}</span>
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-5/6" />
      <Skeleton className="h-24 w-full" />
    </div>
  )
}

function EffectiveBadge({
  snapshot,
  text,
}: {
  readonly snapshot: SupportControlSnapshotV1
  readonly text: SupportCopy
}) {
  const variant = snapshot.effectiveEnabled
    ? "success"
    : snapshot.effectiveState === "settings_recovery"
      ? "destructive"
      : "outline"
  return (
    <Badge
      data-support-effective-state={snapshot.effectiveState}
      variant={variant}
    >
      {text.states[snapshot.effectiveState]}
    </Badge>
  )
}

function SnapshotDetails({
  locale,
  snapshot,
  text,
}: {
  readonly locale: SupportedLocale
  readonly snapshot: SupportControlSnapshotV1
  readonly text: SupportCopy
}) {
  const number = new Intl.NumberFormat(locale === "ja" ? "ja-JP" : "en-US")
  const outcome = snapshot.audit.latestOutcome
  return (
    <>
      <section
        aria-labelledby="support-release-identity"
        className="flex flex-col gap-sm"
      >
        <h3
          className="m-0 text-title text-text-strong"
          id="support-release-identity"
        >
          {text.identityTitle}
        </h3>
        <DetailRows>
          <dt>{text.approvedIdentity}</dt>
          <dd className="truncate font-mono text-label text-foreground">
            {identity(
              snapshot.readiness.approvedCliVersion,
              snapshot.readiness.approvedBinaryHashPrefix,
              text.notObserved,
            )}
          </dd>
          <dt>{text.observedIdentity}</dt>
          <dd className="truncate font-mono text-label text-foreground">
            {identity(
              snapshot.readiness.observedCliVersion,
              snapshot.readiness.observedBinaryHashPrefix,
              text.notObserved,
            )}
          </dd>
          <dt>{text.schema}</dt>
          <dd className="flex min-w-0 flex-wrap items-center gap-xs">
            <Badge
              data-support-readiness={snapshot.readiness.status}
              variant={
                snapshot.readiness.status === "approved" ? "success" : "outline"
              }
            >
              {text.readiness[snapshot.readiness.status]}
            </Badge>
            <code className="truncate font-mono text-label text-foreground">
              {snapshot.readiness.observedSchemaFingerprintPrefix ??
                text.notObserved}
            </code>
          </dd>
          <dt>{text.skill}</dt>
          <dd className="truncate font-mono text-label text-foreground">
            {snapshot.readiness.skillName}
            {snapshot.readiness.skillVersion === null
              ? ""
              : ` · ${snapshot.readiness.skillVersion}`}
            {snapshot.readiness.skillDigestPrefix === null
              ? ""
              : ` · ${snapshot.readiness.skillDigestPrefix}`}
          </dd>
        </DetailRows>
      </section>

      <Separator />

      <section
        aria-labelledby="support-capacity-usage"
        className="flex flex-col gap-sm"
      >
        <h3
          className="m-0 text-title text-text-strong"
          id="support-capacity-usage"
        >
          {text.capacityTitle}
        </h3>
        <DetailRows>
          <dt>{text.active}</dt>
          <dd className="m-0 font-mono text-label text-foreground tabular-nums">
            {snapshot.capacity.active} / {snapshot.capacity.maximumActive}
          </dd>
          <dt>{text.queued}</dt>
          <dd className="m-0 font-mono text-label text-foreground tabular-nums">
            {snapshot.capacity.queued} / {snapshot.capacity.maximumQueued}
          </dd>
          <dt>{text.taskUsage}</dt>
          <dd className="m-0 text-pretty text-foreground tabular-nums">
            {number.format(snapshot.usage.attemptedTasks)} {text.attempted} ·{" "}
            {number.format(snapshot.usage.startedTasks)} {text.started} ·{" "}
            {number.format(snapshot.usage.succeededTasks)} {text.generated} ·{" "}
            {number.format(snapshot.usage.failedTasks)} {text.failed} ·{" "}
            {number.format(snapshot.usage.canceledTasks)} {text.canceled} ·{" "}
            {number.format(snapshot.usage.unavailableTasks)} {text.unavailable}
          </dd>
          <dt>{text.tokenUsage}</dt>
          <dd className="m-0 text-foreground tabular-nums">
            {number.format(snapshot.usage.totalTokens)} total ·{" "}
            {number.format(snapshot.usage.inputTokens)} in ·{" "}
            {number.format(snapshot.usage.outputTokens)} out
          </dd>
          <dt>{text.latency}</dt>
          <dd className="m-0 text-foreground tabular-nums">
            {number.format(snapshot.usage.totalLatencyMs)} ms
          </dd>
        </DetailRows>
      </section>

      <Separator />

      <section
        aria-labelledby="support-policy-audit"
        className="flex flex-col gap-sm"
      >
        <h3
          className="m-0 text-title text-text-strong"
          id="support-policy-audit"
        >
          {text.auditTitle}
        </h3>
        <DetailRows>
          <dt>{text.model}</dt>
          <dd className="font-mono text-label text-foreground">
            {snapshot.audit.modelFamily} · {snapshot.audit.reasoningEffort}
          </dd>
          <dt>{text.permission}</dt>
          <dd className="truncate font-mono text-label text-foreground">
            {snapshot.audit.permissionProfile}
          </dd>
          <dt>{text.limits}</dt>
          <dd className="text-foreground tabular-nums">
            {number.format(snapshot.audit.taskTimeoutMs / 1_000)} s ·{" "}
            {number.format(snapshot.audit.tokenBudget)} tokens
          </dd>
          <dt>{text.rawHistory}</dt>
          <dd className="text-foreground">{text.never}</dd>
          <dt>{text.latest}</dt>
          <dd className="text-pretty text-foreground">
            {outcome === null
              ? text.none
              : `${text.outcomes[outcome.status]} · ${text.triggers[outcome.trigger]}${outcome.errorCode === null ? "" : ` · ${outcome.errorCode}`}`}
          </dd>
        </DetailRows>
      </section>
    </>
  )
}

export function SupportControlsSettings({
  gateway,
  gatewayKind,
}: SupportControlsSettingsProps) {
  const { locale } = useI18n()
  const text = copy[locale]
  const defaultGateway = useMemo(
    () => createSupportControlsGateway(gatewayKind),
    [gatewayKind],
  )
  const controller = useMemo(
    () => new SupportControlsController(gateway ?? defaultGateway),
    [defaultGateway, gateway],
  )
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  )

  useEffect(() => {
    void controller.initialize()
  }, [controller])

  const snapshot = state.snapshot
  const disabled = state.status === "loading" || state.status === "saving"
  return (
    <section
      aria-labelledby="settings-support-title"
      className="flex flex-col gap-lg"
      data-support-controls={gatewayKind}
    >
      <div className="flex min-w-0 items-start justify-between gap-md max-[520px]:flex-col">
        <div className="flex min-w-0 max-w-[70ch] flex-col gap-xxs">
          <h2
            className="m-0 text-balance text-headline text-text-strong"
            id="settings-support-title"
          >
            {text.title}
          </h2>
          <p className="m-0 text-pretty text-caption text-muted-foreground">
            {text.intro}
          </p>
        </div>
        {snapshot === null ? null : (
          <EffectiveBadge snapshot={snapshot} text={text} />
        )}
      </div>

      {state.status === "error" ? (
        <Alert data-support-error="true">
          <AlertTriangleIcon aria-hidden="true" className="text-destructive" />
          <AlertTitle>{text.errorTitle}</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-xs">
            <code className="break-all font-mono text-label text-destructive">
              {state.errorCode}
            </code>
            <Button
              onClick={() => void controller.refresh()}
              size="xs"
              type="button"
              variant="secondary"
            >
              {text.retry}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {snapshot === null && state.status !== "error" ? (
        <LoadingState text={text.loading} />
      ) : snapshot === null ? null : (
        <>
          <div
            aria-live="polite"
            className="flex min-w-0 flex-wrap items-center gap-xs text-caption text-muted-foreground"
            role="status"
          >
            <ShieldCheckIcon aria-hidden="true" className="size-3" />
            <span>
              {text.effective}: {text.states[snapshot.effectiveState]}
            </span>
            <span aria-hidden="true">·</span>
            <span>
              {snapshot.persistence === "native" ? text.native : text.demo} · v
              {snapshot.settings.version}
            </span>
            {state.status === "saving" ? <span>{text.saving}</span> : null}
          </div>

          {!snapshot.effectiveEnabled ? (
            <Alert
              data-support-fallback={snapshot.fallbackReasonCode ?? "unknown"}
            >
              <AlertTriangleIcon aria-hidden="true" />
              <AlertTitle>{text.fallbackTitle}</AlertTitle>
              <AlertDescription className="flex flex-col gap-xxs">
                <span className="text-pretty">
                  {snapshot.effectiveState === "release_blocked" ||
                  snapshot.effectiveState === "settings_recovery"
                    ? text.fallbackBody
                    : text.disabledBody}
                </span>
                <code className="break-all font-mono text-label text-foreground">
                  {snapshot.fallbackReasonCode}
                </code>
              </AlertDescription>
            </Alert>
          ) : null}

          <div aria-label={text.desired} role="group">
            <SettingRow
              action={
                <Switch
                  aria-label={text.global}
                  checked={snapshot.settings.globalEnabled}
                  disabled={disabled}
                  onCheckedChange={(globalEnabled) => {
                    void controller.update({ globalEnabled })
                  }}
                />
              }
              description={text.globalDescription}
              label={text.global}
            />
            <SettingRow
              action={
                <Switch
                  aria-label={text.commit}
                  checked={snapshot.settings.commitExplainerEnabled}
                  disabled={disabled}
                  onCheckedChange={(commitExplainerEnabled) => {
                    void controller.update({ commitExplainerEnabled })
                  }}
                />
              }
              description={text.commitDescription}
              label={text.commit}
            />
          </div>

          <SnapshotDetails locale={locale} snapshot={snapshot} text={text} />

          <div className="flex justify-end">
            <Button
              disabled={disabled}
              onClick={() => void controller.refresh()}
              size="xs"
              type="button"
              variant="secondary"
            >
              <RefreshCwIcon aria-hidden="true" />
              {text.refresh}
            </Button>
          </div>
        </>
      )}
    </section>
  )
}
