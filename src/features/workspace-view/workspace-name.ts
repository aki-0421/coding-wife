export function defaultWorkspaceName(): string {
  const now = new Date()
  const part = (value: number) => value.toString().padStart(2, "0")
  const suffix =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID().slice(0, 4)
      : Math.floor(Math.random() * 36 ** 4)
          .toString(36)
          .padStart(4, "0")
  return `ws-${part(now.getMonth() + 1)}${part(now.getDate())}-${suffix}`
}
