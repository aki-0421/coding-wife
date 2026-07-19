import type { CharacterMotionPolicy } from "@/features/character/model"

export interface CharacterFirstFrameEligibility {
  readonly expectedGeneration: number
  readonly rendererGeneration: number
  readonly motionPolicy: CharacterMotionPolicy
  readonly documentVisible: boolean
  readonly contextLost: boolean
  readonly cssWidth: number
  readonly cssHeight: number
}

export function canConsumeCharacterFirstFrameDeadline({
  expectedGeneration,
  rendererGeneration,
  motionPolicy,
  documentVisible,
  contextLost,
  cssWidth,
  cssHeight,
}: CharacterFirstFrameEligibility): boolean {
  return (
    expectedGeneration === rendererGeneration &&
    motionPolicy === "animated" &&
    documentVisible &&
    !contextLost &&
    Number.isFinite(cssWidth) &&
    Number.isFinite(cssHeight) &&
    cssWidth > 0 &&
    cssHeight > 0
  )
}

export type CharacterFirstFrameDeadlineState =
  | "idle"
  | "paused"
  | "running"
  | "completed"
  | "expired"

export interface CharacterFirstFrameDeadlineSnapshot {
  readonly generation: number | null
  readonly remainingMilliseconds: number
  readonly state: CharacterFirstFrameDeadlineState
}

interface CharacterFirstFrameDeadlineOptions {
  readonly timeoutMilliseconds: number
  readonly onExpire: (generation: number) => void
  readonly now?: () => number
}

export class CharacterFirstFrameDeadline {
  readonly #timeoutMilliseconds: number
  readonly #onExpire: (generation: number) => void
  readonly #now: () => number
  #generation: number | null = null
  #remainingMilliseconds: number
  #startedAt: number | null = null
  #timer: ReturnType<typeof setTimeout> | null = null
  #eligible = false
  #state: CharacterFirstFrameDeadlineState = "idle"

  public constructor({
    timeoutMilliseconds,
    onExpire,
    now = Date.now,
  }: CharacterFirstFrameDeadlineOptions) {
    this.#timeoutMilliseconds = Math.max(0, timeoutMilliseconds)
    this.#remainingMilliseconds = this.#timeoutMilliseconds
    this.#onExpire = onExpire
    this.#now = now
  }

  public get snapshot(): CharacterFirstFrameDeadlineSnapshot {
    return {
      generation: this.#generation,
      remainingMilliseconds: this.remainingMilliseconds,
      state: this.#state,
    }
  }

  public begin(generation: number): void {
    this.clearTimer()
    this.#generation = generation
    this.#remainingMilliseconds = this.#timeoutMilliseconds
    this.#startedAt = null
    this.#eligible = false
    this.#state = "paused"
  }

  public replaceGeneration(
    expectedGeneration: number,
    nextGeneration: number,
  ): boolean {
    if (
      this.#generation !== expectedGeneration ||
      (this.#state !== "paused" && this.#state !== "running")
    ) {
      return false
    }
    this.pause()
    this.#generation = nextGeneration
    this.#eligible = false
    return true
  }

  public setEligible(generation: number, eligible: boolean): void {
    if (
      this.#generation !== generation ||
      (this.#state !== "paused" && this.#state !== "running")
    ) {
      return
    }
    this.#eligible = eligible
    if (eligible) this.start()
    else this.pause()
  }

  public complete(generation: number): void {
    if (this.#generation !== generation) return
    this.clearTimer()
    this.#eligible = false
    this.#startedAt = null
    this.#state = "completed"
  }

  public cancel(generation: number): void {
    if (this.#generation !== generation) return
    this.clearTimer()
    this.#generation = null
    this.#remainingMilliseconds = this.#timeoutMilliseconds
    this.#startedAt = null
    this.#eligible = false
    this.#state = "idle"
  }

  private get remainingMilliseconds(): number {
    if (this.#state !== "running" || this.#startedAt === null) {
      return this.#remainingMilliseconds
    }
    return Math.max(
      0,
      this.#remainingMilliseconds - (this.#now() - this.#startedAt),
    )
  }

  private start(): void {
    if (this.#state === "running") return
    const generation = this.#generation
    if (generation === null) return
    this.#state = "running"
    this.#startedAt = this.#now()
    this.#timer = setTimeout(() => {
      if (
        this.#generation !== generation ||
        this.#state !== "running" ||
        !this.#eligible
      ) {
        return
      }
      this.#timer = null
      this.#startedAt = null
      this.#remainingMilliseconds = 0
      this.#state = "expired"
      this.#onExpire(generation)
    }, this.#remainingMilliseconds)
  }

  private pause(): void {
    if (this.#state !== "running") return
    this.#remainingMilliseconds = this.remainingMilliseconds
    this.clearTimer()
    this.#startedAt = null
    this.#state = "paused"
  }

  private clearTimer(): void {
    if (this.#timer !== null) clearTimeout(this.#timer)
    this.#timer = null
  }
}
