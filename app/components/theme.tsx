import { useEffect, useState } from 'react';
import type { ReactElement, SVGProps } from 'react';

import { cn } from '../lib/utils';

/**
 * Colour theme: light (default), dark, or auto.
 *
 * The preference lives in localStorage under `agpro-theme`. It is a browser
 * preference, not an account setting — GitHub does the same — so it applies
 * before sign-in and survives a session without a database round-trip.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `resolveTheme()` here MUST stay in step with `THEME_SCRIPT` below: the script
 * runs before first paint and the hook runs after hydration, and a divergence
 * shows up as a flash of the wrong theme.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export type ThemePreference = 'light' | 'dark' | 'auto';

const STORAGE_KEY = 'agpro-theme';

/** Canvas colours, mirrored by `--color-surface`. Browsers tint their chrome. */
export const THEME_COLORS = { light: '#ffffff', dark: '#0d1117' } as const;

/** Local-time boundary for the auto fallback. 19:00–06:00 counts as night. */
function isNight(date: Date): boolean {
  const hour = date.getHours();
  return hour < 6 || hour >= 19;
}

/**
 * Resolves a preference to an applied theme.
 *
 * `auto` follows the operating system. The time-of-day rule only applies when
 * the OS explicitly reports that it has no preference (`no-preference`), which
 * is rare — so `auto` is predictable, and the clock is there when the platform
 * gives no signal at all.
 */
export function resolveTheme(preference: ThemePreference, now: Date = new Date()): 'light' | 'dark' {
  if (preference === 'dark') return 'dark';
  if (preference === 'light') return 'light';

  if (window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
  if (window.matchMedia('(prefers-color-scheme: no-preference)').matches && isNight(now)) {
    return 'dark';
  }
  return 'light';
}

export function applyTheme(preference: ThemePreference): void {
  const resolved = resolveTheme(preference);
  const root = document.documentElement;
  root.setAttribute('data-theme', resolved);
  root.style.colorScheme = resolved;

  // Keep the browser-chrome tint in step with the applied theme.
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', THEME_COLORS[resolved]);
}

export function readStoredPreference(): ThemePreference {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'auto') return raw;
  } catch {
    // Storage can be blocked (private mode, hardened settings). Light is the safe default.
  }
  return 'light';
}

function persist(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // Non-fatal: the theme still applies for this page view.
  }
}

/**
 * Reads and applies the stored preference after mount, then keeps it in sync.
 *
 * State starts null rather than read-at-render because the server cannot know
 * the preference; reading during render would hydrate a mismatch.
 */
export function useTheme() {
  const [preference, setPreferenceState] = useState<ThemePreference | null>(null);

  useEffect(() => {
    const stored = readStoredPreference();
    applyTheme(stored);
    setPreferenceState(stored);
  }, []);

  useEffect(() => {
    if (preference === null) return;

    applyTheme(preference);
    persist(preference);

    // In auto mode a live system change must repaint without a reload.
    if (preference !== 'auto') return;

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme('auto');
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [preference]);

  const setPreference = (next: ThemePreference): void => {
    setPreferenceState(next);
  };

  return { preference, setPreference };
}

/* ── Icons (inline SVG, 24×24, Lucide geometry — no icon dependency) ────────── */

type IconProps = SVGProps<SVGSVGElement>;

function SunIcon({ ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4"
      {...props}
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" />
      <path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m6.34 17.66-1.41 1.41" />
      <path d="m19.07 4.93-1.41 1.41" />
    </svg>
  );
}

function MoonIcon({ ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4"
      {...props}
    >
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </svg>
  );
}

function MonitorIcon({ ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4"
      {...props}
    >
      <rect width="20" height="14" x="2" y="3" rx="2" />
      <line x1="8" x2="16" y1="21" y2="21" />
      <line x1="12" x2="12" y1="17" y2="21" />
    </svg>
  );
}

const THEME_OPTIONS = [
  { value: 'light', label: 'Light', title: 'Light theme', Icon: SunIcon },
  { value: 'dark', label: 'Dark', title: 'Dark theme', Icon: MoonIcon },
  { value: 'auto', label: 'Auto', title: 'Match your system, or the time of day', Icon: MonitorIcon },
] as const satisfies readonly {
  value: ThemePreference;
  label: string;
  title: string;
  Icon: (props: IconProps) => ReactElement;
}[];

/**
 * Three-way theme control.
 *
 * Built on native radio inputs inside a `fieldset`, so arrow-key navigation,
 * grouping and the accessible name come from the platform rather than from
 * hand-rolled key handlers.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { preference, setPreference } = useTheme();

  return (
    <fieldset
      className={cn(
        'inline-flex items-center gap-0.5 rounded-md border border-border bg-muted p-0.5',
        className,
      )}
    >
      <legend className="sr-only">Colour theme</legend>
      {THEME_OPTIONS.map(({ value, label, title, Icon }) => (
        <label
          key={value}
          title={title}
          className={cn(
            'inline-flex cursor-pointer items-center justify-center rounded-sm px-2 py-1 text-ink-muted transition-colors duration-150',
            'hover:text-ink',
            'has-[:checked]:bg-surface has-[:checked]:text-accent-text has-[:checked]:shadow-sm',
            'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent',
          )}
        >
          <input
            type="radio"
            name="agpro-theme"
            value={value}
            checked={preference === value}
            onChange={() => setPreference(value)}
            className="sr-only"
          />
          <Icon aria-hidden="true" />
          <span className="sr-only">{label}</span>
        </label>
      ))}
    </fieldset>
  );
}

/**
 * Pre-paint theme resolver, injected inline in <head> by root.tsx.
 *
 * Kept as a string on purpose: it must execute synchronously, before the first
 * paint, to prevent a flash of the wrong theme. If a Content-Security-Policy is
 * added later (see docs/SECURITY-TODO.md), this needs a nonce or a host-scoped
 * hash — or move the identical logic into a same-origin /theme.js.
 *
 * Must mirror `resolveTheme()` above.
 */
export const THEME_SCRIPT = `(function(){try{
var k='agpro-theme',p=localStorage.getItem(k);
if(p!=='light'&&p!=='dark'&&p!=='auto')p='light';
var d;
if(p==='dark'){d=true}
else if(p==='light'){d=false}
else{
  d=window.matchMedia('(prefers-color-scheme: dark)').matches;
  if(!d){
    var noPref=window.matchMedia('(prefers-color-scheme: no-preference)').matches;
    if(noPref){var h=new Date().getHours();d=(h<6||h>=19)}
  }
}
var r=document.documentElement;
r.setAttribute('data-theme',d?'dark':'light');
r.style.colorScheme=d?'dark':'light';
var m=document.querySelector('meta[name="theme-color"]');
if(m)m.setAttribute('content',d?'#0d1117':'#ffffff');
}catch(e){document.documentElement.setAttribute('data-theme','light')}})();`;
