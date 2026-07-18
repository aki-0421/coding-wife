import { useRef, useState } from "react"
import {
  ActivityIcon,
  AlertTriangleIcon,
  BotIcon,
  ChevronDownIcon,
  DatabaseIcon,
  FolderCogIcon,
  HistoryIcon,
  Mic2Icon,
  Settings2Icon,
  ShieldCheckIcon,
  SparklesIcon,
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
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import {
  CharacterModelLibrarySettings,
  getCharacterErrorMessage,
  type CharacterRuntimeView,
} from "@/features/character"
import { useI18n } from "@/features/localization"
import { NarrationSettings } from "@/features/narration"
import {
  checkById,
  NativeReadinessDiagnostics,
  ReadinessStatusBadge,
  useNativeReadiness,
} from "@/features/readiness"
import {
  useAppPreferences,
  useAppPreferencesController,
} from "@/features/preferences"
import { AppPreferencesSettings } from "@/features/workspace-view/AppPreferencesSettings"
import { EditableContextSection } from "@/features/workspace-view/EditableContextSection"
import type { WorkspaceCopy } from "@/features/workspace-view/copy"
import type { EditableWorkspaceContextModel } from "@/features/workspace-view/useEditableWorkspaceContext"
import type { RuntimeState } from "@/features/runtime"
import type {
  SettingsSection,
  WorkspaceAdapterState,
} from "@/features/workspace-view/types"
import { cn } from "@/lib/utils"

interface SettingsViewProps {
  readonly characterRuntime: CharacterRuntimeView
  readonly copy: WorkspaceCopy
  readonly contextModel: EditableWorkspaceContextModel
  readonly history: WorkspaceAdapterState["history"]
  readonly muted: boolean
  readonly runtimeState: RuntimeState
  readonly section: SettingsSection
  readonly turnActive: boolean
  readonly workspaceId: string
  readonly onDeleteHistory: () => Promise<boolean>
  readonly onMutedChange: (muted: boolean) => void
  readonly onResetUi: () => void
  readonly onRetryRuntime: () => void
  readonly onRetryCharacter: () => void
  readonly onSectionChange: (section: SettingsSection) => void
}

function CharacterReadinessBadge({
  copy,
  runtime,
}: Pick<SettingsViewProps, "copy"> & {
  readonly runtime: CharacterRuntimeView
}) {
  const label = {
    loading: copy.settingsView.live2dLoading,
    ready: copy.settingsView.live2dReady,
    recovering: copy.settingsView.live2dRecovering,
    degraded: copy.settingsView.live2dDegraded,
    error: copy.settingsView.live2dError,
    hidden: copy.settingsView.live2dHidden,
    unknown: copy.settingsView.live2dUnknown,
  }[runtime.readiness]
  const variant =
    runtime.readiness === "ready"
      ? "success"
      : runtime.readiness === "loading" || runtime.readiness === "recovering"
        ? "running"
        : runtime.readiness === "error"
          ? "destructive"
          : "outline"

  return (
    <Badge
      data-character-runtime-readiness={runtime.readiness}
      variant={variant}
    >
      {label}
    </Badge>
  )
}

function CharacterRuntimeDetails({
  characterRuntime,
  copy,
  muted,
}: Pick<SettingsViewProps, "characterRuntime" | "copy" | "muted">) {
  const rendererLabel =
    characterRuntime.rendererKind === "builtin_hiyori"
      ? copy.settingsView.builtinRenderer
      : copy.settingsView.externalRenderer
  return (
    <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-lg gap-y-xs text-caption">
      <dt className="text-muted-foreground">{copy.settingsView.renderer}</dt>
      <dd className="m-0 text-foreground">{rendererLabel}</dd>
      {characterRuntime.pack ? (
        <>
          <dt className="text-muted-foreground">
            {copy.settingsView.bundledModel}
          </dt>
          <dd className="m-0 text-foreground">
            {characterRuntime.pack.displayName}
          </dd>
          <dt className="text-muted-foreground">
            {copy.settingsView.bundledVersion}
          </dt>
          <dd className="m-0 font-mono text-foreground">
            {characterRuntime.pack.bundledVersion}
          </dd>
          <dt className="text-muted-foreground">
            {copy.settingsView.illustrationCredit}
          </dt>
          <dd className="m-0 text-foreground">
            {characterRuntime.pack.illustration}
          </dd>
          <dt className="text-muted-foreground">
            {copy.settingsView.modelingCredit}
          </dt>
          <dd className="m-0 text-foreground">
            {characterRuntime.pack.modeling}
          </dd>
          <dt className="text-muted-foreground">
            {copy.settingsView.noticeHash}
          </dt>
          <dd className="m-0 truncate font-mono text-label text-foreground">
            {characterRuntime.pack.noticeSha256}
          </dd>
        </>
      ) : null}
      <dt className="text-muted-foreground">{copy.settingsView.phase}</dt>
      <dd className="m-0 text-foreground">
        {copy.settingsView.characterPhases[characterRuntime.phase]}
      </dd>
      <dt className="text-muted-foreground">{copy.settingsView.fallback}</dt>
      <dd className="m-0 text-foreground">
        {copy.settingsView.characterFallbacks[characterRuntime.fallback]}
      </dd>
      <dt className="text-muted-foreground">
        {copy.settingsView.motionPolicy}
      </dt>
      <dd className="m-0 text-foreground">
        {copy.settingsView.characterPolicies[characterRuntime.motionPolicy]}
      </dd>
      <dt className="text-muted-foreground">{copy.settingsView.audioState}</dt>
      <dd className="m-0 text-foreground">
        {muted ? copy.character.muted : copy.character.unmuted}
      </dd>
      <dt className="text-muted-foreground">{copy.settingsView.lastError}</dt>
      <dd className="m-0 font-mono text-label text-foreground">
        {characterRuntime.lastErrorCode ?? copy.settingsView.noRecordedError}
      </dd>
    </dl>
  )
}

function CharacterRuntimeErrorAlert({
  characterRuntime,
  copy,
  onRetryCharacter,
}: Pick<SettingsViewProps, "characterRuntime" | "copy" | "onRetryCharacter">) {
  const { locale } = useI18n()
  if (characterRuntime.currentErrorCode === null) return null

  return (
    <Alert data-character-runtime-error="true">
      <AlertTriangleIcon aria-hidden="true" className="text-destructive" />
      <AlertTitle>{copy.settingsView.live2dError}</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-xs">
        <span>
          {getCharacterErrorMessage(locale, characterRuntime.currentErrorCode)}{" "}
          {copy.settingsView.characterErrorIntro}
        </span>
        <code className="font-mono text-label text-destructive">
          {characterRuntime.currentErrorCode}
        </code>
        {characterRuntime.canRetry ? (
          <Button
            onClick={onRetryCharacter}
            size="xs"
            type="button"
            variant="secondary"
          >
            {copy.settingsView.retryCharacter}
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  )
}

const sectionOrder: readonly SettingsSection[] = [
  "general",
  "project_context",
  "character_context",
  "companion",
  "audio",
  "support",
  "diagnostics",
  "history",
]

const sectionIcons = {
  general: Settings2Icon,
  project_context: FolderCogIcon,
  character_context: BotIcon,
  companion: SparklesIcon,
  audio: Mic2Icon,
  support: ShieldCheckIcon,
  diagnostics: ActivityIcon,
  history: HistoryIcon,
} as const

function SettingsNavigation({
  closeOnSelect = false,
  copy,
  section,
  onSectionChange,
}: Pick<SettingsViewProps, "copy" | "section" | "onSectionChange"> & {
  readonly closeOnSelect?: boolean
}) {
  return (
    <nav aria-label={copy.settings} className="flex flex-col gap-xxs p-md">
      {sectionOrder.map((item) => {
        const Icon = sectionIcons[item]
        const navigationButton = (
          <button
            aria-current={section === item ? "page" : undefined}
            className={cn(
              "flex min-h-8 items-center gap-sm rounded-control px-sm text-start text-caption text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
              section === item && "bg-selected-row text-text-strong",
            )}
            key={item}
            onClick={() => onSectionChange(item)}
            type="button"
          >
            <Icon aria-hidden="true" className="size-3 shrink-0" />
            <span>{copy.settingsView.sections[item]}</span>
          </button>
        )

        return closeOnSelect ? (
          <PopoverClose asChild key={item}>
            {navigationButton}
          </PopoverClose>
        ) : (
          navigationButton
        )
      })}
    </nav>
  )
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
      <div className="flex min-w-0 max-w-[60ch] flex-col gap-xxs">
        <span className="text-title text-text-strong">{label}</span>
        <span className="break-words text-caption text-muted-foreground">
          {description}
        </span>
      </div>
      <div className="max-w-full shrink-0 max-[700px]:shrink">{action}</div>
    </div>
  )
}

function ContextSettings({
  character,
  copy,
  contextModel,
  turnActive,
}: {
  readonly character: boolean
  readonly copy: WorkspaceCopy
  readonly contextModel: EditableWorkspaceContextModel
  readonly turnActive: boolean
}) {
  return (
    <EditableContextSection
      copy={copy}
      instanceId={`settings-${character ? "character" : "project"}`}
      model={contextModel}
      section={character ? "character" : "project"}
      turnActive={turnActive}
    />
  )
}

function CompanionSettings({
  characterRuntime,
  copy,
  muted,
  onRetryCharacter,
  workspaceId,
}: Pick<
  SettingsViewProps,
  "characterRuntime" | "copy" | "muted" | "onRetryCharacter" | "workspaceId"
>) {
  const preferences = useAppPreferences()
  const controller = useAppPreferencesController()
  const characterHidden =
    preferences.snapshot.preferences.characterVisibility === "hidden"

  return (
    <section className="flex flex-col gap-lg">
      <div className="flex items-center justify-between gap-md">
        <h2 className="m-0 text-headline text-text-strong">
          {copy.settingsView.companionTitle}
        </h2>
        <CharacterReadinessBadge copy={copy} runtime={characterRuntime} />
      </div>
      <CharacterRuntimeErrorAlert
        characterRuntime={characterRuntime}
        copy={copy}
        onRetryCharacter={onRetryCharacter}
      />
      <CharacterRuntimeDetails
        characterRuntime={characterRuntime}
        copy={copy}
        muted={muted}
      />
      <CharacterModelLibrarySettings workspaceId={workspaceId} />
      <SettingRow
        action={
          <Switch
            aria-label={copy.settingsView.hideCharacter}
            checked={characterHidden}
            disabled={preferences.status === "loading"}
            onCheckedChange={(hidden) => {
              void controller.update({
                characterVisibility: hidden ? "hidden" : "visible",
              })
            }}
          />
        }
        description={copy.settingsView.hideCharacterDescription}
        label={copy.settingsView.hideCharacter}
      />
    </section>
  )
}

function AudioSettings({
  copy,
  muted,
  workspaceId,
  onMutedChange,
}: Pick<
  SettingsViewProps,
  "copy" | "muted" | "workspaceId" | "onMutedChange"
>) {
  return (
    <NarrationSettings
      heading={copy.settingsView.audioTitle}
      muted={muted}
      onMutedChange={onMutedChange}
      workspaceId={workspaceId}
    />
  )
}

function SupportSettings({ copy }: { readonly copy: WorkspaceCopy }) {
  return (
    <section className="flex flex-col gap-lg">
      <h2 className="m-0 text-headline text-text-strong">
        {copy.settingsView.supportTitle}
      </h2>
      <SettingRow
        action={
          <Switch
            aria-label={copy.settingsView.supportGlobal}
            checked={false}
            disabled
          />
        }
        description={copy.settingsView.supportDescription}
        label={copy.settingsView.supportGlobal}
      />
      <SettingRow
        action={
          <Switch
            aria-label={copy.settingsView.presence}
            checked={false}
            disabled
          />
        }
        description={copy.settingsView.supportDescription}
        label={copy.settingsView.presence}
      />
      <SettingRow
        action={
          <Switch
            aria-label={copy.settingsView.reviewer}
            checked={false}
            disabled
          />
        }
        description={copy.settingsView.supportDescription}
        label={copy.settingsView.reviewer}
      />
    </section>
  )
}

function DiagnosticsSettings({
  characterRuntime,
  copy,
  muted,
  onRetryCharacter,
}: Pick<
  SettingsViewProps,
  "characterRuntime" | "copy" | "muted" | "onRetryCharacter"
>) {
  return (
    <section className="flex flex-col gap-lg">
      <NativeReadinessDiagnostics />
      <Separator />
      <CharacterRuntimeErrorAlert
        characterRuntime={characterRuntime}
        copy={copy}
        onRetryCharacter={onRetryCharacter}
      />
      <CharacterRuntimeDetails
        characterRuntime={characterRuntime}
        copy={copy}
        muted={muted}
      />
    </section>
  )
}

function HistorySettings({
  copy,
  history,
  onDeleteHistory,
}: Pick<SettingsViewProps, "copy" | "history" | "onDeleteHistory">) {
  const { locale } = useI18n()
  const nativeReadiness = useNativeReadiness()
  const nativeHistory = checkById(nativeReadiness.snapshot, "history")
  const [confirmationOpen, setConfirmationOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const historyActionRef = useRef<HTMLButtonElement>(null)
  const ephemeral = history.mode === "ephemeral"
  const nativePersistenceReady = nativeHistory?.status === "ready"
  const canChangeHistory =
    ephemeral || (history.mode === "ready" && nativePersistenceReady)
  const persistenceUnavailable = {
    en: {
      title: "Local persistence unavailable",
      body: "This readiness snapshot does not verify a writable history database. The app does not claim that history is persisted locally.",
    },
    ja: {
      title: "ローカル保存を利用できません",
      body: "この準備状況スナップショットでは、書き込み可能な履歴データベースを確認できていません。履歴をローカル保存済みとは表示しません。",
    },
  }[locale]

  const confirmDelete = async () => {
    setDeleting(true)
    try {
      if (await onDeleteHistory()) setConfirmationOpen(false)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <section className="flex flex-col gap-xl">
      <div className="flex flex-wrap items-center justify-between gap-md">
        <h2 className="m-0 text-headline text-text-strong">
          {copy.settingsView.historyTitle}
        </h2>
        <span
          data-history-readiness-snapshot={
            nativeReadiness.snapshot?.snapshotId ?? "pending"
          }
        >
          {nativeHistory === null ? (
            <Badge variant="running">{copy.settingsView.live2dLoading}</Badge>
          ) : (
            <ReadinessStatusBadge
              locale={locale}
              stale={
                nativeReadiness.status === "rechecking" ||
                nativeReadiness.status === "error"
              }
              status={nativeHistory.status}
            />
          )}
        </span>
      </div>
      <div className="flex flex-col gap-xs">
        <h3 className="m-0 flex items-center gap-xs text-title text-text-strong">
          <DatabaseIcon aria-hidden="true" className="size-3" />
          {ephemeral
            ? copy.settingsView.storedEphemeral
            : nativePersistenceReady
              ? copy.settingsView.stored
              : persistenceUnavailable.title}
        </h3>
        <p className="m-0 max-w-[70ch] text-caption text-muted-foreground">
          {ephemeral
            ? copy.settingsView.storedEphemeralBody
            : nativePersistenceReady
              ? copy.settingsView.storedBody
              : persistenceUnavailable.body}
        </p>
      </div>
      <div className="flex flex-col gap-xs">
        <h3 className="m-0 flex items-center gap-xs text-title text-text-strong">
          <ShieldCheckIcon aria-hidden="true" className="size-3" />
          {copy.settingsView.neverStored}
        </h3>
        <p className="m-0 max-w-[70ch] text-caption text-muted-foreground">
          {copy.settingsView.neverStoredBody}
        </p>
      </div>
      <SettingRow
        action={
          <Button
            disabled={!canChangeHistory}
            onClick={() => setConfirmationOpen(true)}
            ref={historyActionRef}
            size="xs"
            type="button"
            variant="destructive"
          >
            {ephemeral
              ? copy.settingsView.resetDemoHistory
              : copy.settingsView.deleteHistory}
          </Button>
        }
        description={
          canChangeHistory
            ? ephemeral
              ? copy.settingsView.resetDemoReady
              : copy.settingsView.deleteReady
            : copy.settingsView.deleteDisabled
        }
        label={
          ephemeral
            ? copy.settingsView.resetDemoHistory
            : copy.settingsView.deleteHistory
        }
      />
      <Dialog
        onOpenChange={(open) => {
          if (!deleting) setConfirmationOpen(open)
        }}
        open={confirmationOpen}
      >
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            historyActionRef.current?.focus()
          }}
          showCloseButton={!deleting}
        >
          <DialogHeader>
            <DialogTitle>
              {ephemeral
                ? copy.settingsView.resetDemoConfirmTitle
                : copy.settingsView.deleteConfirmTitle}
            </DialogTitle>
            <DialogDescription>
              {ephemeral
                ? copy.settingsView.resetDemoConfirmBody
                : copy.settingsView.deleteConfirmBody}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              disabled={deleting}
              onClick={() => setConfirmationOpen(false)}
              type="button"
              variant="outline"
            >
              {copy.settingsView.deleteCancel}
            </Button>
            <Button
              disabled={deleting}
              onClick={() => void confirmDelete()}
              type="button"
              variant="destructive"
            >
              {deleting
                ? ephemeral
                  ? copy.settingsView.resetDemoInProgress
                  : copy.settingsView.deleteInProgress
                : ephemeral
                  ? copy.settingsView.resetDemoConfirm
                  : copy.settingsView.deleteConfirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}

export function SettingsView(props: SettingsViewProps) {
  const sectionContent = (() => {
    switch (props.section) {
      case "general":
        return (
          <AppPreferencesSettings
            copy={props.copy}
            onResetUi={props.onResetUi}
            runtimeState={props.runtimeState}
          />
        )
      case "project_context":
        return (
          <ContextSettings
            character={false}
            copy={props.copy}
            contextModel={props.contextModel}
            turnActive={props.turnActive}
          />
        )
      case "character_context":
        return (
          <ContextSettings
            character
            copy={props.copy}
            contextModel={props.contextModel}
            turnActive={props.turnActive}
          />
        )
      case "companion":
        return <CompanionSettings {...props} />
      case "audio":
        return <AudioSettings {...props} />
      case "support":
        return <SupportSettings copy={props.copy} />
      case "diagnostics":
        return <DiagnosticsSettings {...props} />
      case "history":
        return <HistorySettings {...props} />
    }
  })()

  return (
    <main className="grid size-full min-h-0 min-w-0 grid-cols-[228px_minmax(0,1fr)] overflow-hidden bg-app-bg max-[1279px]:grid-cols-1">
      <aside className="min-h-0 border-r border-divider bg-sidebar/40 max-[1279px]:hidden">
        <ScrollArea className="size-full">
          <SettingsNavigation
            copy={props.copy}
            onSectionChange={props.onSectionChange}
            section={props.section}
          />
        </ScrollArea>
      </aside>

      <section className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden">
        <header className="flex min-h-[58px] min-w-0 items-center justify-between gap-md border-b border-divider px-xl py-sm max-[700px]:items-start max-[700px]:px-md">
          <div className="flex min-w-0 flex-col gap-xxs">
            <h1 className="m-0 text-headline text-text-strong">
              {props.copy.settingsView.title}
            </h1>
            <p className="m-0 truncate text-caption text-muted-foreground max-[700px]:whitespace-normal">
              {props.copy.settingsView.description}
            </p>
          </div>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                className="max-w-[45%] min-[1280px]:hidden"
                size="xs"
                type="button"
                variant="secondary"
              >
                <span className="truncate">
                  {props.copy.settingsView.sections[props.section]}
                </span>
                <ChevronDownIcon className="shrink-0" data-icon="inline-end" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="w-64 max-w-[calc(100dvw-2rem)]"
            >
              <SettingsNavigation
                closeOnSelect
                copy={props.copy}
                onSectionChange={props.onSectionChange}
                section={props.section}
              />
            </PopoverContent>
          </Popover>
        </header>
        <ScrollArea className="min-h-0 min-w-0">
          <div className="mx-auto w-full min-w-0 max-w-[780px] px-2xl py-xl max-[700px]:px-md max-[700px]:py-lg">
            {sectionContent}
          </div>
        </ScrollArea>
      </section>
    </main>
  )
}
