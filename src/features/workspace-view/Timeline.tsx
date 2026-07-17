import { useState } from "react"
import {
  CheckCircle2Icon,
  ChevronRightIcon,
  CircleXIcon,
  FileCheck2Icon,
  TerminalSquareIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import type { WorkspaceCopy } from "@/features/workspace-view/copy"

interface TimelineProps {
  readonly copy: WorkspaceCopy
  readonly onOpenDiagnostics: () => void
}

interface ToolRowProps {
  readonly copy: WorkspaceCopy
  readonly command: string
  readonly detail: string
  readonly status?: "completed" | "failed"
}

function ToolRow({
  command,
  copy,
  detail,
  status = "completed",
}: ToolRowProps) {
  return (
    <details className="group/tool w-full">
      <summary className="flex min-h-8 cursor-pointer list-none items-center gap-xs rounded-control px-xxs text-caption text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon className="size-3 shrink-0 transition-transform group-open/tool:rotate-90 motion-reduce:transition-none" />
        <TerminalSquareIcon className="size-3 shrink-0" />
        <span className="shrink-0 text-title text-foreground">Bash</span>
        <code className="min-w-0 truncate rounded-control bg-code-chip px-xs py-xxs font-mono text-label text-text-secondary">
          {command}
        </code>
        <span className="sr-only">
          {status === "completed" ? copy.completed : copy.failed}
        </span>
      </summary>
      <div className="ml-[39px] mt-xxs max-w-[calc(100%-39px)] rounded-control bg-code-chip px-sm py-xs font-mono text-label text-text-secondary">
        {detail}
      </div>
    </details>
  )
}

function DecisionPreview({ copy }: { readonly copy: WorkspaceCopy }) {
  const [selection, setSelection] = useState("small")
  const [saved, setSaved] = useState(false)

  return (
    <section
      aria-labelledby="decision-preview-title"
      className="mt-md flex flex-col gap-md rounded-composer border border-warm-active/45 bg-surface p-lg"
    >
      <div className="flex flex-wrap items-start justify-between gap-xs">
        <div className="flex flex-col gap-xxs">
          <Badge variant="outline">{copy.previewBadge}</Badge>
          <h3
            className="m-0 text-title text-text-strong"
            id="decision-preview-title"
          >
            {copy.decisionTitle}
          </h3>
        </div>
        {saved ? <Badge variant="success">{copy.answerSaved}</Badge> : null}
      </div>
      <div className="flex max-w-[70ch] flex-col gap-xs">
        <p className="m-0 text-body text-text-strong">
          {copy.decisionQuestion}
        </p>
        <p className="m-0 text-caption text-muted-foreground">
          {copy.decisionWhy}
        </p>
      </div>
      <RadioGroup
        aria-label={copy.decisionQuestion}
        onValueChange={(value) => {
          setSelection(value)
          setSaved(false)
        }}
        value={selection}
      >
        <label className="flex cursor-pointer items-start gap-sm rounded-control border border-divider px-md py-sm hover:bg-muted">
          <RadioGroupItem aria-label={copy.decisionOptionSmall} value="small" />
          <span className="flex flex-col gap-xxs">
            <span className="text-title text-text-strong">
              {copy.decisionOptionSmall}
            </span>
            <span className="text-caption text-muted-foreground">
              {copy.decisionOptionSmallImpact}
            </span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-sm rounded-control border border-divider px-md py-sm hover:bg-muted">
          <RadioGroupItem aria-label={copy.decisionOptionHold} value="hold" />
          <span className="flex flex-col gap-xxs">
            <span className="text-title text-text-strong">
              {copy.decisionOptionHold}
            </span>
            <span className="text-caption text-muted-foreground">
              {copy.decisionOptionHoldImpact}
            </span>
          </span>
        </label>
      </RadioGroup>
      <div className="flex flex-wrap items-center justify-between gap-sm">
        <div className="flex flex-col gap-xxs text-caption">
          <span className="text-foreground">{copy.decisionRecommendation}</span>
          <span className="text-muted-foreground">
            {copy.decisionUncertainty}
          </span>
        </div>
        <Button
          onClick={() => setSaved(true)}
          size="xs"
          type="button"
          variant="secondary"
        >
          {copy.answerPreview}
        </Button>
      </div>
    </section>
  )
}

export function Timeline({ copy, onOpenDiagnostics }: TimelineProps) {
  return (
    <div className="flex min-h-full flex-col pb-[162px] pt-lg">
      <div className="mb-sm flex items-start justify-between gap-md">
        <div className="flex flex-col gap-xxs">
          <h2 className="m-0 text-headline text-text-strong">
            {copy.timelineTitle}
          </h2>
          <p className="m-0 text-caption text-muted-foreground">
            {copy.timelineDescription}
          </p>
        </div>
        <Badge variant="outline">{copy.previewBadge}</Badge>
      </div>

      <div className="flex flex-col gap-xxs" role="feed">
        <ToolRow
          command="agent-browser skills get core"
          copy={copy}
          detail="Reference event · no shell input is exposed by this row."
        />
        <ToolRow
          command="agent-docs read docs/screen-design/S-002_coding-workspace.md"
          copy={copy}
          detail="Reference event · structured summary only."
        />
        <ToolRow
          command="pnpm run typecheck"
          copy={copy}
          detail="Reference event · a live result will include duration and evidence ID."
        />

        <article className="mt-md max-w-[72ch] text-body text-foreground">
          <p className="m-0">{copy.assistantPreview}</p>
        </article>

        <ToolRow
          command="pnpm run check"
          copy={copy}
          detail="APP-DEMO-NOT-CONNECTED · no process was started."
          status="failed"
        />

        <div
          className="mt-xs flex items-start gap-xs text-body text-destructive"
          role="status"
        >
          <CircleXIcon className="mt-[4px] size-3 shrink-0" />
          <div className="flex min-w-0 flex-1 flex-col gap-xxs">
            <span className="font-medium">{copy.errorTitle}</span>
            <span className="text-caption text-destructive/90">
              {copy.errorBody}
            </span>
          </div>
          <Button
            onClick={onOpenDiagnostics}
            size="xs"
            type="button"
            variant="ghost"
          >
            {copy.diagnostics}
          </Button>
        </div>

        <article className="mt-md flex max-w-[72ch] items-start gap-sm text-body text-foreground">
          <FileCheck2Icon className="mt-[4px] size-3 shrink-0 text-success" />
          <p className="m-0">{copy.verificationPreview}</p>
        </article>

        <div className="sr-only" aria-live="polite">
          <CheckCircle2Icon />
          {copy.previewNotice}
        </div>

        <DecisionPreview copy={copy} />
      </div>
    </div>
  )
}
