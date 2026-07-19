export const MAX_CHARACTER_CUE_ID_BYTES = 80

const cueIdPattern = /^[A-Za-z0-9_.@[\]-]+$/
const motionGroupPattern = /^[A-Za-z0-9_.@-]+$/

export function isCharacterCueId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_CHARACTER_CUE_ID_BYTES &&
    cueIdPattern.test(value)
  )
}

export function characterMotionCueId(
  group: unknown,
  index: number,
): string | null {
  if (
    typeof group !== "string" ||
    !motionGroupPattern.test(group) ||
    !Number.isSafeInteger(index) ||
    index < 0
  ) {
    return null
  }
  const cueId = `${group}[${String(index)}]`
  return isCharacterCueId(cueId) ? cueId : null
}
