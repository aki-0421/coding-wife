import { useMemo, useState } from "react"
import { BotIcon, FolderCogIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Textarea } from "@/components/ui/textarea"
import type { WorkspaceCopy } from "@/features/workspace-view/copy"

interface ContextViewProps {
  readonly copy: WorkspaceCopy
  readonly workspaceId: string
}

interface ContextDraftState {
  readonly goal: string
  readonly constraints: string
  readonly definition: string
  readonly displayName: string
  readonly tone: string
  readonly prohibited: string
  readonly projectVersion: number
  readonly characterVersion: number
  readonly projectSaved: boolean
  readonly characterSaved: boolean
}

const emptyContext: ContextDraftState = {
  goal: "",
  constraints: "",
  definition: "",
  displayName: "Sol",
  tone: "",
  prohibited: "",
  projectVersion: 1,
  characterVersion: 1,
  projectSaved: false,
  characterSaved: false,
}

export function ContextView({ copy, workspaceId }: ContextViewProps) {
  const [contexts, setContexts] = useState<
    Readonly<Record<string, ContextDraftState>>
  >({})
  const current = useMemo(
    () => contexts[workspaceId] ?? emptyContext,
    [contexts, workspaceId],
  )

  const update = (change: Partial<ContextDraftState>) => {
    setContexts((values) => ({
      ...values,
      [workspaceId]: { ...(values[workspaceId] ?? emptyContext), ...change },
    }))
  }

  return (
    <main className="size-full min-h-0 bg-app-bg">
      <ScrollArea className="size-full">
        <div className="mx-auto flex w-full max-w-[860px] flex-col gap-2xl px-2xl py-xl">
          <header className="flex flex-col gap-xxs">
            <h1 className="m-0 text-headline text-text-strong">
              {copy.contextView.title}
            </h1>
            <p className="m-0 max-w-[70ch] text-caption text-muted-foreground">
              {copy.contextView.description}
            </p>
          </header>

          <section
            aria-labelledby="project-context-title"
            className="flex flex-col gap-lg border-t border-divider pt-lg"
          >
            <div className="flex items-start justify-between gap-md">
              <div className="flex items-start gap-sm">
                <FolderCogIcon
                  aria-hidden="true"
                  className="mt-xxs size-4 text-muted-foreground"
                />
                <div className="flex flex-col gap-xxs">
                  <h2
                    className="m-0 text-title text-text-strong"
                    id="project-context-title"
                  >
                    {copy.contextView.projectTitle}
                  </h2>
                  <p className="m-0 text-caption text-muted-foreground">
                    {copy.contextView.projectDescription}
                  </p>
                </div>
              </div>
              <Badge variant="outline">
                {copy.contextView.version} {current.projectVersion}
              </Badge>
            </div>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={`project-goal-${workspaceId}`}>
                  {copy.contextView.goal}
                </FieldLabel>
                <Textarea
                  id={`project-goal-${workspaceId}`}
                  maxLength={8000}
                  onChange={(event) =>
                    update({
                      goal: event.currentTarget.value,
                      projectSaved: false,
                    })
                  }
                  rows={3}
                  value={current.goal}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`project-constraints-${workspaceId}`}>
                  {copy.contextView.constraints}
                </FieldLabel>
                <Textarea
                  id={`project-constraints-${workspaceId}`}
                  maxLength={8000}
                  onChange={(event) =>
                    update({
                      constraints: event.currentTarget.value,
                      projectSaved: false,
                    })
                  }
                  rows={3}
                  value={current.constraints}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`project-definition-${workspaceId}`}>
                  {copy.contextView.definition}
                </FieldLabel>
                <Textarea
                  id={`project-definition-${workspaceId}`}
                  maxLength={10000}
                  onChange={(event) =>
                    update({
                      definition: event.currentTarget.value,
                      projectSaved: false,
                    })
                  }
                  rows={3}
                  value={current.definition}
                />
              </Field>
            </FieldGroup>
            <div className="flex flex-wrap items-center justify-between gap-md">
              <p className="m-0 text-caption text-muted-foreground">
                {current.projectSaved
                  ? copy.contextView.localOnly
                  : copy.contextView.nextTurn}
              </p>
              <Button
                onClick={() =>
                  update({
                    projectSaved: true,
                    projectVersion: current.projectVersion + 1,
                  })
                }
                size="xs"
                type="button"
                variant="secondary"
              >
                {copy.contextView.saveProject}
              </Button>
            </div>
          </section>

          <section
            aria-labelledby="character-context-title"
            className="flex flex-col gap-lg border-t border-divider pt-lg"
          >
            <div className="flex items-start justify-between gap-md">
              <div className="flex items-start gap-sm">
                <BotIcon
                  aria-hidden="true"
                  className="mt-xxs size-4 text-muted-foreground"
                />
                <div className="flex flex-col gap-xxs">
                  <h2
                    className="m-0 text-title text-text-strong"
                    id="character-context-title"
                  >
                    {copy.contextView.characterTitle}
                  </h2>
                  <p className="m-0 text-caption text-muted-foreground">
                    {copy.contextView.characterDescription}
                  </p>
                </div>
              </div>
              <Badge variant="outline">
                {copy.contextView.version} {current.characterVersion}
              </Badge>
            </div>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={`character-name-${workspaceId}`}>
                  {copy.contextView.displayName}
                </FieldLabel>
                <Input
                  id={`character-name-${workspaceId}`}
                  maxLength={40}
                  onChange={(event) =>
                    update({
                      displayName: event.currentTarget.value,
                      characterSaved: false,
                    })
                  }
                  value={current.displayName}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`character-tone-${workspaceId}`}>
                  {copy.contextView.tone}
                </FieldLabel>
                <Textarea
                  id={`character-tone-${workspaceId}`}
                  maxLength={1000}
                  onChange={(event) =>
                    update({
                      tone: event.currentTarget.value,
                      characterSaved: false,
                    })
                  }
                  rows={3}
                  value={current.tone}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`character-prohibited-${workspaceId}`}>
                  {copy.contextView.prohibited}
                </FieldLabel>
                <Textarea
                  id={`character-prohibited-${workspaceId}`}
                  maxLength={4000}
                  onChange={(event) =>
                    update({
                      prohibited: event.currentTarget.value,
                      characterSaved: false,
                    })
                  }
                  rows={3}
                  value={current.prohibited}
                />
                <FieldDescription>
                  {copy.contextView.characterDescription}
                </FieldDescription>
              </Field>
            </FieldGroup>
            <div className="flex flex-wrap items-center justify-between gap-md pb-xl">
              <p className="m-0 text-caption text-muted-foreground">
                {current.characterSaved
                  ? copy.contextView.localOnly
                  : copy.contextView.nextTurn}
              </p>
              <Button
                onClick={() =>
                  update({
                    characterSaved: true,
                    characterVersion: current.characterVersion + 1,
                  })
                }
                size="xs"
                type="button"
                variant="secondary"
              >
                {copy.contextView.saveCharacter}
              </Button>
            </div>
          </section>
        </div>
      </ScrollArea>
    </main>
  )
}
