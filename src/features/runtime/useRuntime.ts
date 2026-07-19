import { useContext } from "react"

import {
  RuntimeContext,
  type RuntimeContextValue,
} from "@/features/runtime/context"

export function useRuntime(): RuntimeContextValue {
  const value = useContext(RuntimeContext)

  if (!value) {
    throw new Error("useRuntime must be used within RuntimeProvider")
  }

  return value
}
