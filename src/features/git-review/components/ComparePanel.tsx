import {
  CheckIcon,
  ChevronDownIcon,
  GitCompareArrowsIcon,
  LoaderCircleIcon,
  TriangleAlertIcon,
} from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldLabel } from "@/components/ui/field"
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"
import type { GitReviewCopy } from "@/features/git-review/copy"
import type {
  CompareCheckpointsView,
  ReviewPackSummary,
} from "@/lib/contracts/git-review"

interface CheckpointPickerProps {
  readonly copy: GitReviewCopy
  readonly label: string
  readonly items: readonly ReviewPackSummary[]
  readonly value: string | null
  readonly onChange: (checkpointId: string) => void
}

function CheckpointPicker({
  copy,
  label,
  items,
  value,
  onChange,
}: CheckpointPickerProps) {
  const selected = items.find((item) => item.checkpointId === value)
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            aria-label={`${label}: ${selected?.objective ?? copy.chooseCheckpoint}`}
            className="w-full justify-between"
            type="button"
            variant="outline"
          >
            <span className="min-w-0 truncate">
              {selected === undefined
                ? copy.chooseCheckpoint
                : `${selected.commitSha.slice(0, 8)} · ${selected.objective}`}
            </span>
            <ChevronDownIcon data-icon="inline-end" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[min(340px,calc(100dvw-36px))] p-xxs">
          {items.map((item) => (
            <PopoverClose asChild key={item.checkpointId}>
              <button
                className="flex min-h-10 w-full items-start gap-sm rounded-control px-sm py-xs text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onChange(item.checkpointId)}
                type="button"
              >
                <CheckIcon
                  aria-hidden="true"
                  className={`mt-xxs size-3 shrink-0 ${item.checkpointId === value ? "opacity-100" : "opacity-0"}`}
                />
                <span className="min-w-0">
                  <span className="block font-mono text-caption text-text-secondary">
                    {item.commitSha.slice(0, 8)}
                  </span>
                  <span className="line-clamp-2 text-caption text-text-strong">
                    {item.objective}
                  </span>
                </span>
              </button>
            </PopoverClose>
          ))}
        </PopoverContent>
      </Popover>
    </Field>
  )
}

function ChangeList({
  title,
  changes,
  empty,
}: {
  readonly title: string
  readonly changes: readonly string[]
  readonly empty: string
}) {
  return (
    <section className="flex flex-col gap-xs">
      <h3 className="m-0 text-title text-text-strong">{title}</h3>
      {changes.length === 0 ? (
        <p className="m-0 text-caption text-muted-foreground">{empty}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-xs p-0">
          {changes.map((change) => (
            <li
              className="border-l-2 border-branch-selected pl-sm text-caption text-foreground"
              key={change}
            >
              {change}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function CompareResult({
  copy,
  result,
}: {
  readonly copy: GitReviewCopy
  readonly result: CompareCheckpointsView
}) {
  return (
    <div className="flex flex-col gap-lg">
      <div className="grid grid-cols-4 border-t border-l border-divider max-[680px]:grid-cols-2">
        {[
          [copy.files, result.diffSummary.filesChanged],
          [copy.additions, `+${result.diffSummary.additions}`],
          [copy.deletions, `−${result.diffSummary.deletions}`],
          [copy.binaryFiles, result.diffSummary.binaryFiles],
        ].map(([label, value]) => (
          <div className="border-r border-b border-divider p-sm" key={label}>
            <p className="m-0 text-caption text-muted-foreground">{label}</p>
            <p className="m-0 mt-xxs font-mono text-title text-text-strong">
              {value}
            </p>
          </div>
        ))}
      </div>

      <section className="flex flex-col gap-xs">
        <h3 className="m-0 text-title text-text-strong">{copy.files}</h3>
        <div className="flex flex-col border-t border-divider">
          {result.files.map((file) => (
            <div
              className="flex flex-wrap items-center justify-between gap-sm border-b border-divider py-xs text-caption"
              key={file.fileId}
            >
              <span className="min-w-0 break-all font-mono text-foreground">
                {file.relativePath}
              </span>
              <span className="flex shrink-0 gap-xs">
                <Badge variant="secondary">
                  {copy.changeKinds[file.changeKind]}
                </Badge>
                <span className="text-success">+{file.additions}</span>
                <span className="text-destructive">−{file.deletions}</span>
              </span>
            </div>
          ))}
        </div>
      </section>

      <Separator />
      <ChangeList
        changes={result.verificationChanges}
        empty={copy.noChanges}
        title={copy.verificationChanges}
      />
      <ChangeList
        changes={result.decisionChanges}
        empty={copy.noChanges}
        title={copy.decisionChanges}
      />
      <ChangeList
        changes={result.riskChanges}
        empty={copy.noChanges}
        title={copy.riskChanges}
      />
    </div>
  )
}

interface ComparePanelProps {
  readonly copy: GitReviewCopy
  readonly items: readonly ReviewPackSummary[]
  readonly fromCheckpointId: string | null
  readonly toCheckpointId: string | null
  readonly status: "idle" | "loading" | "ready" | "error"
  readonly result: CompareCheckpointsView | null
  readonly errorCode: string | null
  readonly onSelectionChange: (
    side: "from" | "to",
    checkpointId: string,
  ) => void
  readonly onCompare: () => void
}

export function ComparePanel({
  copy,
  items,
  fromCheckpointId,
  toCheckpointId,
  status,
  result,
  errorCode,
  onSelectionChange,
  onCompare,
}: ComparePanelProps) {
  const invalid =
    fromCheckpointId === null ||
    toCheckpointId === null ||
    fromCheckpointId === toCheckpointId

  return (
    <div className="mx-auto flex w-full max-w-[840px] flex-col gap-lg p-xl max-[680px]:p-md">
      <section
        className="flex flex-col gap-md"
        aria-labelledby="compare-heading"
      >
        <div className="flex items-start gap-sm">
          <GitCompareArrowsIcon
            aria-hidden="true"
            className="mt-xxs size-4 text-branch-selected"
          />
          <div>
            <h2
              className="m-0 text-headline text-text-strong"
              id="compare-heading"
            >
              {copy.compareHeading}
            </h2>
            <p className="m-0 mt-xxs max-w-[70ch] text-caption text-muted-foreground">
              {copy.compareDescription}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-md max-[680px]:grid-cols-1">
          <CheckpointPicker
            copy={copy}
            items={items}
            label={copy.compareFrom}
            onChange={(checkpointId) => onSelectionChange("from", checkpointId)}
            value={fromCheckpointId}
          />
          <CheckpointPicker
            copy={copy}
            items={items}
            label={copy.compareTo}
            onChange={(checkpointId) => onSelectionChange("to", checkpointId)}
            value={toCheckpointId}
          />
        </div>

        <div className="flex items-center gap-sm">
          <Button
            disabled={invalid || status === "loading"}
            onClick={onCompare}
            type="button"
          >
            {status === "loading" ? (
              <LoaderCircleIcon aria-hidden="true" className="animate-spin" />
            ) : (
              <GitCompareArrowsIcon aria-hidden="true" />
            )}
            {copy.compareAction}
          </Button>
          {invalid ? (
            <span className="text-caption text-muted-foreground">
              {copy.compareInvalid}
            </span>
          ) : null}
        </div>
      </section>

      {status === "error" ? (
        <Alert>
          <TriangleAlertIcon aria-hidden="true" className="text-destructive" />
          <AlertTitle>{copy.compareError}</AlertTitle>
          <AlertDescription>
            {copy.errorCode}: <span className="font-mono">{errorCode}</span>
          </AlertDescription>
        </Alert>
      ) : null}

      {status === "ready" && result !== null ? (
        <CompareResult copy={copy} result={result} />
      ) : null}
    </div>
  )
}
