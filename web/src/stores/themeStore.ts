import { create } from 'zustand'

export type Theme = 'light' | 'dark' | 'system'
const KEY = 'aboutus-monitor-theme'

const stored = (): Theme => {
  try {
    return (localStorage.getItem(KEY) as Theme | null) ?? 'dark'
  } catch {
    return 'dark'
  }
}

export const useThemeStore = create<{ theme: Theme; setTheme: (theme: Theme) => void }>((set) => ({
  theme: stored(),
  setTheme: (theme) => {
    try {
      localStorage.setItem(KEY, theme)
    } catch {
      /* private mode */
    }
    set({ theme })
    applyTheme(theme)
  },
}))

export function isDarkTheme(theme: Theme) {
  return theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
}

export function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle('dark', isDarkTheme(theme))
}
