import * as React from "react"

import { cn } from "@/lib/utils"

function FieldGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex w-full flex-col gap-lg", className)}
      data-slot="field-group"
      {...props}
    />
  )
}

function Field({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex w-full flex-col gap-xs", className)}
      data-slot="field"
      role="group"
      {...props}
    />
  )
}

function FieldLabel({ className, ...props }: React.ComponentProps<"label">) {
  return (
    <label
      className={cn("text-title text-text-strong", className)}
      data-slot="field-label"
      {...props}
    />
  )
}

function FieldDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      className={cn("m-0 text-caption text-muted-foreground", className)}
      data-slot="field-description"
      {...props}
    />
  )
}

function FieldSet({ className, ...props }: React.ComponentProps<"fieldset">) {
  return (
    <fieldset
      className={cn("m-0 flex min-w-0 flex-col gap-md border-0 p-0", className)}
      data-slot="field-set"
      {...props}
    />
  )
}

function FieldLegend({ className, ...props }: React.ComponentProps<"legend">) {
  return (
    <legend
      className={cn("mb-sm text-headline text-text-strong", className)}
      data-slot="field-legend"
      {...props}
    />
  )
}

export {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
}
