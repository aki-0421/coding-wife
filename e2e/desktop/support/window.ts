import { browser } from "@wdio/globals"

export interface LogicalWindowSize {
  readonly width: number
  readonly height: number
}

export interface LogicalWindowMetrics {
  readonly devicePixelRatio: number
  readonly physical: LogicalWindowSize
  readonly viewport: LogicalWindowSize
  readonly webdriver: LogicalWindowSize
}

interface PageViewport {
  readonly devicePixelRatio: number
  readonly height: number
  readonly width: number
}

async function readPageViewport(): Promise<PageViewport> {
  return (await browser.execute(() => {
    const page = globalThis as unknown as {
      readonly devicePixelRatio: number
      readonly document: {
        readonly documentElement: {
          readonly clientHeight: number
          readonly clientWidth: number
        }
      }
    }
    return {
      devicePixelRatio: page.devicePixelRatio,
      height: page.document.documentElement.clientHeight,
      width: page.document.documentElement.clientWidth,
    }
  })) as unknown as PageViewport
}

function requireLogicalDimension(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
}

export async function setLogicalWindowSize(
  size: LogicalWindowSize,
): Promise<LogicalWindowMetrics> {
  requireLogicalDimension(size.width, "logical window width")
  requireLogicalDimension(size.height, "logical window height")

  const initialViewport = await readPageViewport()
  const devicePixelRatio = initialViewport.devicePixelRatio
  if (!Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0) {
    throw new Error("window.devicePixelRatio must be a positive finite number")
  }

  const physical = {
    width: Math.round(size.width * devicePixelRatio),
    height: Math.round(size.height * devicePixelRatio),
  }
  await browser.setWindowSize(physical.width, physical.height)

  let viewport = await readPageViewport()
  await browser.waitUntil(
    async () => {
      viewport = await readPageViewport()
      return viewport.width === size.width && viewport.height === size.height
    },
    {
      timeoutMsg: `Tauri CSS viewport did not reach ${size.width}x${size.height} logical pixels`,
    },
  )

  return {
    devicePixelRatio,
    physical,
    viewport: { width: viewport.width, height: viewport.height },
    webdriver: await browser.getWindowSize(),
  }
}
