import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex h-5 w-fit shrink-0 items-center justify-center gap-xxs rounded-circle border px-xs text-label whitespace-nowrap",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-divider bg-secondary text-secondary-foreground",
        destructive: "border-destructive/40 bg-destructive/10 text-destructive",
        outline: "border-divider bg-transparent text-muted-foreground",
        success: "border-success/50 bg-success/10 text-success",
        running: "border-running/50 bg-running/10 text-running",
      },
    },
    defaultVariants: { variant: "outline" },
  },
)

function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return (
    <span
      className={cn(badgeVariants({ variant }), className)}
      data-slot="badge"
      {...props}
    />
  )
}

export { Badge, badgeVariants }
