import * as React from "react"
import { Switch as SwitchPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "group/switch relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-circle border border-divider bg-code-chip outline-none transition-colors after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring data-[state=checked]:bg-primary disabled:cursor-not-allowed disabled:opacity-60",
        className,
      )}
      data-slot="switch"
      {...props}
    >
      <SwitchPrimitive.Thumb className="pointer-events-none block size-4 translate-x-px rounded-circle bg-foreground transition-transform group-data-[state=checked]/switch:translate-x-[14px] group-data-[state=checked]/switch:bg-primary-foreground" />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
