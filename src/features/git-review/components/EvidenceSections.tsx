import { Badge } from "@/components/ui/badge"
import type { GitReviewCopy } from "@/features/git-review/copy"
import type { CommitEvidenceDetail } from "@/lib/contracts/git-review"

import { GateSummary } from "@/features/git-review/components/GateSummary"

export interface EvidenceSectionsProps {
  readonly copy: GitReviewCopy
  readonly detail: CommitEvidenceDetail
}

function EmptyLine({ children }: { readonly children: string }) {
  return <p className="m-0 text-caption text-muted-foreground">{children}</p>
}

export function EvidenceSections({ copy, detail }: EvidenceSectionsProps) {
  return (
    <div className="mx-auto flex w-full max-w-[900px] flex-col gap-xl p-xl max-[680px]:p-md">
      <GateSummary copy={copy} gates={detail.gates} />

      <section
        className="flex flex-col gap-sm"
        aria-labelledby="verification-evidence"
      >
        <h2
          className="m-0 text-headline text-text-strong"
          id="verification-evidence"
        >
          {copy.verificationEvidence}
        </h2>
        {detail.verification.length === 0 ? (
          <EmptyLine>{copy.noVerification}</EmptyLine>
        ) : (
          <div className="border-t border-divider">
            {detail.verification.map((item) => (
              <div
                className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-md gap-y-xxs border-b border-divider py-sm"
                key={item.evidenceId}
              >
                <span className="text-title text-text-strong">
                  {item.check}
                </span>
                <Badge
                  variant={
                    item.result === "passed"
                      ? "success"
                      : item.result === "failed"
                        ? "destructive"
                        : "outline"
                  }
                >
                  {copy.verificationResults[item.result]}
                </Badge>
                <span className="text-caption text-muted-foreground">
                  {item.summary || item.sourceEventId}
                </span>
                <span className="text-caption text-muted-foreground">
                  {item.durationMs.toLocaleString()} ms
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section
        className="flex flex-col gap-sm"
        aria-labelledby="decision-evidence"
      >
        <h2
          className="m-0 text-headline text-text-strong"
          id="decision-evidence"
        >
          {copy.decisions}
        </h2>
        {detail.decisions.length === 0 ? (
          <EmptyLine>{copy.noDecisions}</EmptyLine>
        ) : (
          <div className="border-t border-divider">
            {detail.decisions.map((item) => (
              <div
                className="grid gap-xs border-b border-divider py-sm"
                key={item.decisionId}
              >
                <span className="text-title text-text-strong">
                  {item.summary}
                </span>
                <p className="m-0 text-caption">
                  <span className="text-muted-foreground">{copy.answer}: </span>
                  {item.answer}
                </p>
                {item.rationale ? (
                  <p className="m-0 text-caption">
                    <span className="text-muted-foreground">
                      {copy.rationale}:{" "}
                    </span>
                    {item.rationale}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>

      <section
        className="flex flex-col gap-sm"
        aria-labelledby="attempt-evidence"
      >
        <h2
          className="m-0 text-headline text-text-strong"
          id="attempt-evidence"
        >
          {copy.failedAttempts}
        </h2>
        {detail.failedAttempts.length === 0 ? (
          <EmptyLine>{copy.noFailedAttempts}</EmptyLine>
        ) : (
          <div className="border-t border-divider">
            {detail.failedAttempts.map((item) => (
              <div
                className="grid gap-xs border-b border-divider py-sm"
                key={item.attemptId}
              >
                <span className="text-title text-text-strong">
                  {item.approach}
                </span>
                <p className="m-0 text-caption text-muted-foreground">
                  {item.outcome}
                </p>
                {item.learning ? (
                  <p className="m-0 text-caption">
                    <span className="text-muted-foreground">
                      {copy.learning}:{" "}
                    </span>
                    {item.learning}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-sm" aria-labelledby="risk-evidence">
        <h2 className="m-0 text-headline text-text-strong" id="risk-evidence">
          {copy.risks}
        </h2>
        {detail.risks.length === 0 ? (
          <EmptyLine>{copy.noRisks}</EmptyLine>
        ) : (
          <div className="border-t border-divider">
            {detail.risks.map((item) => (
              <div
                className="grid gap-xs border-b border-divider py-sm"
                key={item.riskId}
              >
                <span className="flex flex-wrap items-center gap-xs">
                  <span className="text-title text-text-strong">
                    {item.summary}
                  </span>
                  <Badge
                    variant={
                      item.resolved
                        ? "success"
                        : item.level === "critical" || item.level === "high"
                          ? "destructive"
                          : "running"
                    }
                  >
                    {copy.riskLevels[item.level]}
                  </Badge>
                </span>
                {item.mitigation ? (
                  <p className="m-0 text-caption">
                    <span className="text-muted-foreground">
                      {copy.mitigation}:{" "}
                    </span>
                    {item.mitigation}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-sm" aria-labelledby="skill-audit">
        <h2 className="m-0 text-headline text-text-strong" id="skill-audit">
          {copy.skillAudit}
        </h2>
        {detail.commitSkillInjection === null ? (
          <EmptyLine>{copy.uncorrelated}</EmptyLine>
        ) : (
          <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-lg gap-y-xs border-t border-divider py-sm text-caption">
            <dt className="text-muted-foreground">{copy.skillVersion}</dt>
            <dd className="m-0">{detail.commitSkillInjection.skillVersion}</dd>
            <dt className="text-muted-foreground">{copy.injectionMode}</dt>
            <dd className="m-0">{detail.commitSkillInjection.injectionMode}</dd>
            <dt className="text-muted-foreground">Digest</dt>
            <dd className="m-0 truncate font-mono">
              {detail.commitSkillInjection.contentDigest}
            </dd>
          </dl>
        )}
      </section>
    </div>
  )
}
