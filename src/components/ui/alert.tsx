import * as React from "react"

import { cn } from "@/lib/utils"

function Alert({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "grid w-full grid-cols-[auto_1fr] gap-x-sm gap-y-xxs rounded-control border border-divider bg-surface px-md py-sm text-caption",
        className,
      )}
      data-slot="alert"
      role="alert"
      {...props}
    />
  )
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("col-start-2 text-title text-text-strong", className)}
      data-slot="alert-title"
      {...props}
    />
  )
}

function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("col-start-2 text-muted-foreground", className)}
      data-slot="alert-description"
      {...props}
    />
  )
}

export { Alert, AlertDescription, AlertTitle }
