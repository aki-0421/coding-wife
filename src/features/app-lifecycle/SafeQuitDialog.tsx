import { useRef } from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type { SafeQuitCopy } from "@/features/app-lifecycle/copy"

export type SafeQuitDialogStatus =
  | "confirming"
  | "canceling"
  | "stopping"
  | "stop_failed"
  | "cancel_failed"

export interface SafeQuitDialogProps {
  readonly copy: SafeQuitCopy
  readonly open: boolean
  readonly status: SafeQuitDialogStatus
  readonly onDontQuit: () => void
  readonly onStopAndQuit: () => void
}

export function SafeQuitDialog({
  copy,
  open,
  status,
  onDontQuit,
  onStopAndQuit,
}: SafeQuitDialogProps) {
  const originRef = useRef<HTMLElement | null>(null)
  const safeActionRef = useRef<HTMLButtonElement | null>(null)
  const processing = status === "canceling" || status === "stopping"

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !processing) onDontQuit()
      }}
      open={open}
    >
      <DialogContent
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          const origin = originRef.current
          originRef.current = null
          window.requestAnimationFrame(() => origin?.focus())
        }}
        onEscapeKeyDown={(event) => {
          event.preventDefault()
          if (!processing) onDontQuit()
        }}
        onInteractOutside={(event) => event.preventDefault()}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          if (document.activeElement instanceof HTMLElement) {
            originRef.current = document.activeElement
          }
          safeActionRef.current?.focus()
        }}
        showCloseButton={false}
      >
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        {status === "stop_failed" || status === "cancel_failed" ? (
          <p
            className="m-0 text-caption text-destructive"
            role="alert"
          >
            {status === "stop_failed" ? copy.stopFailed : copy.cancelFailed}
          </p>
        ) : processing ? (
          <p
            aria-live="polite"
            className="m-0 text-caption text-muted-foreground"
            role="status"
          >
            {status === "stopping" ? copy.stopping : copy.canceling}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            disabled={processing}
            onClick={onDontQuit}
            ref={safeActionRef}
            type="button"
            variant="ghost"
          >
            {copy.dontQuit}
          </Button>
          <Button
            disabled={processing}
            onClick={onStopAndQuit}
            type="button"
          >
            {status === "stopping" ? copy.stopping : copy.stopAndQuit}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
