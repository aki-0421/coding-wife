import { mkdir } from "node:fs/promises"
import path from "node:path"

const appBinaryPath = path.resolve("src-tauri/target/debug/coding-wife")
const resultsRoot = path.resolve("tmp/desktop-qa")

function parsePort(rawPort: string | undefined, source: string): number | null {
  if (rawPort === undefined) return null
  const port = Number(rawPort)
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new Error(`${source} must be an integer between 1024 and 65535`)
  }
  return port
}

const explicitPort = parsePort(
  process.env.CODING_WIFE_WDIO_PORT,
  "CODING_WIFE_WDIO_PORT",
)
const conductorPort = parsePort(process.env.CONDUCTOR_PORT, "CONDUCTOR_PORT")
const derivedPort = (conductorPort ?? 4440) + 5
const embeddedPort =
  explicitPort ??
  parsePort(String(derivedPort), "derived embedded WebDriver port")
if (embeddedPort === null) {
  throw new Error("embedded WebDriver port is required")
}
const appDataDirectory = path.join(resultsRoot, `app-data-${embeddedPort}`)

export const config: WebdriverIO.Config = {
  runner: "local",
  specs: ["./e2e/desktop/**/*.spec.ts"],
  maxInstances: 1,
  capabilities: [
    {
      browserName: "tauri",
      "tauri:options": {
        application: appBinaryPath,
      },
    },
  ],
  services: [
    [
      "@wdio/tauri-service",
      {
        appBinaryPath,
        driverProvider: "embedded",
        embeddedPort,
        captureFrontendLogs: true,
        captureBackendLogs: true,
        frontendLogLevel: "debug",
        backendLogLevel: "debug",
        startTimeout: 60_000,
        commandTimeout: 30_000,
        env: {
          CODING_WIFE_DESKTOP_QA_DATA_DIR: appDataDirectory,
        },
      },
    ],
  ],
  framework: "mocha",
  reporters: ["spec"],
  outputDir: resultsRoot,
  waitforTimeout: 15_000,
  connectionRetryTimeout: 90_000,
  connectionRetryCount: 1,
  mochaOpts: {
    ui: "bdd",
    timeout: 60_000,
  },
  afterTest: async (test, _context, { passed }) => {
    if (passed) return
    await mkdir(resultsRoot, { recursive: true })
    const safeTitle = test.title.replaceAll(/[^a-zA-Z0-9_-]+/g, "_")
    await browser.saveScreenshot(
      path.join(resultsRoot, `${safeTitle || "failed-test"}.png`),
    )
  },
}
