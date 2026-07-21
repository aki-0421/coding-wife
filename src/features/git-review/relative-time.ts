export function formatRelativeTime(
  value: string,
  locale: "ja" | "en",
  now = Date.now(),
) {
  const differenceSeconds = (new Date(value).getTime() - now) / 1_000
  const absoluteSeconds = Math.abs(differenceSeconds)
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" })

  if (absoluteSeconds < 60) {
    return formatter.format(Math.round(differenceSeconds), "second")
  }
  if (absoluteSeconds < 3_600) {
    return formatter.format(Math.round(differenceSeconds / 60), "minute")
  }
  if (absoluteSeconds < 86_400) {
    return formatter.format(Math.round(differenceSeconds / 3_600), "hour")
  }
  if (absoluteSeconds < 2_592_000) {
    return formatter.format(Math.round(differenceSeconds / 86_400), "day")
  }
  if (absoluteSeconds < 31_536_000) {
    return formatter.format(Math.round(differenceSeconds / 2_592_000), "month")
  }
  return formatter.format(Math.round(differenceSeconds / 31_536_000), "year")
}
