import { useState } from "react"
import {
  AlertCircleIcon,
  CopyIcon,
  FolderGit2Icon,
  FolderPlusIcon,
  GitBranchIcon,
  InfoIcon,
  RefreshCwIcon,
  TerminalIcon,
  type LucideIcon,
  WrenchIcon,
} from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { useI18n } from "@/features/localization"
import type { SupportedLocale } from "@/features/localization/types"
import type {
  NativeReadinessSnapshotV1,
  ReadinessCheckId,
  ReadinessCheckV1,
} from "@/features/readiness/contracts"
import type { NativeReadinessControllerState } from "@/features/readiness/controller"
import { CodexBinaryPathSettings } from "@/features/readiness/CodexBinaryPathSettings"
import {
  useNativeReadiness,
  useNativeReadinessController,
} from "@/features/readiness/hooks"
import { cn } from "@/lib/utils"

const codexInstallCommand = "npm install --global @openai/codex"
const codexLoginCommand = "codex login"
const gitInstallCommand = "xcode-select --install"
const internalSetupCheckIds = [
  "os_app",
  "history",
  "live2d",
  "preferences",
] as const satisfies readonly ReadinessCheckId[]

export type SetupRequirementKey =
  | "codex"
  | "git"
  | "project"
  | "diagnostics"
  | (typeof internalSetupCheckIds)[number]

interface SetupRequirement {
  readonly key: SetupRequirementKey
  readonly check: ReadinessCheckV1 | null
}

interface SetupOverviewProps {
  readonly notice?: {
    readonly message: string
    readonly tone: "error" | "neutral"
  } | null
  readonly onAddProject: () => void
  readonly projectCount: number
}

interface SetupCopy {
  readonly title: string
  readonly remaining: (count: number) => string
  readonly checkingTitle: string
  readonly checkingDescription: string
  readonly unavailableTitle: string
  readonly unavailableDescription: string
  readonly recheck: string
  readonly rechecking: string
  readonly copyCommand: string
  readonly commandCopied: string
  readonly commandCopyFailed: string
  readonly addProject: string
  readonly waitingForGit: string
  readonly items: Readonly<
    Record<
      SetupRequirementKey,
      {
        readonly title: string
        readonly description: string
      }
    >
  >
  readonly codex: {
    readonly install: string
    readonly authenticate: string
    readonly update: string
    readonly reconnect: string
  }
}

const setupCopy: Readonly<Record<SupportedLocale, SetupCopy>> = {
  en: {
    title: "Finish the local setup",
    remaining: (count) => `${count} ${count === 1 ? "item" : "items"} left`,
    checkingTitle: "Checking this Mac",
    checkingDescription:
      "Verifying Codex, Git, and local app resources without sending repository data.",
    unavailableTitle: "The local setup could not be checked",
    unavailableDescription:
      "Retry the native check. Existing files and repository data have not been changed.",
    recheck: "Recheck",
    rechecking: "Checking…",
    copyCommand: "Copy command",
    commandCopied: "Command copied",
    commandCopyFailed: "The command could not be copied.",
    addProject: "Choose project folder…",
    waitingForGit: "Install Git before choosing a project folder.",
    items: {
      codex: {
        title: "Prepare Codex CLI",
        description:
          "Coding Wife uses your local Codex sign-in and a compatible App Server runtime.",
      },
      git: {
        title: "Install Git",
        description:
          "Git is required to inspect repositories and create isolated worktrees for each workspace.",
      },
      project: {
        title: "Add your first project",
        description:
          "Choose a local folder. Missing Git initialization or GitHub origin setup continues in the next step.",
      },
      diagnostics: {
        title: "Restore local diagnostics",
        description:
          "The app could not verify its local prerequisites. Retry before starting a workspace.",
      },
      os_app: {
        title: "Use a supported Mac",
        description:
          "Coding Wife currently requires macOS 14 or later on Apple silicon.",
      },
      history: {
        title: "Repair workspace history",
        description:
          "Local history is not writable or its integrity check needs recovery.",
      },
      live2d: {
        title: "Restore app resources",
        description:
          "The bundled Live2D runtime or character resources could not be verified.",
      },
      preferences: {
        title: "Repair app settings",
        description:
          "The native preferences record could not be loaded safely.",
      },
    },
    codex: {
      install: "Install the trusted Codex CLI, then run the check again.",
      authenticate: "Sign in with ChatGPT in the browser, then return here.",
      update:
        "Install the current Codex CLI so the required model and protocol are available.",
      reconnect:
        "Codex is installed but could not be verified. Run the check again.",
    },
  },
  ja: {
    title: "ローカル環境の準備を完了する",
    remaining: (count) => `残り${count}件`,
    checkingTitle: "このMacを確認しています",
    checkingDescription:
      "リポジトリのデータを送信せず、Codex、Git、アプリ内リソースを確認します。",
    unavailableTitle: "ローカル環境を確認できませんでした",
    unavailableDescription:
      "ネイティブ診断を再実行してください。既存のファイルやリポジトリは変更されていません。",
    recheck: "再確認",
    rechecking: "確認中…",
    copyCommand: "コマンドをコピー",
    commandCopied: "コピーしました",
    commandCopyFailed: "コマンドをコピーできませんでした。",
    addProject: "プロジェクトフォルダを選択…",
    waitingForGit: "Gitをインストールしてからプロジェクトを選択してください。",
    items: {
      codex: {
        title: "Codex CLIを準備",
        description:
          "Coding WifeはローカルのCodexログインと互換性のあるApp Serverを利用します。",
      },
      git: {
        title: "Gitをインストール",
        description:
          "リポジトリの確認と、ワークスペースごとの分離されたworktree作成にGitが必要です。",
      },
      project: {
        title: "最初のプロジェクトを追加",
        description:
          "ローカルフォルダを選択します。Git初期化やGitHub originが必要な場合は次の画面で設定します。",
      },
      diagnostics: {
        title: "ローカル診断を復旧",
        description:
          "アプリの前提環境を確認できませんでした。ワークスペースを始める前に再確認してください。",
      },
      os_app: {
        title: "対応するMacを使用",
        description:
          "Coding Wifeは現在、Apple Silicon搭載のmacOS 14以降に対応しています。",
      },
      history: {
        title: "ワークスペース履歴を復旧",
        description: "ローカル履歴へ書き込めないか、整合性の復旧が必要です。",
      },
      live2d: {
        title: "アプリ内リソースを復元",
        description:
          "同梱Live2Dランタイムまたはキャラクターリソースを確認できませんでした。",
      },
      preferences: {
        title: "アプリ設定を復旧",
        description: "ネイティブ設定レコードを安全に読み込めませんでした。",
      },
    },
    codex: {
      install: "信頼できるCodex CLIをインストールしてから再確認します。",
      authenticate:
        "ブラウザでChatGPTへサインインし、この画面へ戻ってください。",
      update:
        "必要なモデルとプロトコルを利用できる最新のCodex CLIをインストールします。",
      reconnect:
        "Codexは見つかりましたが確認できませんでした。診断を再実行してください。",
    },
  },
}

function checkById(
  snapshot: NativeReadinessSnapshotV1 | null,
  id: ReadinessCheckId,
): ReadinessCheckV1 | null {
  return snapshot?.checks.find((check) => check.id === id) ?? null
}

function gitExecutableIsReady(check: ReadinessCheckV1 | null): boolean {
  if (check === null) return false
  const fact = check.facts.find((item) => item.key === "git_executable")
  return (
    fact?.value === "available" ||
    (fact === undefined && check.status === "ready")
  )
}

export function unresolvedSetupRequirements(
  snapshot: NativeReadinessSnapshotV1 | null,
  projectCount: number,
): readonly SetupRequirement[] {
  if (snapshot === null) {
    return [
      { key: "diagnostics", check: null },
      ...(projectCount === 0
        ? ([{ key: "project", check: null }] as const)
        : []),
    ]
  }

  const requirements: SetupRequirement[] = []
  const codex = checkById(snapshot, "codex")
  const git = checkById(snapshot, "git")
  if (codex === null || codex.status !== "ready") {
    requirements.push({ key: "codex", check: codex })
  }
  if (!gitExecutableIsReady(git)) {
    requirements.push({ key: "git", check: git })
  }
  if (projectCount === 0) {
    requirements.push({ key: "project", check: null })
  }
  for (const id of internalSetupCheckIds) {
    const item = checkById(snapshot, id)
    if (
      item !== null &&
      (item.status === "blocked" || item.status === "unavailable")
    ) {
      requirements.push({ key: id, check: item })
    }
  }
  return requirements
}

export function shouldShowSetupOverview(
  hydrationMode: "demo" | "native" | undefined,
  state: NativeReadinessControllerState,
  projectCount: number,
): boolean {
  if (hydrationMode !== "native") return false
  if (state.snapshot?.source === "demo") return false
  if (projectCount === 0) return true
  if (state.snapshot !== null) {
    return unresolvedSetupRequirements(state.snapshot, projectCount).length > 0
  }
  return state.status === "error"
}

function codexRecovery(
  copy: SetupCopy,
  check: ReadinessCheckV1 | null,
): { readonly description: string; readonly command: string | null } {
  if (check?.recoveryAction === "install_codex") {
    return { description: copy.codex.install, command: codexInstallCommand }
  }
  if (check?.recoveryAction === "authenticate_codex") {
    return { description: copy.codex.authenticate, command: codexLoginCommand }
  }
  if (check?.recoveryAction === "update_codex") {
    return { description: copy.codex.update, command: codexInstallCommand }
  }
  return { description: copy.codex.reconnect, command: null }
}

function requirementCommand(
  copy: SetupCopy,
  requirement: SetupRequirement,
): string | null {
  if (requirement.key === "git") return gitInstallCommand
  if (requirement.key === "codex") {
    return codexRecovery(copy, requirement.check).command
  }
  return null
}

function requirementIcon(key: SetupRequirementKey): LucideIcon {
  if (key === "codex") return TerminalIcon
  if (key === "git") return GitBranchIcon
  if (key === "project") return FolderGit2Icon
  if (key === "diagnostics") return AlertCircleIcon
  return WrenchIcon
}

function SetupSkeleton({ copy }: { readonly copy: SetupCopy }) {
  return (
    <div
      aria-live="polite"
      className="flex flex-col gap-lg rounded-composer border border-divider bg-surface p-xl"
      role="status"
    >
      <div className="flex items-start gap-md">
        <Skeleton className="size-8 shrink-0 rounded-control" />
        <div className="flex flex-1 flex-col gap-xs">
          <span className="text-headline text-text-strong">
            {copy.checkingTitle}
          </span>
          <span className="max-w-[70ch] text-pretty text-caption text-muted-foreground">
            {copy.checkingDescription}
          </span>
        </div>
      </div>
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-14 w-full" />
    </div>
  )
}

export function SetupOverview({
  notice = null,
  onAddProject,
  projectCount,
}: SetupOverviewProps) {
  const { locale } = useI18n()
  const copy = setupCopy[locale]
  const state = useNativeReadiness()
  const controller = useNativeReadinessController()
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null)
  const [copyErrorCommand, setCopyErrorCommand] = useState<string | null>(null)
  const snapshot = state.snapshot
  const requirements = unresolvedSetupRequirements(snapshot, projectCount)
  const firstRequirement = requirements[0]
  const focusGlobalRecheck =
    firstRequirement !== undefined &&
    firstRequirement.key !== "project" &&
    requirementCommand(copy, firstRequirement) === null
  const gitReady = gitExecutableIsReady(checkById(snapshot, "git"))
  const rechecking =
    state.status === "loading" ||
    state.status === "rechecking" ||
    state.status === "configuring"

  const copyToClipboard = async (command: string) => {
    setCopyErrorCommand(null)
    try {
      if (navigator.clipboard === undefined)
        throw new Error("clipboard unavailable")
      await navigator.clipboard.writeText(command)
      setCopiedCommand(command)
    } catch {
      setCopiedCommand(null)
      setCopyErrorCommand(command)
    }
  }

  const recheck = () => {
    if (!rechecking) void controller.recheck()
  }

  return (
    <section
      aria-busy={rechecking}
      className="min-h-dvh w-full overflow-y-auto bg-background px-xl py-2xl max-[640px]:px-md"
      data-setup-overview=""
      data-setup-state={state.status}
    >
      <div className="mx-auto flex min-h-[calc(100dvh-42px)] w-full max-w-[48rem] flex-col justify-center gap-xl py-xl">
        <header>
          <h1 className="m-0 text-balance text-lg font-semibold text-text-strong">
            {copy.title}
          </h1>
        </header>

        {snapshot === null && state.status === "loading" ? (
          <SetupSkeleton copy={copy} />
        ) : (
          <section
            aria-labelledby="setup-remaining-title"
            className="overflow-hidden rounded-composer border border-divider bg-surface"
          >
            <div className="flex items-center justify-between gap-md px-xl py-md">
              <h2
                className="m-0 text-title text-text-strong"
                id="setup-remaining-title"
              >
                {copy.remaining(requirements.length)}
              </h2>
              <Button
                aria-disabled={rechecking}
                autoFocus={focusGlobalRecheck}
                data-setup-recheck=""
                onClick={recheck}
                size="xs"
                type="button"
                variant="ghost"
              >
                <RefreshCwIcon
                  className={cn(
                    rechecking && "animate-spin motion-reduce:animate-none",
                  )}
                  data-icon="inline-start"
                />
                {rechecking ? copy.rechecking : copy.recheck}
              </Button>
            </div>
            <Separator />

            <ol className="m-0 list-none p-0">
              {requirements.map((requirement, index) => {
                const Icon = requirementIcon(requirement.key)
                const itemCopy = copy.items[requirement.key]
                const codex =
                  requirement.key === "codex"
                    ? codexRecovery(copy, requirement.check)
                    : null
                const command = requirementCommand(copy, requirement)
                const description = codex?.description ?? itemCopy.description
                const projectDisabled =
                  requirement.key === "project" && !gitReady

                return (
                  <li
                    data-setup-requirement={requirement.key}
                    key={requirement.key}
                  >
                    <article className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-md px-xl py-lg max-[640px]:grid-cols-[auto_minmax(0,1fr)]">
                      <span
                        aria-hidden="true"
                        className="flex size-8 items-center justify-center rounded-control bg-muted text-foreground"
                      >
                        <Icon className="size-4" />
                      </span>
                      <div className="min-w-0">
                        <h3 className="m-0 text-balance text-headline text-text-strong">
                          {itemCopy.title}
                        </h3>
                        <p className="m-0 mt-xxs max-w-[65ch] text-pretty text-caption text-muted-foreground">
                          {description}
                        </p>
                        {requirement.key === "codex" ? (
                          <CodexBinaryPathSettings compact />
                        ) : null}
                        {command === null ? null : (
                          <>
                            <code className="mt-sm block w-fit max-w-full overflow-x-auto rounded-control bg-code-chip px-sm py-xs font-mono text-label text-foreground">
                              {command}
                            </code>
                            {copyErrorCommand === command ? (
                              <span
                                className="mt-xs block text-caption text-destructive"
                                role="alert"
                              >
                                {copy.commandCopyFailed}
                              </span>
                            ) : null}
                          </>
                        )}
                        {projectDisabled ? (
                          <p className="m-0 mt-xs text-caption text-muted-foreground">
                            {copy.waitingForGit}
                          </p>
                        ) : null}
                        {requirement.check === null ? null : (
                          <span className="sr-only">
                            {requirement.check.code}
                          </span>
                        )}
                      </div>
                      {command !== null || requirement.key === "project" ? (
                        <div className="flex shrink-0 items-center gap-xs max-[640px]:col-start-2 max-[640px]:flex-wrap">
                          {command === null ? null : (
                            <Button
                              autoFocus={index === 0}
                              data-setup-copy-command={requirement.key}
                              onClick={() => void copyToClipboard(command)}
                              size="sm"
                              type="button"
                            >
                              <CopyIcon data-icon="inline-start" />
                              {copiedCommand === command
                                ? copy.commandCopied
                                : copy.copyCommand}
                            </Button>
                          )}
                          {requirement.key === "project" ? (
                            <Button
                              autoFocus={index === 0}
                              data-setup-add-project=""
                              disabled={projectDisabled}
                              onClick={onAddProject}
                              size="sm"
                              type="button"
                            >
                              <FolderPlusIcon data-icon="inline-start" />
                              {copy.addProject}
                            </Button>
                          ) : null}
                        </div>
                      ) : null}
                    </article>
                    {index === requirements.length - 1 ? null : <Separator />}
                  </li>
                )
              })}
            </ol>
          </section>
        )}

        {state.status === "error" ? (
          <Alert className="border-destructive/40 bg-destructive/10">
            <AlertCircleIcon aria-hidden="true" className="text-destructive" />
            <AlertTitle>{copy.unavailableTitle}</AlertTitle>
            <AlertDescription>{copy.unavailableDescription}</AlertDescription>
          </Alert>
        ) : null}

        {notice === null ? null : (
          <Alert
            className={cn(
              notice.tone === "error" &&
                "border-destructive/40 bg-destructive/10",
            )}
            data-setup-notice={notice.tone}
            role={notice.tone === "error" ? "alert" : "status"}
          >
            {notice.tone === "error" ? (
              <AlertCircleIcon
                aria-hidden="true"
                className="text-destructive"
              />
            ) : (
              <InfoIcon aria-hidden="true" className="text-muted-foreground" />
            )}
            <AlertTitle>{notice.message}</AlertTitle>
          </Alert>
        )}

        <p aria-live="polite" className="sr-only" data-setup-announcement="">
          {copiedCommand === null ? "" : copy.commandCopied}
        </p>
      </div>
    </section>
  )
}
