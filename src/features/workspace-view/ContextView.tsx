import { ScrollArea } from "@/components/ui/scroll-area"
import { EditableContextSection } from "@/features/workspace-view/EditableContextSection"
import type { WorkspaceCopy } from "@/features/workspace-view/copy"
import type { EditableWorkspaceContextModel } from "@/features/workspace-view/useEditableWorkspaceContext"

interface ContextViewProps {
  readonly copy: WorkspaceCopy
  readonly model: EditableWorkspaceContextModel
  readonly turnActive: boolean
}

export function ContextView({ copy, model, turnActive }: ContextViewProps) {
  return (
    <main className="size-full min-h-0 bg-app-bg">
      <ScrollArea className="size-full">
        <div className="mx-auto flex w-full max-w-[860px] flex-col gap-2xl px-2xl py-xl max-[600px]:px-lg">
          <header className="flex flex-col gap-xxs">
            <h1 className="m-0 text-headline text-text-strong">
              {copy.contextView.title}
            </h1>
            <p className="m-0 max-w-[70ch] text-caption text-muted-foreground">
              {copy.contextView.description}
            </p>
          </header>

          <EditableContextSection
            copy={copy}
            instanceId="context-tab"
            model={model}
            section="project"
            turnActive={turnActive}
          />
          <div className="border-t border-divider pt-lg">
            <EditableContextSection
              copy={copy}
              instanceId="context-tab"
              model={model}
              section="character"
              turnActive={turnActive}
            />
          </div>
        </div>
      </ScrollArea>
    </main>
  )
}
