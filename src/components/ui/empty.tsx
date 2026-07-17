import * as React from "react"

import { cn } from "@/lib/utils"

function Empty({ className, ...props }: React.ComponentProps<"section">) {
  return (
    <section
      className={cn(
        "flex min-h-48 w-full flex-col items-center justify-center gap-md text-center",
        className,
      )}
      data-slot="empty"
      {...props}
    />
  )
}

function EmptyHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex max-w-sm flex-col items-center gap-xs", className)}
      data-slot="empty-header"
      {...props}
    />
  )
}

function EmptyTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return (
    <h2
      className={cn("m-0 text-headline text-text-strong", className)}
      data-slot="empty-title"
      {...props}
    />
  )
}

function EmptyDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      className={cn("m-0 text-caption text-muted-foreground", className)}
      data-slot="empty-description"
      {...props}
    />
  )
}

function EmptyContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-center gap-xs",
        className,
      )}
      data-slot="empty-content"
      {...props}
    />
  )
}

export { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle }
