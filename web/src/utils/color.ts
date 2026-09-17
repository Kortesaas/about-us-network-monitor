function channels(hex: string) {
  const value = hex.replace('#', '')
  if (!/^[0-9a-fA-F]{6}$/.test(value)) return null
  return [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16))
}

export function relativeLuminance(hex: string) {
  const rgb = channels(hex)
  if (!rgb) return 0
  const linear = rgb.map((c) => c / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!
}

/** WCAG-friendly black or white text for a six-digit hex background. */
export function readableTextColor(background: string): '#ffffff' | '#0f172a' {
  if (!channels(background)) return '#0f172a'
  return relativeLuminance(background) > 0.35 ? '#0f172a' : '#ffffff'
}

export function withAlpha(hex: string, alpha: number) {
  const rgb = channels(hex)
  if (!rgb) return hex
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`
}
