export type Theme = "dark" | "light";

export interface ThemeColors {
  panel: string;
  header: string;
  surface: string;
  input: string;
  border: string;
  text: string;
  primaryText: string;
  muted: string;
  accent: string;
  accentSoft: string;
  accentContrast: string;
  videoActionBackground: string;
  videoActionHoverBackground: string;
  videoActionText: string;
  success: string;
  successSoft: string;
  danger: string;
  shadow: string;
}

export const THEME_STORAGE_KEY = "youtubeKnowledgeTheme";

export const DARK_THEME: ThemeColors = {
  panel: "#0b1220",
  header: "#0f172a",
  surface: "#101827",
  input: "#111827",
  border: "#263449",
  text: "#dbe4f0",
  primaryText: "#f8fafc",
  muted: "#94a3b8",
  accent: "#67e8f9",
  accentSoft: "#12303a",
  accentContrast: "#06202a",
  videoActionBackground: "#164e63",
  videoActionHoverBackground: "#0e7490",
  videoActionText: "#ecfeff",
  success: "#34d399",
  successSoft: "rgba(52, 211, 153, 0.12)",
  danger: "#f87171",
  shadow: "rgba(0, 0, 0, 0.38)",
};

export const LIGHT_THEME: ThemeColors = {
  panel: "#ffffff",
  header: "#f8fafc",
  surface: "#f1f5f9",
  input: "#ffffff",
  border: "#d7dee8",
  text: "#334155",
  primaryText: "#172033",
  muted: "#64748b",
  accent: "#0891b2",
  accentSoft: "#ecfeff",
  accentContrast: "#155e75",
  videoActionBackground: "#cffafe",
  videoActionHoverBackground: "#a5f3fc",
  videoActionText: "#155e75",
  success: "#10b981",
  successSoft: "rgba(16, 185, 129, 0.12)",
  danger: "#dc2626",
  shadow: "rgba(15, 23, 42, 0.18)",
};

export function getThemeColors(theme: Theme): ThemeColors {
  return theme === "light" ? LIGHT_THEME : DARK_THEME;
}

export function isDarkTheme(theme: Theme): boolean {
  return theme === "dark";
}

export function resolveInitialTheme(): Theme {
  return "dark";
}

export function readThemePreference(): Promise<Theme> {
  return new Promise((resolve) => {
    if (typeof chrome === "undefined" || !chrome.storage?.local) {
      resolve(resolveInitialTheme());
      return;
    }

    chrome.storage.local.get([THEME_STORAGE_KEY], (result) => {
      const stored = result[THEME_STORAGE_KEY];
      if (stored === "light" || stored === "dark") {
        resolve(stored);
        return;
      }

      resolve(resolveInitialTheme());
    });
  });
}

export function saveThemePreference(theme: Theme): void {
  if (typeof chrome === "undefined" || !chrome.storage?.local) {
    return;
  }

  chrome.storage.local.set({
    [THEME_STORAGE_KEY]: theme,
  });
}

export function subscribeToThemeChanges(
  onChange: (theme: Theme) => void,
): () => void {
  if (typeof chrome === "undefined" || !chrome.storage?.onChanged) {
    return () => {};
  }

  const handleStorageChange = (
    changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
    areaName: string,
  ) => {
    if (areaName !== "local" || !Object.prototype.hasOwnProperty.call(changes, THEME_STORAGE_KEY)) {
      return;
    }

    const value = changes[THEME_STORAGE_KEY]?.newValue;
    if (value === "light" || value === "dark") {
      onChange(value);
    }
  };

  chrome.storage.onChanged.addListener(handleStorageChange);
  return () => chrome.storage.onChanged.removeListener(handleStorageChange);
}
