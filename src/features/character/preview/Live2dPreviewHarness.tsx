import {
  BotIcon,
  CheckIcon,
  CircleIcon,
  GitBranchIcon,
  MoreHorizontalIcon,
  SettingsIcon,
  TerminalIcon,
} from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { BrandMark } from "@/components/brand-mark"
import { Live2dCharacter } from "@/features/character/components/Live2dCharacter"
import type {
  CharacterControllerStatus,
  CharacterFrameMetrics,
  CharacterMotionPolicy,
  CharacterState,
} from "@/features/character/model"
import type { CharacterController } from "@/features/character/runtime/character-controller"

const states: readonly CharacterState[] = [
  "idle",
  "thinking",
  "acting",
  "waiting_for_user",
  "reviewing",
  "error",
  "completed",
  "disconnected",
]

const timeline = [
  ["Bash", "agent-browser skills get core"],
  ["Bash", "pnpm live2d:verify"],
  ["Read", "docs/research/live2d-runtime-integration.md"],
  ["Bash", "pnpm typecheck && pnpm test"],
] as const

declare global {
  interface Window {
    __live2dPreview?: {
      readonly getMetrics: () => CharacterFrameMetrics | null
      readonly getStatus: () => CharacterControllerStatus | null
      readonly loseContext: () => boolean
      readonly restoreContext: () => boolean
      readonly setPolicy: (policy: CharacterMotionPolicy) => void
      readonly setState: (state: CharacterState) => void
    }
  }
}

export function Live2dPreviewHarness() {
  const controllerRef = useRef<CharacterController | null>(null)
  const metricsRef = useRef<CharacterFrameMetrics | null>(null)
  const statusRef = useRef<CharacterControllerStatus | null>(null)
  const [policy, setPolicy] = useState<CharacterMotionPolicy>("animated")
  const [state, setState] = useState<CharacterState>("acting")
  const [generation, setGeneration] = useState(1)
  const [metrics, setMetrics] = useState<CharacterFrameMetrics | null>(null)
  const [status, setStatus] = useState<CharacterControllerStatus | null>(null)

  useEffect(() => {
    window.__live2dPreview = {
      getMetrics: () => metricsRef.current,
      getStatus: () => statusRef.current,
      loseContext: () =>
        controllerRef.current?.loseContextForDiagnostics() ?? false,
      restoreContext: () =>
        controllerRef.current?.restoreContextForDiagnostics() ?? false,
      setPolicy,
      setState: (nextState) => {
        setGeneration((value) => value + 1)
        setState(nextState)
      },
    }
    return () => {
      delete window.__live2dPreview
    }
  }, [])

  const selectState = (nextState: CharacterState) => {
    setGeneration((value) => value + 1)
    setState(nextState)
  }

  const updateMetrics = (nextMetrics: CharacterFrameMetrics) => {
    metricsRef.current = nextMetrics
    setMetrics(nextMetrics)
  }

  const updateStatus = (nextStatus: CharacterControllerStatus) => {
    statusRef.current = nextStatus
    setStatus(nextStatus)
  }

  return (
    <main className="preview-shell">
      <aside className="preview-sidebar" aria-label="Workspaces">
        <div className="preview-titlebar-spacer" aria-hidden="true" />
        <div className="preview-sidebar-heading">
          <span>Workspaces</span>
          <MoreHorizontalIcon aria-hidden="true" />
        </div>
        <div className="preview-workspace-list">
          <p className="preview-section-label">
            <CheckIcon aria-hidden="true" /> <span>Done</span>
          </p>
          <p className="preview-workspace-row">
            <GitBranchIcon aria-hidden="true" />
            <span>coding-wife/desktop-shell</span>
          </p>
          <p className="preview-section-label preview-running">
            <CircleIcon aria-hidden="true" /> <span>In progress</span>
          </p>
          <p className="preview-workspace-row preview-workspace-selected">
            <BotIcon aria-hidden="true" />
            <span>
              coding-wife/live2d-runtime
              <small>feature/live2d-companion</small>
            </span>
          </p>
        </div>

        <section
          className="preview-diagnostics"
          aria-label="Live2D diagnostics"
        >
          <p>Runtime preview</p>
          <div className="preview-policy-controls">
            {(["animated", "reduced", "hidden"] as const).map((option) => (
              <button
                aria-pressed={policy === option}
                key={option}
                onClick={() => setPolicy(option)}
                type="button"
              >
                {option}
              </button>
            ))}
          </div>
          <select
            aria-label="Character state"
            onChange={(event) =>
              selectState(event.currentTarget.value as CharacterState)
            }
            value={state}
          >
            {states.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          <div className="preview-context-controls">
            <button
              onClick={() => controllerRef.current?.loseContextForDiagnostics()}
              type="button"
            >
              Lose context
            </button>
            <button
              onClick={() =>
                controllerRef.current?.restoreContextForDiagnostics()
              }
              type="button"
            >
              Restore
            </button>
          </div>
          <output
            data-backing-height={metrics?.backingHeight ?? 0}
            data-backing-width={metrics?.backingWidth ?? 0}
            data-frame-count={metrics?.frameCount ?? 0}
            data-last-delta={metrics?.lastDeltaMilliseconds ?? 0}
            data-nontransparent={metrics?.nonTransparentSamples ?? 0}
            data-phase={status?.phase ?? "idle"}
            data-signature={metrics?.signature ?? "00000000"}
            data-signature-changes={metrics?.signatureChanges ?? 0}
            id="live2d-metrics"
          >
            {status?.phase ?? "idle"} · {metrics?.frameCount ?? 0} frames ·{" "}
            {metrics?.nonTransparentSamples ?? 0} alpha samples
          </output>
        </section>

        <button className="preview-settings" type="button">
          <SettingsIcon aria-hidden="true" /> <span>Settings</span>
        </button>
      </aside>

      <section className="preview-workspace">
        <header className="preview-header">
          <div className="preview-breadcrumb">
            <BrandMark className="preview-app-icon" label="Coding Wife" />
            <span>coding-wife</span>
            <span aria-hidden="true">›</span>
            <strong>live2d-runtime</strong>
          </div>
          <nav aria-label="Workspace sections">
            <button aria-current="page" type="button">
              Chat
            </button>
            <button type="button">Commit</button>
            <button type="button">Context</button>
            <button type="button">Settings</button>
          </nav>
        </header>

        <div className="preview-desk">
          <section className="preview-chat" aria-label="Chat timeline">
            <div className="preview-timeline">
              {timeline.map(([label, command]) => (
                <div className="preview-tool-row" key={command}>
                  <TerminalIcon aria-hidden="true" />
                  <span>{label}</span>
                  <code>{command}</code>
                </div>
              ))}
              <p>
                Live2D Core と Framework を固定バージョンで読み込み、同梱された
                Hiyori モデルを透明な canvas に描画しています。モデルの状態は
                HTML の説明と同期し、描画に失敗しても作業は継続できます。
              </p>
              <div className="preview-success">
                <CheckIcon aria-hidden="true" />
                <span>Verified</span>
                <code>17 runtime assets · 13 shaders · first frame</code>
              </div>
              <p>
                リサイズ、reduced motion、非表示、WebGL context loss
                の各経路を同じプレビューで診断できます。
              </p>
            </div>
            <div className="preview-composer" aria-label="Message composer">
              <p>Ask Codex to plan, build, explain, or fix anything…</p>
              <div>
                <span>＋ Add</span>
                <span>@ Context</span>
                <span>GPT-5.6 Sol</span>
                <button type="button">↑ Send</button>
              </div>
            </div>
          </section>

          <section className="preview-character" aria-label="Live2D companion">
            <Live2dCharacter
              locale="ja"
              motionPolicy={policy}
              onControllerChange={(controller) => {
                controllerRef.current = controller
              }}
              onMetricsChange={updateMetrics}
              onStatusChange={updateStatus}
              preserveDrawingBuffer
              state={state}
              stateGeneration={generation}
            />
          </section>
        </div>
      </section>
    </main>
  )
}
