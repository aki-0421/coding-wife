import type { WorkspaceLifecycle } from "@/features/workspace-view/types"
import { cn } from "@/lib/utils"

const lifecycleColor = {
  done: "text-warm-active",
  in_review: "text-success",
  in_progress: "text-running",
  backlog: "text-muted-foreground",
  canceled: "text-canceled",
} as const satisfies Readonly<Record<WorkspaceLifecycle, string>>

export function WorkspaceLifecycleIcon({
  className,
  lifecycle,
}: {
  readonly className?: string
  readonly lifecycle: WorkspaceLifecycle
}) {
  return (
    <svg
      aria-hidden="true"
      className={cn(
        "size-3 shrink-0 overflow-visible",
        lifecycleColor[lifecycle],
        className,
      )}
      data-linear-status-icon={lifecycle}
      fill="none"
      focusable="false"
      viewBox="0 0 16 16"
    >
      {lifecycle === "backlog" ? (
        <circle
          cx="8"
          cy="8"
          r="6.25"
          stroke="currentColor"
          strokeDasharray="1.25 2.25"
          strokeLinecap="round"
          strokeWidth="1.5"
        />
      ) : null}

      {lifecycle === "in_progress" ? (
        <>
          <path d="M8 1.75A6.25 6.25 0 0 1 14.25 8H8Z" fill="currentColor" />
          <circle
            cx="8"
            cy="8"
            r="6.25"
            stroke="currentColor"
            strokeWidth="1.5"
          />
        </>
      ) : null}

      {lifecycle === "in_review" ? (
        <>
          <path d="M8 1.75A6.25 6.25 0 0 1 8 14.25Z" fill="currentColor" />
          <circle
            cx="8"
            cy="8"
            r="6.25"
            stroke="currentColor"
            strokeWidth="1.5"
          />
        </>
      ) : null}

      {lifecycle === "done" ? (
        <>
          <circle cx="8" cy="8" fill="currentColor" r="6.5" />
          <path
            d="m4.75 8.15 2.1 2.1 4.4-4.5"
            stroke="var(--app-bg)"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.65"
          />
        </>
      ) : null}

      {lifecycle === "canceled" ? (
        <>
          <circle cx="8" cy="8" fill="currentColor" r="6.5" />
          <path
            d="m5.35 5.35 5.3 5.3m0-5.3-5.3 5.3"
            stroke="var(--app-bg)"
            strokeLinecap="round"
            strokeWidth="1.5"
          />
        </>
      ) : null}
    </svg>
  )
}
