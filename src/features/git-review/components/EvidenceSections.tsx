import {
  CheckCircle2Icon,
  CircleDashedIcon,
  LightbulbIcon,
  RotateCcwIcon,
  ShieldAlertIcon,
  TriangleAlertIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import type { GitReviewCopy } from "@/features/git-review/copy"
import type { SupportedLocale } from "@/features/localization/types"
import type { ReviewPack, VerificationResult } from "@/lib/contracts/git-review"

import { GateSummary } from "@/features/git-review/components/GateSummary"

interface PackSectionProps {
  readonly copy: GitReviewCopy
  readonly locale: SupportedLocale
  readonly pack: ReviewPack
}

function verificationBadge(result: VerificationResult, copy: GitReviewCopy) {
  if (result === "passed") {
    return (
      <Badge variant="success">
        <CheckCircle2Icon aria-hidden="true" />
        {copy.verificationResults[result]}
      </Badge>
    )
  }
  if (result === "failed") {
    return (
      <Badge variant="destructive">
        <TriangleAlertIcon aria-hidden="true" />
        {copy.verificationResults[result]}
      </Badge>
    )
  }
  return (
    <Badge variant={result === "inconclusive" ? "running" : "outline"}>
      <CircleDashedIcon aria-hidden="true" />
      {copy.verificationResults[result]}
    </Badge>
  )
}

export function OverviewSection({ copy, locale, pack }: PackSectionProps) {
  const dateFormatter = new Intl.DateTimeFormat(
    locale === "ja" ? "ja-JP" : "en-US",
    { dateStyle: "long", timeStyle: "short" },
  )

  return (
    <div className="mx-auto flex w-full max-w-[900px] flex-col gap-xl p-xl max-[680px]:p-md">
      <GateSummary copy={copy} gates={pack.gates} />

      <Separator />

      <section className="grid grid-cols-[minmax(0,1.4fr)_minmax(240px,0.6fr)] gap-xl max-[760px]:grid-cols-1">
        <div className="flex flex-col gap-lg">
          <div className="flex flex-col gap-xs">
            <h2 className="m-0 text-title text-text-strong">
              {copy.objective}
            </h2>
            <p className="m-0 max-w-[75ch] text-body text-foreground">
              {pack.objective}
            </p>
          </div>

          <div className="flex flex-col gap-xs">
            <h2 className="m-0 text-title text-text-strong">
              {copy.acceptance}
            </h2>
            <ol className="m-0 flex flex-col gap-xs pl-lg text-caption text-foreground">
              {pack.acceptance.map((criterion) => (
                <li key={criterion}>{criterion}</li>
              ))}
            </ol>
          </div>

          <div className="flex flex-col gap-xs">
            <h2 className="m-0 text-title text-text-strong">
              {copy.commitMessage}
            </h2>
            <pre className="m-0 overflow-x-auto whitespace-pre-wrap border-l-2 border-warm-active bg-code-chip px-md py-sm font-mono text-caption text-foreground">
              {pack.checkpoint.message}
            </pre>
          </div>
        </div>

        <div className="flex flex-col gap-lg">
          <section className="flex flex-col gap-xs">
            <h2 className="m-0 text-title text-text-strong">
              {copy.diffSummary}
            </h2>
            <dl className="m-0 flex flex-col border-t border-divider text-caption">
              {[
                [copy.files, pack.diffSummary.filesChanged],
                [copy.additions, `+${pack.diffSummary.additions}`],
                [copy.deletions, `−${pack.diffSummary.deletions}`],
                [copy.binaryFiles, pack.diffSummary.binaryFiles],
              ].map(([label, value]) => (
                <div
                  className="flex items-center justify-between gap-md border-b border-divider py-xs"
                  key={label}
                >
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="m-0 font-mono text-text-strong">{value}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section className="flex flex-col gap-xs">
            <h2 className="m-0 text-title text-text-strong">
              {copy.checkpointMetadata}
            </h2>
            <dl className="m-0 flex flex-col gap-sm text-caption">
              <div>
                <dt className="text-muted-foreground">{copy.shortSha}</dt>
                <dd className="m-0 mt-xxs break-all font-mono text-text-strong">
                  {pack.checkpoint.commitSha}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{copy.createdAt}</dt>
                <dd className="m-0 mt-xxs text-foreground">
                  <time dateTime={pack.checkpoint.createdAt}>
                    {dateFormatter.format(new Date(pack.checkpoint.createdAt))}
                  </time>
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  {copy.targetReference}
                </dt>
                <dd className="m-0 mt-xxs break-all font-mono text-foreground">
                  {pack.checkpoint.targetReference}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{copy.author}</dt>
                <dd className="m-0 mt-xxs text-foreground">
                  {pack.checkpoint.authorName}
                </dd>
              </div>
            </dl>
          </section>
        </div>
      </section>
    </div>
  )
}

export function VerificationSection({ copy, pack }: PackSectionProps) {
  return (
    <div className="mx-auto flex w-full max-w-[840px] flex-col gap-sm p-xl max-[680px]:p-md">
      <h2 className="m-0 text-headline text-text-strong">
        {copy.tabs.verification}
      </h2>
      <div className="flex flex-col border-t border-divider">
        {pack.verification.map((evidence) => (
          <section
            className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-md gap-y-xs border-b border-divider py-md"
            key={evidence.evidenceId}
          >
            <div className="min-w-0">
              <h3 className="m-0 break-all font-mono text-caption text-text-strong">
                {evidence.check}
              </h3>
              <p className="m-0 mt-xs text-caption text-muted-foreground">
                {evidence.summary}
              </p>
            </div>
            {verificationBadge(evidence.result, copy)}
            <p className="col-span-2 m-0 flex flex-wrap gap-md text-caption text-muted-foreground">
              <span>
                {copy.duration}: {(evidence.durationMs / 1000).toFixed(2)}s
              </span>
              <span className="break-all font-mono">
                {evidence.observedRepositoryFingerprint}
              </span>
            </p>
          </section>
        ))}
      </div>
    </div>
  )
}

export function DecisionsSection({ copy, pack }: PackSectionProps) {
  return (
    <div className="mx-auto flex w-full max-w-[840px] flex-col gap-sm p-xl max-[680px]:p-md">
      <h2 className="m-0 text-headline text-text-strong">
        {copy.tabs.decisions}
      </h2>
      {pack.decisions.length === 0 ? (
        <p className="m-0 text-caption text-muted-foreground">
          {copy.noDecisions}
        </p>
      ) : (
        <div className="flex flex-col border-t border-divider">
          {pack.decisions.map((decision) => (
            <section
              className="grid gap-xs border-b border-divider py-md"
              key={decision.decisionId}
            >
              <div className="flex items-start justify-between gap-md">
                <h3 className="m-0 text-title text-text-strong">
                  {decision.summary}
                </h3>
                <Badge variant={decision.reversible ? "success" : "running"}>
                  <RotateCcwIcon aria-hidden="true" />
                  {decision.reversible ? copy.reversible : copy.irreversible}
                </Badge>
              </div>
              <dl className="m-0 grid grid-cols-[90px_minmax(0,1fr)] gap-x-md gap-y-xs text-caption max-[560px]:grid-cols-1">
                <dt className="text-muted-foreground">{copy.answer}</dt>
                <dd className="m-0 text-foreground">{decision.answer}</dd>
                <dt className="text-muted-foreground">{copy.rationale}</dt>
                <dd className="m-0 text-foreground">{decision.rationale}</dd>
              </dl>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}

export function AttemptsSection({ copy, pack }: PackSectionProps) {
  return (
    <div className="mx-auto flex w-full max-w-[840px] flex-col gap-sm p-xl max-[680px]:p-md">
      <h2 className="m-0 text-headline text-text-strong">
        {copy.tabs.attempts}
      </h2>
      {pack.failedAttempts.length === 0 ? (
        <p className="m-0 text-caption text-muted-foreground">
          {copy.noAttempts}
        </p>
      ) : (
        <div className="flex flex-col border-t border-divider">
          {pack.failedAttempts.map((attempt) => (
            <section
              className="flex flex-col gap-xs border-b border-divider py-md"
              key={attempt.attemptId}
            >
              <div className="flex items-start gap-sm">
                <TriangleAlertIcon
                  aria-hidden="true"
                  className="mt-xxs size-3 shrink-0 text-running"
                />
                <h3 className="m-0 text-title text-text-strong">
                  {attempt.approach}
                </h3>
              </div>
              <dl className="m-0 grid grid-cols-[90px_minmax(0,1fr)] gap-x-md gap-y-xs pl-lg text-caption max-[560px]:grid-cols-1 max-[560px]:pl-0">
                <dt className="text-muted-foreground">{copy.attemptOutcome}</dt>
                <dd className="m-0 text-foreground">{attempt.outcome}</dd>
                <dt className="text-muted-foreground">{copy.learning}</dt>
                <dd className="m-0 flex gap-xs text-foreground">
                  <LightbulbIcon
                    aria-hidden="true"
                    className="mt-xxs size-3 shrink-0 text-warm-active"
                  />
                  {attempt.learning}
                </dd>
              </dl>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}

export function RisksSection({ copy, pack }: PackSectionProps) {
  return (
    <div className="mx-auto flex w-full max-w-[840px] flex-col gap-sm p-xl max-[680px]:p-md">
      <h2 className="m-0 text-headline text-text-strong">{copy.tabs.risks}</h2>
      {pack.risks.length === 0 ? (
        <p className="m-0 text-caption text-muted-foreground">{copy.noRisks}</p>
      ) : (
        <div className="flex flex-col border-t border-divider">
          {pack.risks.map((risk) => (
            <section
              className="grid gap-xs border-b border-divider py-md"
              key={risk.riskId}
            >
              <div className="flex flex-wrap items-start justify-between gap-sm">
                <div className="flex min-w-0 items-start gap-sm">
                  <ShieldAlertIcon
                    aria-hidden="true"
                    className={`mt-xxs size-3 shrink-0 ${risk.resolved ? "text-success" : "text-destructive"}`}
                  />
                  <div>
                    <h3 className="m-0 text-title text-text-strong">
                      {risk.summary}
                    </h3>
                    <p className="m-0 mt-xxs font-mono text-caption text-muted-foreground">
                      {risk.category}
                    </p>
                  </div>
                </div>
                <div className="flex gap-xs">
                  <Badge
                    variant={
                      risk.level === "high" || risk.level === "critical"
                        ? "destructive"
                        : risk.level === "medium"
                          ? "running"
                          : "outline"
                    }
                  >
                    {copy.riskLevels[risk.level]}
                  </Badge>
                  <Badge variant={risk.resolved ? "success" : "destructive"}>
                    {risk.resolved ? copy.resolved : copy.unresolved}
                  </Badge>
                </div>
              </div>
              <dl className="m-0 grid grid-cols-[90px_minmax(0,1fr)] gap-x-md gap-y-xs pl-lg text-caption max-[560px]:grid-cols-1 max-[560px]:pl-0">
                <dt className="text-muted-foreground">{copy.mitigation}</dt>
                <dd className="m-0 text-foreground">{risk.mitigation}</dd>
              </dl>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
