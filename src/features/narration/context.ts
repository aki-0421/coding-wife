import { createContext } from "react"

import type { NarrationController } from "@/features/narration/controller"

export const NarrationContext = createContext<NarrationController | null>(null)
