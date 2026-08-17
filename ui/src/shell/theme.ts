import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark' | null;

/**
 * Theme choice, remembered across runs.
 *
 * Null means "follow the system", which is the default and is not the same as
 * light: a user who has never touched the toggle should track their OS when it
 * switches at dusk. index.html applies the stored value before first paint so
 * the page never flashes the wrong one.
 */
export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem('curlapi-theme') as Theme) ?? null,
  );

  useEffect(() => {
    if (theme) {
      document.documentElement.setAttribute('data-theme', theme);
      localStorage.setItem('curlapi-theme', theme);
    } else {
      document.documentElement.removeAttribute('data-theme');
      localStorage.removeItem('curlapi-theme');
    }
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((current) => {
      const isDark =
        current === 'dark' ||
        (current === null && window.matchMedia('(prefers-color-scheme: dark)').matches);
      return isDark ? 'light' : 'dark';
    });
  }, []);

  return { theme, toggle };
}
