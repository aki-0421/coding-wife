import { useEffect, useRef, useState } from "react"
import {
  ActivityIcon,
  AlertTriangleIcon,
  ArrowLeftIcon,
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  DatabaseIcon,
  FolderIcon,
  Mic2Icon,
  Settings2Icon,
  ShieldCheckIcon,
  SparklesIcon,
  type LucideIcon,
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
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
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
import { useAppPreferences } from "@/features/preferences"
import { SupportControlsSettings } from "@/features/support-controls"
import { AppPreferencesSettings } from "@/features/workspace-view/AppPreferencesSettings"
import { EditableContextSection } from "@/features/workspace-view/EditableContextSection"
import type { WorkspaceCopy } from "@/features/workspace-view/copy"
import type { EditableSettingsContextModel } from "@/features/workspace-view/useEditableSettingsContext"
import type { RuntimeState } from "@/features/runtime"
import type {
  AppSettingsSection,
  ProjectRecord,
  SettingsSection,
  WorkspaceAdapterState,
} from "@/features/workspace-view/types"
import { cn } from "@/lib/utils"

interface CharacterRuntimeSettingsProps {
  readonly characterRuntime: CharacterRuntimeView
  readonly copy: WorkspaceCopy
  readonly muted: boolean
  readonly onRetryCharacter: () => void
}

interface AppSettingsViewProps extends CharacterRuntimeSettingsProps {
  readonly contextModel: EditableSettingsContextModel
  readonly runtimeState: RuntimeState
  readonly section: AppSettingsSection
  readonly turnActive: boolean
  readonly workspaceId: string
  readonly projects: readonly ProjectRecord[]
  readonly selectedProjectId: string | null
  readonly projectActionPending: boolean
  readonly onBack: () => void
  readonly onMutedChange: (muted: boolean) => void
  readonly onResetUi: () => void
  readonly onSectionChange: (section: AppSettingsSection) => void
  readonly onOpenProject: (projectId: string) => void
  readonly onCloseProject: () => void
  readonly onUnregisterProject: (projectId: string) => Promise<boolean>
}

interface WorkspaceSettingsViewProps {
  readonly copy: WorkspaceCopy
  readonly history: WorkspaceAdapterState["history"]
  readonly workspaceLabel: string
  readonly onDeleteHistory: () => Promise<boolean>
}

function CharacterReadinessBadge({
  copy,
  runtime,
}: Pick<CharacterRuntimeSettingsProps, "copy"> & {
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
}: Pick<CharacterRuntimeSettingsProps, "characterRuntime" | "copy" | "muted">) {
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
}: Pick<
  CharacterRuntimeSettingsProps,
  "characterRuntime" | "copy" | "onRetryCharacter"
>) {
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

const appSectionOrder: readonly AppSettingsSection[] = [
  "general",
  "projects",
  "character_context",
  "companion",
  "audio",
  "support",
  "diagnostics",
]

const sectionIcons = {
  general: Settings2Icon,
  projects: FolderIcon,
  character_context: BotIcon,
  companion: SparklesIcon,
  audio: Mic2Icon,
  support: ShieldCheckIcon,
  diagnostics: ActivityIcon,
} as const

function SettingsNavigation<Section extends SettingsSection>({
  closeOnSelect = false,
  copy,
  label,
  sections,
  section,
  onSectionChange,
}: {
  readonly closeOnSelect?: boolean
  readonly copy: WorkspaceCopy
  readonly label: string
  readonly sections: readonly Section[]
  readonly section: Section
  readonly onSectionChange: (section: Section) => void
}) {
  return (
    <nav aria-label={label} className="flex flex-col gap-xxs p-md">
      {sections.map((item) => {
        const Icon = sectionIcons[item] as LucideIcon
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

function SettingsSectionPicker<Section extends SettingsSection>({
  copy,
  label,
  sections,
  section,
  onSectionChange,
}: {
  readonly copy: WorkspaceCopy
  readonly label: string
  readonly sections: readonly Section[]
  readonly section: Section
  readonly onSectionChange: (section: Section) => void
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          className="max-w-[45%] min-[1280px]:hidden"
          size="xs"
          type="button"
          variant="secondary"
        >
          <span className="truncate">
            {copy.settingsView.sections[section]}
          </span>
          <ChevronDownIcon className="shrink-0" data-icon="inline-end" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 max-w-[calc(100dvw-2rem)]">
        <SettingsNavigation
          closeOnSelect
          copy={copy}
          label={label}
          onSectionChange={onSectionChange}
          section={section}
          sections={sections}
        />
      </PopoverContent>
    </Popover>
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
  readonly contextModel: EditableSettingsContextModel
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
}: CharacterRuntimeSettingsProps) {
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
      <CharacterModelLibrarySettings />
    </section>
  )
}

function AudioSettings({
  copy,
  muted,
  workspaceId,
  onMutedChange,
}: Pick<
  AppSettingsViewProps,
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

function SupportSettings() {
  const preferences = useAppPreferences()
  return (
    <SupportControlsSettings
      gatewayKind={
        preferences.snapshot.persistence === "native" ? "native" : "demo"
      }
    />
  )
}

function DiagnosticsSettings() {
  return <NativeReadinessDiagnostics />
}

function ProjectsSettings({
  contextModel,
  copy,
  projectActionPending,
  projects,
  selectedProjectId,
  turnActive,
  onCloseProject,
  onOpenProject,
  onUnregisterProject,
}: Pick<
  AppSettingsViewProps,
  | "contextModel"
  | "copy"
  | "projectActionPending"
  | "projects"
  | "selectedProjectId"
  | "turnActive"
  | "onCloseProject"
  | "onOpenProject"
  | "onUnregisterProject"
>) {
  const [pendingProject, setPendingProject] = useState<ProjectRecord | null>(
    null,
  )
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const safeActionRef = useRef<HTMLButtonElement | null>(null)
  const detailHeadingRef = useRef<HTMLHeadingElement | null>(null)
  const projectTriggerRefs = useRef(new Map<string, HTMLButtonElement>())
  const selectedProject =
    projects.find((project) => project.id === selectedProjectId) ?? null

  useEffect(() => {
    if (selectedProject !== null) detailHeadingRef.current?.focus()
  }, [selectedProject])

  const confirmUnregister = async () => {
    if (
      pendingProject !== null &&
      (await onUnregisterProject(pendingProject.id))
    ) {
      setPendingProject(null)
    }
  }

  if (selectedProject !== null) {
    return (
      <section className="flex flex-col gap-xl" data-project-detail="true">
        <div className="flex flex-col items-start gap-md">
          <Button
            onClick={() => {
              const projectId = selectedProject.id
              onCloseProject()
              requestAnimationFrame(() =>
                projectTriggerRefs.current.get(projectId)?.focus(),
              )
            }}
            size="xs"
            type="button"
            variant="ghost"
          >
            <ArrowLeftIcon aria-hidden="true" data-icon="inline-start" />
            {copy.settingsView.backToProjects}
          </Button>
          <div className="flex min-w-0 items-start gap-md">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-control border border-divider bg-muted text-muted-foreground">
              <FolderIcon aria-hidden="true" className="size-4" />
            </span>
            <div className="flex min-w-0 flex-col gap-xxs">
              <h2
                className="m-0 truncate text-headline text-text-strong outline-none"
                ref={detailHeadingRef}
                tabIndex={-1}
              >
                {selectedProject.name}
              </h2>
              <p className="m-0 text-caption text-muted-foreground">
                {copy.settingsView.projectContextDescription(
                  copy.settingsView.workspaceCount(
                    selectedProject.workspaceCount,
                  ),
                )}
              </p>
            </div>
          </div>
        </div>
        <div className="border-t border-divider pt-xl">
          <ContextSettings
            character={false}
            copy={copy}
            contextModel={contextModel}
            turnActive={turnActive}
          />
        </div>
      </section>
    )
  }

  return (
    <section className="flex flex-col gap-lg">
      <div className="flex flex-col gap-xs">
        <h2 className="m-0 text-headline text-text-strong">
          {copy.settingsView.projectsTitle}
        </h2>
        <p className="m-0 max-w-[70ch] text-caption text-muted-foreground">
          {copy.settingsView.projectsDescription}
        </p>
      </div>

      {projects.length === 0 ? (
        <Empty className="min-h-56 rounded-panel border border-dashed border-divider bg-surface/40">
          <EmptyHeader>
            <EmptyTitle>{copy.settingsView.noProjectsTitle}</EmptyTitle>
            <EmptyDescription>
              {copy.settingsView.noProjectsDescription}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col divide-y divide-divider rounded-panel border border-divider bg-surface px-md">
          {projects.map((project) => (
            <div
              className="flex min-w-0 items-center gap-md py-md max-[700px]:items-start"
              key={project.id}
            >
              <button
                className="group flex min-w-0 flex-1 items-center gap-md rounded-control text-start outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onOpenProject(project.id)}
                ref={(element) => {
                  if (element === null)
                    projectTriggerRefs.current.delete(project.id)
                  else projectTriggerRefs.current.set(project.id, element)
                }}
                type="button"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-control border border-divider bg-muted text-muted-foreground group-hover:text-foreground">
                  <FolderIcon aria-hidden="true" className="size-4" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-xxs">
                  <span className="truncate text-title text-text-strong">
                    {project.name}
                  </span>
                  <span className="flex min-w-0 flex-wrap items-center gap-xs text-label text-muted-foreground">
                    {project.githubRepository ? (
                      <span className="truncate font-mono">
                        {project.githubRepository}
                      </span>
                    ) : null}
                    <span>
                      {copy.settingsView.workspaceCount(project.workspaceCount)}
                    </span>
                    {project.health !== "ready" ? (
                      <Badge variant="destructive">
                        {copy.workspaceHealth[project.health]}
                      </Badge>
                    ) : null}
                  </span>
                </span>
                <ChevronRightIcon
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
                />
              </button>
              <Button
                disabled={projectActionPending}
                onClick={(event) => {
                  triggerRef.current = event.currentTarget
                  setPendingProject(project)
                }}
                size="xs"
                type="button"
                variant="outline"
              >
                {copy.settingsView.unregisterProject}
              </Button>
            </div>
          ))}
        </div>
      )}

      <Dialog
        onOpenChange={(open) => {
          if (!open && !projectActionPending) setPendingProject(null)
        }}
        open={pendingProject !== null}
      >
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            triggerRef.current?.focus()
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            safeActionRef.current?.focus()
          }}
          showCloseButton={!projectActionPending}
        >
          <DialogHeader>
            <DialogTitle>
              {copy.settingsView.unregisterProjectTitle}
            </DialogTitle>
            <DialogDescription>
              {copy.settingsView.unregisterProjectBody(
                pendingProject?.name ?? "",
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              disabled={projectActionPending}
              onClick={() => setPendingProject(null)}
              ref={safeActionRef}
              type="button"
              variant="outline"
            >
              {copy.settingsView.keepProject}
            </Button>
            <Button
              disabled={projectActionPending}
              onClick={() => void confirmUnregister()}
              type="button"
              variant="destructive"
            >
              {projectActionPending
                ? copy.settingsView.unregisteringProject
                : copy.settingsView.confirmUnregisterProject}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}

function HistorySettings({
  copy,
  history,
  onDeleteHistory,
}: Pick<WorkspaceSettingsViewProps, "copy" | "history" | "onDeleteHistory">) {
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

export function AppSettingsView(props: AppSettingsViewProps) {
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    headingRef.current?.focus()
  }, [])

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
      case "projects":
        return <ProjectsSettings {...props} />
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
        return (
          <CompanionSettings
            characterRuntime={props.characterRuntime}
            copy={props.copy}
            muted={props.muted}
            onRetryCharacter={props.onRetryCharacter}
          />
        )
      case "audio":
        return <AudioSettings {...props} />
      case "support":
        return <SupportSettings />
      case "diagnostics":
        return <DiagnosticsSettings />
    }
  })()

  return (
    <section
      aria-labelledby="app-settings-title"
      className="workspace-tabs"
      data-settings-scope="app"
    >
      <header className="workspace-header flex min-w-0 items-center gap-md border-b border-divider bg-surface px-xl max-[700px]:px-md">
        <Button onClick={props.onBack} size="xs" type="button" variant="ghost">
          <ArrowLeftIcon aria-hidden="true" data-icon="inline-start" />
          {props.copy.settingsView.backToWorkspace}
        </Button>
        <div className="flex min-w-0 flex-1 flex-col gap-xxs">
          <h1
            className="m-0 text-balance text-headline text-text-strong"
            id="app-settings-title"
            ref={headingRef}
            tabIndex={-1}
          >
            {props.copy.settingsView.appTitle}
          </h1>
          <p className="m-0 text-pretty text-caption text-muted-foreground">
            {props.copy.settingsView.appDescription}
          </p>
        </div>
        <SettingsSectionPicker
          copy={props.copy}
          label={props.copy.appSettings}
          onSectionChange={props.onSectionChange}
          section={props.section}
          sections={appSectionOrder}
        />
      </header>

      <div className="workspace-view grid size-full min-h-0 min-w-0 grid-cols-[228px_minmax(0,1fr)] overflow-hidden bg-app-bg max-[1279px]:grid-cols-1">
        <aside className="min-h-0 border-r border-divider bg-sidebar/40 max-[1279px]:hidden">
          <ScrollArea className="size-full">
            <SettingsNavigation
              copy={props.copy}
              label={props.copy.appSettings}
              onSectionChange={props.onSectionChange}
              section={props.section}
              sections={appSectionOrder}
            />
          </ScrollArea>
        </aside>

        <ScrollArea className="min-h-0 min-w-0">
          <div className="mx-auto w-full min-w-0 max-w-[780px] px-2xl py-xl max-[700px]:px-md max-[700px]:py-lg">
            {sectionContent}
          </div>
        </ScrollArea>
      </div>
    </section>
  )
}

export function WorkspaceSettingsView(props: WorkspaceSettingsViewProps) {
  return (
    <section
      aria-labelledby="workspace-settings-title"
      className="grid size-full min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-app-bg"
      data-settings-scope="workspace"
    >
      <header className="flex min-h-[58px] min-w-0 items-center border-b border-divider px-xl py-sm max-[700px]:px-md">
        <div className="flex min-w-0 flex-col gap-xxs">
          <h1
            className="m-0 text-balance text-headline text-text-strong"
            id="workspace-settings-title"
          >
            {props.copy.settingsView.workspaceTitle}
          </h1>
          <p className="m-0 text-pretty text-caption text-muted-foreground">
            {props.copy.settingsView.workspaceDescription(props.workspaceLabel)}
          </p>
        </div>
      </header>
      <ScrollArea className="min-h-0 min-w-0">
        <div className="mx-auto w-full min-w-0 max-w-[780px] px-2xl py-xl max-[700px]:px-md max-[700px]:py-lg">
          <HistorySettings {...props} />
        </div>
      </ScrollArea>
    </section>
  )
}
