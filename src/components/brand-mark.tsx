import type { SVGProps } from "react"

interface BrandMarkProps extends Omit<SVGProps<SVGSVGElement>, "children"> {
  readonly label?: string
}

export function BrandMark({ label, ...props }: BrandMarkProps) {
  const accessibleLabel = label?.trim()

  return (
    <svg
      {...props}
      aria-hidden={accessibleLabel ? undefined : "true"}
      aria-label={accessibleLabel || undefined}
      focusable="false"
      role={accessibleLabel ? "img" : undefined}
      viewBox="0 0 1024 1024"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect fill="#171514" height="1024" rx="160" width="1024" />
      <path
        d="M224 334C320 334 354 420 420 454"
        fill="none"
        stroke="#d0b1a3"
        strokeLinecap="round"
        strokeWidth="68"
      />
      <path
        d="M224 690C320 690 354 604 420 570"
        fill="none"
        stroke="#d4d4d8"
        strokeLinecap="round"
        strokeWidth="68"
      />
      <path
        d="M520 400H700C725 400 749 411 764 431L817 495C826 506 826 518 817 529L764 593C749 613 725 624 700 624H520C500 624 484 608 484 588V436C484 416 500 400 520 400Z"
        fill="#d7d4d2"
      />
    </svg>
  )
}
