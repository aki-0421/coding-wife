export interface PublicTextOptions {
  readonly allowEmpty?: boolean
  readonly multiline?: boolean
}

const privateMaterialPatterns = [
  /(?:^|[\s"'])\/(?:users|volumes|library|applications)\//iu,
  /(?:bearer\s+[a-z0-9._~+/=-]{6,}|(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|auth[_ -]?cookie|session[_ -]?id|sessionid|set-cookie)\s*[:=])/iu,
  /\b(?:sk|sess|rk|pk)-[A-Za-z0-9_-]{12,}\b/u,
  /chain-of-thought/iu,
] as const

export function unicodeScalarCount(value: string): number {
  return Array.from(value).length
}

export function containsPrivateMaterial(value: string): boolean {
  return privateMaterialPatterns.some((pattern) => pattern.test(value))
}

export function isPublicText(
  value: unknown,
  maximumScalars: number,
  options: PublicTextOptions = {},
): value is string {
  if (
    typeof value !== "string" ||
    (!options.allowEmpty && value.trim().length === 0) ||
    unicodeScalarCount(value) > maximumScalars ||
    containsPrivateMaterial(value)
  ) {
    return false
  }

  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code === 10 || code === 9) {
      if (options.multiline) continue
      return false
    }
    if (code === 13 || code < 32 || (code >= 127 && code <= 159)) {
      return false
    }
  }
  return true
}

export function isPublicSingleLineText(
  value: unknown,
  maximumScalars: number,
  allowEmpty = false,
): value is string {
  return isPublicText(value, maximumScalars, { allowEmpty })
}

export function isPublicMultilineText(
  value: unknown,
  maximumScalars: number,
  allowEmpty = false,
): value is string {
  return isPublicText(value, maximumScalars, {
    allowEmpty,
    multiline: true,
  })
}
