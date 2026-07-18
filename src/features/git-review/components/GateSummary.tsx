import {
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleHelpIcon,
  ShieldAlertIcon,
  TriangleAlertIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import type { GitReviewCopy } from "@/features/git-review/copy"
import type { GateOutcome, GateResult } from "@/lib/contracts/git-review"

interface GateSummaryProps {
  readonly copy: GitReviewCopy
  readonly gates: readonly GateResult[]
}

function outcomeIcon(outcome: GateOutcome) {
  if (outcome === "pass") {
    return <CheckCircle2Icon aria-hidden="true" className="text-success" />
  }
  if (outcome === "needs_review") {
    return <TriangleAlertIcon aria-hidden="true" className="text-running" />
  }
  if (outcome === "fail") {
    return <ShieldAlertIcon aria-hidden="true" className="text-destructive" />
  }
  return <CircleHelpIcon aria-hidden="true" className="text-muted-foreground" />
}

function outcomeBadge(outcome: GateOutcome, copy: GitReviewCopy) {
  const variant =
    outcome === "pass"
      ? "success"
      : outcome === "needs_review"
        ? "running"
        : outcome === "fail"
          ? "destructive"
          : "outline"

  return <Badge variant={variant}>{copy.gateOutcomes[outcome]}</Badge>
}

export function GateSummary({ copy, gates }: GateSummaryProps) {
  return (
    <section aria-labelledby="review-gates" className="flex flex-col gap-sm">
      <div className="flex items-center justify-between gap-md">
        <h2 className="m-0 text-title text-text-strong" id="review-gates">
          {copy.gatesHeading}
        </h2>
        <span className="text-caption text-muted-foreground">
          {gates.filter((gate) => gate.outcome === "pass").length}/4
        </span>
      </div>

      <div className="grid grid-cols-2 border-t border-l border-divider max-[680px]:grid-cols-1">
        {gates.map((gate) => (
          <details
            className="group border-r border-b border-divider bg-surface/35 open:bg-surface"
            key={gate.gate}
          >
            <summary className="flex min-h-12 list-none items-center gap-sm px-md py-sm outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
              {outcomeIcon(gate.outcome)}
              <span className="min-w-0 flex-1 text-title text-text-strong">
                {copy.gateLabels[gate.gate]}
              </span>
              {outcomeBadge(gate.outcome, copy)}
              <ChevronDownIcon
                aria-hidden="true"
                className="size-3 text-muted-foreground transition-transform group-open:rotate-180"
              />
            </summary>
            <div className="flex flex-col gap-sm border-t border-divider px-md py-sm text-caption">
              <div>
                <h3 className="m-0 text-label text-text-secondary">
                  {copy.reasonCodes}
                </h3>
                {gate.reasonCodes.length > 0 ? (
                  <ul className="m-0 mt-xs flex list-none flex-wrap gap-xs p-0">
                    {gate.reasonCodes.map((reason) => (
                      <li
                        className="rounded-control bg-code-chip px-xs py-xxs font-mono text-caption text-foreground"
                        key={reason}
                      >
                        {reason}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="m-0 mt-xs text-muted-foreground">
                    {copy.noReasonCodes}
                  </p>
                )}
              </div>
              <div>
                <h3 className="m-0 text-label text-text-secondary">
                  {copy.observedFingerprint}
                </h3>
                <p className="m-0 mt-xs break-all font-mono text-caption text-muted-foreground">
                  {gate.observedRepositoryFingerprint}
                </p>
              </div>
              {gate.outcome !== "pass" ? (
                <p className="m-0 border-l-2 border-running pl-sm text-muted-foreground">
                  {copy.gateRecovery[gate.gate]}
                </p>
              ) : null}
            </div>
          </details>
        ))}
      </div>
    </section>
  )
}
