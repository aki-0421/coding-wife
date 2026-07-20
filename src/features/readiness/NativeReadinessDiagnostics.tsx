import {
  AlertCircleIcon,
  CheckCircle2Icon,
  CopyIcon,
  RefreshCwIcon,
} from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import {
  readinessCheckIds,
  type ReadinessStatus,
} from "@/features/readiness/contracts"
import {
  useNativeReadiness,
  useNativeReadinessController,
} from "@/features/readiness/hooks"
import { useI18n } from "@/features/localization"
import type { SupportedLocale } from "@/features/localization/types"
import { cn } from "@/lib/utils"

const diagnosticsCopy = {
  en: {
    title: "Diagnostics",
    description:
      "One native snapshot verifies the app and every local integration without exposing private paths or process output.",
    recheck: "Recheck",
    checking: "Checking…",
    copy: "Copy safe summary",
    copying: "Copying…",
    copied: "Safe summary copied.",
    copyFailed: "The safe summary could not be copied.",
    recheckComplete: "Diagnostics updated.",
    recheckAttention:
      "Diagnostics updated. One or more capabilities are blocked or unavailable.",
    recheckFailed: "Diagnostics could not be updated.",
    retained:
      "Recheck failed. The previous snapshot remains visible and is marked stale.",
    unavailable: "Native readiness could not be loaded.",
    snapshot: "Snapshot",
    checkedAt: "Checked",
    source: "Source",
    native: "Native desktop",
    demo: "Demo preview · no native readiness",
    safeCode: "Safe code",
    criticalTitle: "Some local capabilities need attention",
    criticalBody:
      "Only the affected capability is blocked. Other workspaces and settings remain available.",
    checks: {
      os_app: "OS, app & schema",
      codex: "Codex",
      git: "Git & active repository",
      history: "Workspace history",
      live2d: "Live2D resources",
      preferences: "App preferences",
    },
    statuses: {
      ready: "Ready",
      warning: "Warning",
      blocked: "Blocked",
      unavailable: "Unavailable",
    },
    facts: {
      platform: "Platform",
      architecture: "Architecture",
      os_version: "OS version",
      app_version: "App version",
      build_profile: "Build",
      readiness_schema: "Readiness schema",
      codex_binary: "Trusted Codex binary",
      codex_model: "Fixed model",
      codex_auth: "Authentication",
      codex_schema: "Protocol schema",
      codex_efforts: "Reasoning efforts",
      git_executable: "Git executable",
      repository_health: "Active repository",
      repository_identity: "Repository identity",
      repository_head: "Observed HEAD",
      repository_branch: "Observed branch",
      history_schema: "History schema",
      history_mode: "Database mode",
      history_integrity: "Integrity",
      history_writability: "Writability",
      history_writer: "Writer",
      history_migration: "Migration",
      history_backup: "Recovery backup",
      live2d_core: "Cubism Core",
      builtin_resources: "Built-in Hiyori",
      character_library: "Model library",
      character_schema: "Character schema",
      preferences_schema: "Preferences schema",
    },
    recovery: {
      none: "No action required.",
      recheck: "Retry this check after the local service is available.",
      install_codex: "Install a trusted Codex CLI, then recheck.",
      authenticate_codex: "Sign in to Codex locally, then recheck.",
      update_codex:
        "Update Codex so the fixed model and protocol schema are available.",
      select_workspace: "Select a Git workspace to verify its repository.",
      repair_workspace: "Repair or reselect the affected workspace.",
      repair_history: "Use workspace recovery before relying on local history.",
      restore_live2d: "Restore the bundled Live2D app resources.",
      save_preferences:
        "Retry saving the language in General to create or repair the native record.",
    },
  },
  ja: {
    title: "診断",
    description:
      "単一のネイティブスナップショットで、非公開パスやプロセス出力を表示せずにアプリとローカル連携を検証します。",
    recheck: "再確認",
    checking: "確認中…",
    copy: "安全な概要をコピー",
    copying: "コピー中…",
    copied: "安全な概要をコピーしました。",
    copyFailed: "安全な概要をコピーできませんでした。",
    recheckComplete: "診断を更新しました。",
    recheckAttention:
      "診断を更新しました。停止中または利用不可の機能があります。",
    recheckFailed: "診断を更新できませんでした。",
    retained:
      "再確認に失敗しました。直前のスナップショットを古い結果として表示しています。",
    unavailable: "ネイティブ準備状況を取得できませんでした。",
    snapshot: "スナップショット",
    checkedAt: "確認日時",
    source: "取得元",
    native: "ネイティブデスクトップ",
    demo: "デモプレビュー · ネイティブ準備状況なし",
    safeCode: "安全コード",
    criticalTitle: "確認が必要なローカル機能があります",
    criticalBody:
      "影響する機能だけを停止しています。他のワークスペースと設定は引き続き利用できます。",
    checks: {
      os_app: "OS・アプリ・スキーマ",
      codex: "Codex",
      git: "Git・選択中リポジトリ",
      history: "ワークスペース履歴",
      live2d: "Live2Dリソース",
      preferences: "アプリ設定",
    },
    statuses: {
      ready: "準備完了",
      warning: "注意",
      blocked: "停止中",
      unavailable: "利用不可",
    },
    facts: {
      platform: "プラットフォーム",
      architecture: "アーキテクチャ",
      os_version: "OSバージョン",
      app_version: "アプリバージョン",
      build_profile: "ビルド",
      readiness_schema: "診断スキーマ",
      codex_binary: "信頼済みCodexバイナリ",
      codex_model: "固定モデル",
      codex_auth: "認証",
      codex_schema: "プロトコルスキーマ",
      codex_efforts: "推論強度",
      git_executable: "Git実行環境",
      repository_health: "選択中リポジトリ",
      repository_identity: "リポジトリ識別情報",
      repository_head: "確認済みHEAD",
      repository_branch: "確認済みブランチ",
      history_schema: "履歴スキーマ",
      history_mode: "データベースモード",
      history_integrity: "整合性",
      history_writability: "書き込み可否",
      history_writer: "ライター",
      history_migration: "マイグレーション",
      history_backup: "復旧バックアップ",
      live2d_core: "Cubism Core",
      builtin_resources: "内蔵Hiyori",
      character_library: "モデルライブラリ",
      character_schema: "キャラクタースキーマ",
      preferences_schema: "設定スキーマ",
    },
    recovery: {
      none: "操作は不要です。",
      recheck: "ローカルサービスの復旧後に再確認してください。",
      install_codex:
        "信頼できるCodex CLIをインストールして再確認してください。",
      authenticate_codex: "ローカルでCodexへログインして再確認してください。",
      update_codex:
        "固定モデルと対応スキーマを利用できるCodexへ更新してください。",
      select_workspace:
        "Gitワークスペースを選択してリポジトリを検証してください。",
      repair_workspace:
        "影響するワークスペースを修復または再選択してください。",
      repair_history:
        "ローカル履歴を使う前にワークスペースを復旧してください。",
      restore_live2d: "アプリ同梱のLive2Dリソースを復元してください。",
      save_preferences:
        "一般で言語の保存を再試行し、ネイティブ記録を作成または修復してください。",
    },
  },
} as const

function copyFor(locale: SupportedLocale) {
  return diagnosticsCopy[locale]
}

export function readinessStatusLabel(
  locale: SupportedLocale,
  status: ReadinessStatus,
): string {
  return copyFor(locale).statuses[status]
}

export function ReadinessStatusBadge({
  locale,
  status,
  stale = false,
}: {
  readonly locale: SupportedLocale
  readonly status: ReadinessStatus
  readonly stale?: boolean
}) {
  const variant =
    status === "ready"
      ? "success"
      : status === "warning"
        ? "running"
        : status === "blocked"
          ? "destructive"
          : "outline"
  return (
    <Badge data-readiness-status={status} data-stale={stale} variant={variant}>
      {readinessStatusLabel(locale, status)}
    </Badge>
  )
}

function DiagnosticsSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col border-y border-divider">
      {readinessCheckIds.map((id) => (
        <div
          className="flex items-center justify-between gap-md py-md"
          key={id}
        >
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-5 w-20" />
        </div>
      ))}
    </div>
  )
}

function formattedDate(locale: SupportedLocale, value: string): string {
  try {
    return new Intl.DateTimeFormat(locale === "ja" ? "ja-JP" : "en-US", {
      dateStyle: "medium",
      timeStyle: "medium",
    }).format(new Date(value))
  } catch {
    return value
  }
}

export function NativeReadinessDiagnostics() {
  const { locale } = useI18n()
  const ui = copyFor(locale)
  const state = useNativeReadiness()
  const controller = useNativeReadinessController()
  const snapshot = state.snapshot
  const busy = state.status === "loading" || state.status === "rechecking"
  const stale = state.status === "rechecking" || state.status === "error"
  const critical =
    snapshot?.checks.some(
      (check) => check.status === "blocked" || check.status === "unavailable",
    ) ?? false
  const copyAnnouncement =
    state.copyStatus === "copied"
      ? ui.copied
      : state.copyStatus === "error"
        ? ui.copyFailed
        : ""
  const recheckAnnouncement =
    state.recheckOutcome === "complete" || state.recheckOutcome === "attention"
      ? ui.recheckComplete
      : state.recheckOutcome === "failed"
        ? ui.recheckFailed
        : ""
  const attentionAnnouncement =
    state.recheckOutcome === "attention" ? ui.recheckAttention : ""

  return (
    <section
      aria-busy={busy}
      className="flex flex-col gap-lg"
      data-native-readiness-state={state.status}
    >
      <div className="flex flex-wrap items-start justify-between gap-md">
        <div className="min-w-0">
          <h2 className="m-0 text-headline text-text-strong">{ui.title}</h2>
          <p className="m-0 mt-xs max-w-[70ch] text-caption text-muted-foreground">
            {ui.description}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-xs">
          <Button
            aria-disabled={snapshot === null || state.copyStatus === "copying"}
            data-diagnostics-copy
            onClick={() => {
              if (snapshot !== null && state.copyStatus !== "copying") {
                void controller.copy()
              }
            }}
            size="xs"
            type="button"
            variant="outline"
          >
            <CopyIcon aria-hidden="true" />
            {state.copyStatus === "copying" ? ui.copying : ui.copy}
          </Button>
          <Button
            aria-disabled={busy}
            data-diagnostics-recheck
            onClick={() => {
              if (!busy) void controller.recheck()
            }}
            size="xs"
            type="button"
            variant="secondary"
          >
            <RefreshCwIcon
              aria-hidden="true"
              className={cn(busy && "animate-spin motion-reduce:animate-none")}
            />
            {busy ? ui.checking : ui.recheck}
          </Button>
        </div>
      </div>

      <p aria-live="polite" className="sr-only" data-diagnostics-announcement>
        {copyAnnouncement || recheckAnnouncement}
      </p>
      <p
        aria-live="assertive"
        className="sr-only"
        data-diagnostics-attention-announcement
      >
        {attentionAnnouncement}
      </p>

      {state.status === "error" ? (
        <Alert className="border-destructive/40 bg-destructive/10">
          <AlertCircleIcon
            aria-hidden="true"
            className="size-3 text-destructive"
          />
          <AlertTitle>
            {snapshot === null ? ui.unavailable : ui.retained}
          </AlertTitle>
          <AlertDescription className="font-mono text-label">
            {state.errorCode}
          </AlertDescription>
        </Alert>
      ) : null}

      {snapshot === null ? (
        <DiagnosticsSkeleton />
      ) : (
        <>
          <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-lg gap-y-xs text-caption">
            <dt className="text-muted-foreground">{ui.snapshot}</dt>
            <dd className="m-0 break-all font-mono text-label text-foreground">
              {snapshot.snapshotId}
            </dd>
            <dt className="text-muted-foreground">{ui.checkedAt}</dt>
            <dd className="m-0 text-foreground">
              <time dateTime={snapshot.checkedAt}>
                {formattedDate(locale, snapshot.checkedAt)}
              </time>
            </dd>
            <dt className="text-muted-foreground">{ui.source}</dt>
            <dd className="m-0 text-foreground">
              {snapshot.source === "native" ? ui.native : ui.demo}
            </dd>
          </dl>

          {critical ? (
            <Alert className="border-destructive/40 bg-destructive/10">
              <AlertCircleIcon
                aria-hidden="true"
                className="size-3 text-destructive"
              />
              <AlertTitle>{ui.criticalTitle}</AlertTitle>
              <AlertDescription>{ui.criticalBody}</AlertDescription>
            </Alert>
          ) : null}

          <div className="flex flex-col border-y border-divider">
            {snapshot.checks.map((item) => (
              <article
                className="border-b border-divider py-md last:border-b-0"
                data-readiness-check={item.id}
                key={item.id}
              >
                <div className="flex items-start justify-between gap-md">
                  <div className="flex min-w-0 items-center gap-xs text-title text-text-strong">
                    {item.status === "ready" ? (
                      <CheckCircle2Icon
                        aria-hidden="true"
                        className="size-3 shrink-0 text-success"
                      />
                    ) : (
                      <AlertCircleIcon
                        aria-hidden="true"
                        className="size-3 shrink-0 text-muted-foreground"
                      />
                    )}
                    <h3 className="m-0 text-title">{ui.checks[item.id]}</h3>
                  </div>
                  <ReadinessStatusBadge
                    locale={locale}
                    stale={stale}
                    status={item.status}
                  />
                </div>
                <dl className="m-0 mt-sm grid grid-cols-[minmax(9rem,max-content)_minmax(0,1fr)] gap-x-lg gap-y-xxs text-label">
                  {item.facts.map((itemFact) => (
                    <div className="contents" key={itemFact.key}>
                      <dt className="text-muted-foreground">
                        {ui.facts[itemFact.key]}
                      </dt>
                      <dd className="m-0 break-all font-mono text-foreground">
                        {itemFact.value}
                      </dd>
                    </div>
                  ))}
                  <dt className="text-muted-foreground">{ui.safeCode}</dt>
                  <dd className="m-0 break-all font-mono text-foreground">
                    {item.code}
                  </dd>
                </dl>
                {item.recoveryAction !== "none" ? (
                  <p className="m-0 mt-sm text-caption text-muted-foreground">
                    {ui.recovery[item.recoveryAction]}
                  </p>
                ) : null}
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  )
}
