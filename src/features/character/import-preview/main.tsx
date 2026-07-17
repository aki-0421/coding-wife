import { createRoot } from "react-dom/client"

import { IsolatedPreviewRuntime } from "@/features/character/import-preview/IsolatedPreviewRuntime"
import { installCharacterPreviewNetworkGuard } from "@/features/character/import-preview/network-guard"

installCharacterPreviewNetworkGuard()

const root = document.getElementById("character-import-preview-root")
if (root === null) throw new Error("Missing character import preview root")
createRoot(root).render(<IsolatedPreviewRuntime />)
