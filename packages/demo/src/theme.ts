export type Theme = "dark" | "light";

const KEY = "starling-theme";

/** The theme to start in: a saved choice if there is one, otherwise dark, which
 * is the design's default. Read once at boot, before the first paint. */
export function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "dark" || saved === "light") return saved;
  } catch {
    // localStorage can throw in locked-down contexts; fall back to the default.
  }
  return "dark";
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Non-fatal: the theme still applies for this session.
  }
}
