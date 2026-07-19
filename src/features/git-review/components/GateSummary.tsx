import { Badge } from "@/components/ui/badge"
import type { GitReviewCopy } from "@/features/git-review/copy"
import type { GateOutcome, GateResult } from "@/lib/contracts/git-review"

export interface GateSummaryProps {
  readonly copy: GitReviewCopy
  readonly gates: readonly GateResult[]
}

function outcomeVariant(outcome: GateOutcome) {
  if (outcome === "pass") return "success" as const
  if (outcome === "fail") return "destructive" as const
  if (outcome === "needs_review") return "running" as const
  return "outline" as const
}

export function GateSummary({ copy, gates }: GateSummaryProps) {
  return (
    <section
      aria-labelledby="git-observed-gates"
      className="flex flex-col gap-sm"
    >
      <h2
        className="m-0 text-headline text-text-strong"
        id="git-observed-gates"
      >
        {copy.gates}
      </h2>
      <div className="grid grid-cols-2 border-t border-l border-divider max-[680px]:grid-cols-1">
        {gates.map((gate) => (
          <details
            className="group border-r border-b border-divider bg-surface/35 open:bg-surface"
            key={gate.gate}
          >
            <summary className="flex min-h-11 list-none items-center gap-sm px-md py-sm outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
              <span className="flex-1 text-title text-text-strong">
                {copy.gateLabels[gate.gate]}
              </span>
              <Badge variant={outcomeVariant(gate.outcome)}>
                {copy.gateOutcomes[gate.outcome]}
              </Badge>
            </summary>
            <div className="border-t border-divider px-md py-sm text-caption">
              <p className="m-0 text-label text-muted-foreground">
                {copy.reasonCodes}
              </p>
              {gate.reasonCodes.length === 0 ? (
                <p className="m-0 mt-xs text-muted-foreground">
                  {copy.noReasonCodes}
                </p>
              ) : (
                <ul className="m-0 mt-xs grid gap-xs pl-lg">
                  {gate.reasonCodes.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              )}
            </div>
          </details>
        ))}
      </div>
    </section>
  )
}
