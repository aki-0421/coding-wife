import { createContext } from "react"

import type { NativeReadinessController } from "@/features/readiness/controller"

export const NativeReadinessContext =
  createContext<NativeReadinessController | null>(null)
