import { useId, useState, type FormEvent } from "react"

import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { useI18n } from "@/features/localization"
import {
  useNativeReadiness,
  useNativeReadinessController,
} from "@/features/readiness/hooks"
import { cn } from "@/lib/utils"

const copy = {
  en: {
    label: "Custom Codex CLI path",
    description:
      "Coding Wife checks your default shell automatically. If Codex is elsewhere, enter its absolute executable path.",
    placeholder: "/Users/you/.local/bin/codex",
    save: "Use this path",
    saving: "Checking path…",
    automatic: "Use automatic detection",
    configured: "Custom path configured.",
    automaticEnabled: "Automatic detection enabled.",
    invalid:
      "Enter an absolute path to the Codex executable, up to 4,096 bytes.",
    failed: "This Codex path could not be verified.",
    safeCode: "Safe code",
    customActive: "A custom path is currently configured.",
  },
  ja: {
    label: "Codex CLIのカスタムパス",
    description:
      "通常はデフォルトシェルから自動検出します。別の場所にある場合は実行ファイルの絶対パスを入力してください。",
    placeholder: "/Users/you/.local/bin/codex",
    save: "このパスを使用",
    saving: "パスを確認中…",
    automatic: "自動検出を使用",
    configured: "カスタムパスを設定しました。",
    automaticEnabled: "自動検出へ戻しました。",
    invalid: "Codex実行ファイルの絶対パスを4,096 byte以内で入力してください。",
    failed: "このCodexパスを検証できませんでした。",
    safeCode: "安全なコード",
    customActive: "現在はカスタムパスが設定されています。",
  },
} as const

function isValidPath(value: string): boolean {
  return (
    value.length > 0 &&
    value.startsWith("/") &&
    value.trim() === value &&
    new TextEncoder().encode(value).length <= 4_096 &&
    !Array.from(value).some((character) => /\p{Cc}/u.test(character))
  )
}

function explicitPathConfigured(
  facts: readonly { readonly key: string; readonly value: string }[],
): boolean {
  return facts.some(
    (fact) => fact.key === "codex_binary_source" && fact.value === "explicit",
  )
}

export function CodexBinaryPathSettings({
  compact = false,
}: {
  readonly compact?: boolean
}) {
  const { locale } = useI18n()
  const ui = copy[locale]
  const inputId = useId()
  const state = useNativeReadiness()
  const controller = useNativeReadinessController()
  const [path, setPath] = useState("")
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const [invalid, setInvalid] = useState(false)
  const [announcement, setAnnouncement] = useState("")
  const codex = state.snapshot?.checks.find((check) => check.id === "codex")
  const customConfigured = explicitPathConfigured(codex?.facts ?? [])
  const busy =
    state.status === "loading" ||
    state.status === "rechecking" ||
    state.status === "configuring"

  if (state.snapshot?.source !== "native") return null

  const configure = async (nextPath: string | null) => {
    setErrorCode(null)
    setInvalid(false)
    setAnnouncement("")
    const succeeded = await controller.configureCodexBinary(nextPath)
    if (succeeded) {
      setPath("")
      setAnnouncement(nextPath === null ? ui.automaticEnabled : ui.configured)
      return
    }
    setErrorCode(
      controller.getSnapshot().errorCode ?? "READINESS-CODEX-PATH-INVALID",
    )
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!isValidPath(path)) {
      setInvalid(true)
      setErrorCode(null)
      return
    }
    void configure(path)
  }

  return (
    <form
      className={cn(
        "flex w-full flex-col gap-sm",
        compact &&
          "mt-md rounded-control border border-divider bg-background/40 p-md",
      )}
      data-codex-binary-settings=""
      onSubmit={submit}
    >
      <Field data-invalid={invalid || errorCode !== null || undefined}>
        <FieldLabel htmlFor={inputId}>{ui.label}</FieldLabel>
        <FieldDescription id={`${inputId}-description`}>
          {ui.description}
        </FieldDescription>
        {customConfigured ? (
          <span className="text-caption text-foreground">
            {ui.customActive}
          </span>
        ) : null}
        <div className="flex items-center gap-xs max-[640px]:flex-col max-[640px]:items-stretch">
          <Input
            aria-describedby={`${inputId}-description`}
            aria-invalid={invalid || errorCode !== null || undefined}
            autoComplete="off"
            disabled={busy}
            id={inputId}
            onChange={(event) => {
              setPath(event.target.value)
              setInvalid(false)
              setErrorCode(null)
              setAnnouncement("")
            }}
            placeholder={ui.placeholder}
            spellCheck={false}
            value={path}
          />
          <Button disabled={busy || path.length === 0} size="sm" type="submit">
            {busy ? ui.saving : ui.save}
          </Button>
        </div>
        {invalid ? (
          <span className="text-caption text-destructive" role="alert">
            {ui.invalid}
          </span>
        ) : null}
        {errorCode !== null ? (
          <span
            className="flex flex-wrap items-center gap-xs text-caption text-destructive"
            role="alert"
          >
            <span>{ui.failed}</span>
            <span>{ui.safeCode}</span>
            <code className="font-mono text-label">{errorCode}</code>
          </span>
        ) : null}
      </Field>
      {customConfigured ? (
        <Button
          className="w-fit"
          disabled={busy}
          onClick={() => void configure(null)}
          size="xs"
          type="button"
          variant="outline"
        >
          {ui.automatic}
        </Button>
      ) : null}
      <span aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </form>
  )
}
