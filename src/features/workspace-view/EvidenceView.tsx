import { ArchiveIcon, CircleDashedIcon, ShieldCheckIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { WorkspaceCopy } from "@/features/workspace-view/copy"

interface EvidenceViewProps {
  readonly copy: WorkspaceCopy
  readonly onBackToChat: () => void
}

export function EvidenceView({ copy, onBackToChat }: EvidenceViewProps) {
  return (
    <main className="evidence-view grid size-full min-h-0 grid-rows-[72px_minmax(0,1fr)] bg-app-bg">
      <header className="flex items-center justify-between gap-xl border-b border-divider px-xl">
        <div className="flex min-w-0 flex-col gap-xxs">
          <h1 className="m-0 text-headline text-text-strong">
            {copy.commit.title}
          </h1>
          <p className="m-0 truncate text-caption text-muted-foreground">
            {copy.commit.description}
          </p>
        </div>
        <Badge variant="outline">{copy.commit.noCheckpoint}</Badge>
      </header>

      <div className="grid min-h-0 grid-cols-[300px_minmax(0,1fr)] max-[1100px]:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="min-h-0 border-r border-divider bg-sidebar/40">
          <div className="flex h-12 items-center gap-xs border-b border-divider px-md">
            <ArchiveIcon
              aria-hidden="true"
              className="size-3 text-muted-foreground"
            />
            <h2 className="m-0 text-title text-text-strong">
              {copy.commit.listTitle}
            </h2>
          </div>
          <ScrollArea className="h-[calc(100%-48px)]">
            <div className="flex flex-col gap-sm p-md">
              <div className="flex items-center gap-sm rounded-control border border-dashed border-divider px-sm py-md text-caption text-muted-foreground">
                <CircleDashedIcon
                  aria-hidden="true"
                  className="size-3 shrink-0"
                />
                {copy.commit.noCheckpoint}
              </div>
            </div>
          </ScrollArea>
        </aside>

        <ScrollArea className="min-h-0">
          <div className="mx-auto flex w-full max-w-[780px] flex-col gap-xl p-xl">
            <section
              aria-labelledby="checkpoint-gates"
              className="flex flex-col gap-md"
            >
              <div className="flex items-center gap-xs">
                <ShieldCheckIcon
                  aria-hidden="true"
                  className="size-3 text-muted-foreground"
                />
                <h2
                  className="m-0 text-title text-text-strong"
                  id="checkpoint-gates"
                >
                  {copy.commit.gateSummary}
                </h2>
              </div>
              <dl className="m-0 grid grid-cols-2 gap-x-xl gap-y-xs max-[1120px]:grid-cols-1">
                {copy.commit.gates.map((gate) => (
                  <div
                    className="flex items-center justify-between gap-md border-b border-divider py-xs"
                    key={gate}
                  >
                    <dt className="text-caption text-foreground">{gate}</dt>
                    <dd className="m-0">
                      <Badge variant="outline">{copy.commit.unavailable}</Badge>
                    </dd>
                  </div>
                ))}
              </dl>
            </section>

            <Empty className="min-h-[320px]">
              <EmptyHeader>
                <EmptyTitle>{copy.commit.emptyTitle}</EmptyTitle>
                <EmptyDescription>
                  {copy.commit.emptyDescription}
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button
                  onClick={onBackToChat}
                  size="xs"
                  type="button"
                  variant="secondary"
                >
                  {copy.commit.backToChat}
                </Button>
              </EmptyContent>
            </Empty>

            <section className="flex flex-col gap-xs border-t border-divider pt-md">
              <h2 className="m-0 text-title text-text-strong">
                {copy.commit.detailTitle}
              </h2>
              <p className="m-0 max-w-[70ch] text-caption text-muted-foreground">
                {copy.commit.detailBody}
              </p>
            </section>
          </div>
        </ScrollArea>
      </div>
    </main>
  )
}
