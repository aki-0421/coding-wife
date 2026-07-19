import {
  getCurrentWindow,
  type Window as TauriWindow,
} from "@tauri-apps/api/window"

export const nativeTitlebarHeight = 40.5

type NativeTitlebarWindow = Pick<
  TauriWindow,
  "startDragging" | "toggleMaximize"
>

const interactiveTargetSelector = [
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "[contenteditable='true']",
  "[role='button']",
  "[role='checkbox']",
  "[role='combobox']",
  "[role='link']",
  "[role='menuitem']",
  "[role='option']",
  "[role='radio']",
  "[role='slider']",
  "[role='spinbutton']",
  "[role='switch']",
  "[role='tab']",
  "[role='textbox']",
  "[data-native-titlebar-interactive]",
  "[data-slot='scroll-area-scrollbar']",
].join(",")

function isInteractiveTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(interactiveTargetSelector) !== null
  )
}

export function isNativeTitlebarMouseDown(event: MouseEvent): boolean {
  return (
    event.button === 0 &&
    event.clientY >= 0 &&
    event.clientY < nativeTitlebarHeight &&
    !isInteractiveTarget(event.target)
  )
}

export function installNativeTitlebarControls(
  documentTarget: Document = document,
  nativeWindow: NativeTitlebarWindow = getCurrentWindow(),
): () => void {
  const handleMouseDown = (event: MouseEvent) => {
    if (!isNativeTitlebarMouseDown(event)) return

    event.preventDefault()
    const operation =
      event.detail === 2
        ? nativeWindow.toggleMaximize()
        : nativeWindow.startDragging()
    void operation.catch(() => undefined)
  }

  documentTarget.addEventListener("mousedown", handleMouseDown, true)
  return () =>
    documentTarget.removeEventListener("mousedown", handleMouseDown, true)
}
