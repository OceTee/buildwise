'use client';
import { Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import { THEME_COOKIE } from '@/lib/theme';


/** Light/dark switch. Without a choice the site follows the system setting. */
export function ThemeToggle() {
  const [dark, setDark] = useState<boolean | null>(null);
  useEffect(() => {
    const set = document.documentElement.dataset.theme;
    setDark(set ? set === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches);
  }, []);
  const flip = () => {
    const next = !dark;
    document.documentElement.dataset.theme = next ? 'dark' : 'light';
    document.cookie = `${THEME_COOKIE}=${next ? 'dark' : 'light'}; path=/; max-age=31536000; samesite=lax`;
    setDark(next);
  };
  return (
    <button type="button" className="btn btn-ghost theme-toggle" onClick={flip} aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'} title={dark ? 'Light theme' : 'Dark theme'}>
      {dark ? <Sun size={18} aria-hidden="true" /> : <Moon size={18} aria-hidden="true" />}
    </button>
  );
}
