// src/lib/theme-store.ts — theme settings (mode + price-color convention
// + font scale), persisted to localStorage and applied on <html>.

import { useSyncExternalStore } from 'react';
import { themeClasses } from '../theme.css';

export type ThemeMode = 'dark' | 'midnight' | 'light';
export type Convention = 'tw' | 'intl';
// every fontSize in the app is rem-based, so scaling the root font-size
// scales all text without touching the panel layout
export type FontScale = 90 | 100 | 110 | 125;

export interface ThemeSettings {
    mode: ThemeMode;
    convention: Convention;
    fontScale: FontScale;
}

const STORAGE_KEY = 'sj-pro-theme';
const MODES: ThemeMode[] = ['dark', 'midnight', 'light'];
const CONVENTIONS: Convention[] = ['tw', 'intl'];
export const FONT_SCALES: FontScale[] = [90, 100, 110, 125];

function load(): ThemeSettings {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const s = JSON.parse(raw) as Partial<ThemeSettings>;
            if (
                MODES.includes(s.mode as ThemeMode) &&
                CONVENTIONS.includes(s.convention as Convention)
            ) {
                return {
                    mode: s.mode as ThemeMode,
                    convention: s.convention as Convention,
                    // settings saved before the font-scale feature lack it
                    fontScale: FONT_SCALES.includes(s.fontScale as FontScale)
                        ? (s.fontScale as FontScale)
                        : 100,
                };
            }
        }
    } catch {
        // corrupted settings — use defaults
    }
    return { mode: 'dark', convention: 'tw', fontScale: 100 };
}

let settings: ThemeSettings = load();
const listeners = new Set<() => void>();

function applyClass() {
    const root = document.documentElement;
    for (const cls of Object.values(themeClasses)) {
        root.classList.remove(cls);
    }
    const key = `${settings.mode}-${settings.convention}`;
    const cls = themeClasses[key] ?? themeClasses['dark-tw'];
    if (cls) root.classList.add(cls);
    root.style.fontSize =
        settings.fontScale === 100 ? '' : `${settings.fontScale}%`;
}

/** canvas charts don't inherit CSS — scale their px font sizes manually */
export function chartFontSize(base = 10): number {
    return Math.round((base * settings.fontScale) / 100);
}

export function initTheme() {
    applyClass();
}

export function setThemeSettings(next: Partial<ThemeSettings>) {
    settings = { ...settings, ...next };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    applyClass();
    listeners.forEach((l) => l());
}

export function useThemeSettings(): ThemeSettings {
    return useSyncExternalStore(
        (l) => {
            listeners.add(l);
            return () => listeners.delete(l);
        },
        () => settings,
    );
}

// ---- chart palette (canvas needs concrete color strings) ----

export interface ChartColors {
    up: string;
    upVol: string;
    down: string;
    downVol: string;
    text: string;
    grid: string;
    crosshair: string;
    border: string;
    labelBg: string;
}

const CHROME: Record<
    ThemeMode,
    Pick<ChartColors, 'text' | 'grid' | 'crosshair' | 'border' | 'labelBg'>
> = {
    dark: {
        text: '#8b93a0',
        grid: 'rgba(38, 43, 52, 0.65)',
        crosshair: '#e8b84a',
        border: '#262b34',
        labelBg: '#181c22',
    },
    midnight: {
        text: '#7e8795',
        grid: 'rgba(30, 35, 44, 0.75)',
        crosshair: '#e8b84a',
        border: '#1e232c',
        labelBg: '#12151a',
    },
    light: {
        text: '#5c6472',
        grid: 'rgba(221, 215, 204, 0.9)',
        crosshair: '#c4921a',
        border: '#ddd7cc',
        labelBg: '#faf8f4',
    },
};

const RG: Record<ThemeMode, { red: string; green: string; redVol: string; greenVol: string }> = {
    dark: {
        red: '#ef4444',
        green: '#22a06b',
        redVol: 'rgba(239, 68, 68, 0.45)',
        greenVol: 'rgba(34, 160, 107, 0.4)',
    },
    midnight: {
        red: '#ef4444',
        green: '#22a06b',
        redVol: 'rgba(239, 68, 68, 0.45)',
        greenVol: 'rgba(34, 160, 107, 0.4)',
    },
    light: {
        red: '#d6213a',
        green: '#0a8a66',
        redVol: 'rgba(214, 33, 58, 0.4)',
        greenVol: 'rgba(10, 138, 102, 0.35)',
    },
};

export function getChartColors(s: ThemeSettings): ChartColors {
    const rg = RG[s.mode];
    const isTw = s.convention === 'tw';
    return {
        up: isTw ? rg.red : rg.green,
        upVol: isTw ? rg.redVol : rg.greenVol,
        down: isTw ? rg.green : rg.red,
        downVol: isTw ? rg.greenVol : rg.redVol,
        ...CHROME[s.mode],
    };
}
