import * as React from "react"
import { ToggleGroup as ToggleGroupPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function ToggleGroup({
  className,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Root>) {
  return (
    <ToggleGroupPrimitive.Root
      className={cn("flex w-fit items-center gap-xxs", className)}
      data-slot="toggle-group"
      {...props}
    />
  )
}

function ToggleGroupItem({
  className,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Item>) {
  return (
    <ToggleGroupPrimitive.Item
      className={cn(
        "inline-flex h-6 min-w-6 items-center justify-center rounded-control border border-transparent px-sm text-label text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring data-[state=on]:bg-selected-row data-[state=on]:text-text-strong disabled:pointer-events-none disabled:text-disabled",
        className,
      )}
      data-slot="toggle-group-item"
      {...props}
    />
  )
}

export { ToggleGroup, ToggleGroupItem }
