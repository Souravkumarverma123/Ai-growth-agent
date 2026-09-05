"use client";

import * as React from "react";

type Theme = "light" | "dark" | "system";
type ResolvedTheme = "light" | "dark";

interface ThemeContextValue {
  theme: Theme;
  resolvedTheme: ResolvedTheme | undefined;
  systemTheme: ResolvedTheme | undefined;
  setTheme: (theme: Theme) => void;
  themes: string[];
  forcedTheme?: string;
}

const ThemeContext = React.createContext<ThemeContextValue | undefined>(undefined);

const STORAGE_KEY = "theme";
const DEFAULT_THEME: Theme = "light";
const THEMES = ["light", "dark"] as const;

function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme: Theme, enableColorScheme = true) {
  const root = document.documentElement;
  const resolved: ResolvedTheme = theme === "system" ? getSystemTheme() : (theme as ResolvedTheme);

  // attribute="class" handling
  root.classList.remove(...THEMES);
  if (resolved) root.classList.add(resolved);

  if (enableColorScheme) {
    root.style.colorScheme = resolved;
  }
}

export function ThemeProvider({
  children,
  defaultTheme = DEFAULT_THEME,
  storageKey = STORAGE_KEY,
  attribute = "class",
  enableSystem = true,
  enableColorScheme = true,
  disableTransitionOnChange = false,
  forcedTheme,
}: {
  children: React.ReactNode;
  defaultTheme?: Theme;
  storageKey?: string;
  attribute?: string;
  enableSystem?: boolean;
  enableColorScheme?: boolean;
  disableTransitionOnChange?: boolean;
  forcedTheme?: string;
}) {
  // Accepted for prop compatibility with next-themes' API; this
  // implementation only ever applies the "class" strategy (see applyTheme).
  void attribute;
  const [theme, setThemeState] = React.useState<Theme>(() => {
    if (typeof window === "undefined") return (forcedTheme as Theme) ?? defaultTheme;
    try {
      const stored = localStorage.getItem(storageKey) as Theme | null;
      return stored ?? defaultTheme;
    } catch {
      return defaultTheme;
    }
  });

  const [resolvedTheme, setResolvedTheme] = React.useState<ResolvedTheme | undefined>(() => {
    if (theme === "system") return getSystemTheme();
    return theme as ResolvedTheme;
  });
  const [systemTheme, setSystemTheme] = React.useState<ResolvedTheme | undefined>(() =>
    enableSystem ? getSystemTheme() : undefined,
  );

  const setTheme = React.useCallback(
    (newTheme: Theme | ((prev: Theme) => Theme)) => {
      const value = typeof newTheme === "function" ? (newTheme as (p: Theme) => Theme)(theme) : newTheme;
      // disable transitions if requested (mirrors next-themes W())
      let cleanup: (() => void) | null = null;
      if (disableTransitionOnChange) {
        const style = document.createElement("style");
        style.appendChild(
          document.createTextNode(
            "*,*::before,*::after{-webkit-transition:none!important;-moz-transition:none!important;-o-transition:none!important;-ms-transition:none!important;transition:none!important}",
          ),
        );
        document.head.appendChild(style);
        cleanup = () => {
          // force repaint
          window.getComputedStyle(document.body);
          setTimeout(() => document.head.removeChild(style), 1);
        };
      }

      try {
        localStorage.setItem(storageKey, value);
      } catch {
        // localStorage can throw (private browsing, storage disabled) — theme
        // still applies for this session, it just won't persist.
      }
      setThemeState(value);
      if (cleanup) cleanup();
    },
    [theme, storageKey, disableTransitionOnChange],
  );

  // listen to system changes
  React.useEffect(() => {
    if (!enableSystem) return;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => {
      const sys = getSystemTheme();
      setSystemTheme(sys);
      if (theme === "system" && !forcedTheme) {
        setResolvedTheme(sys);
        applyTheme("system", enableColorScheme);
      }
    };
    // For older Safari
    if (mql.addEventListener) mql.addEventListener("change", handleChange);
    else (mql as unknown as MediaQueryList & { addListener: (cb: () => void) => void }).addListener(handleChange);
    return () => {
      if (mql.removeEventListener) mql.removeEventListener("change", handleChange);
      else (mql as unknown as MediaQueryList & { removeListener: (cb: () => void) => void }).removeListener(handleChange);
    };
  }, [theme, forcedTheme, enableSystem, enableColorScheme]);

  // listen to storage
  React.useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key === storageKey) {
        const newVal = (e.newValue as Theme | null) ?? defaultTheme;
        setThemeState(newVal);
      }
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [storageKey, defaultTheme]);

  // apply theme whenever theme / forcedTheme changes
  React.useEffect(() => {
    const target = (forcedTheme as Theme) ?? theme;
    const resolved = target === "system" ? getSystemTheme() : (target as ResolvedTheme);
    setResolvedTheme(resolved);
    // support forcedTheme + enableSystem logic
    if (enableSystem && target === "system") {
      setSystemTheme(getSystemTheme());
    }
    applyTheme(target, enableColorScheme);
  }, [theme, forcedTheme, enableColorScheme, enableSystem]);

  // on mount, ensure correct theme applied (handles SSR mismatch where initial state was default)
  // next-themes does this via blocking script; we also have ThemeScript for FOUC, but keep as fallback
  React.useEffect(() => {
    const target = (forcedTheme as Theme) ?? theme;
    applyTheme(target, enableColorScheme);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = React.useMemo<ThemeContextValue>(
    () => ({
      theme: (forcedTheme as Theme) ?? theme,
      resolvedTheme: forcedTheme ? (forcedTheme as ResolvedTheme) : resolvedTheme,
      systemTheme,
      setTheme,
      themes: enableSystem ? [...THEMES, "system"] : [...THEMES],
      forcedTheme,
    }),
    [theme, resolvedTheme, systemTheme, setTheme, forcedTheme, enableSystem],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = React.useContext(ThemeContext);
  if (ctx) return ctx;
  // fallback for components rendered outside provider (e.g. during SSR or if provider missing)
  // mirrors next-themes fallback
  return {
    theme: DEFAULT_THEME,
    resolvedTheme: DEFAULT_THEME as ResolvedTheme,
    systemTheme: undefined,
    setTheme: () => {},
    themes: [...THEMES],
  };
}
