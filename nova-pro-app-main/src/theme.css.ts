// src/theme.css.ts — themeable design tokens.
// 3 modes (dark / midnight / light) × 2 price-color conventions
// (tw: red-up green-down, intl: green-up red-down) = 6 theme classes.

import {
    createTheme,
    globalKeyframes,
    globalStyle,
} from '@vanilla-extract/css';

interface Palette {
    background: string;
    panel: string;
    panelRaised: string;
    inset: string;
    foreground: string;
    muted: string;
    mutedForeground: string;
    border: string;
    borderBright: string;
    accent: string;
    accentDim: string;
    amber: string;
    red: string;
    redDim: string;
    redFlash: string;
    green: string;
    greenDim: string;
    greenFlash: string;
}

const dark: Palette = {
    background: '#0b0d10',
    panel: '#12151a',
    panelRaised: '#181c22',
    inset: '#080a0d',
    foreground: '#f0f2f5',
    muted: '#1c2129',
    mutedForeground: '#8b93a0',
    border: '#262b34',
    borderBright: '#3a4150',
    accent: '#e8b84a',
    accentDim: 'rgba(232, 184, 74, 0.14)',
    amber: '#e8b84a',
    red: '#ef4444',
    redDim: 'rgba(239, 68, 68, 0.14)',
    redFlash: 'rgba(239, 68, 68, 0.20)',
    green: '#22a06b',
    greenDim: 'rgba(34, 160, 107, 0.14)',
    greenFlash: 'rgba(34, 160, 107, 0.18)',
};

const midnight: Palette = {
    background: '#050607',
    panel: '#0c0e12',
    panelRaised: '#12151a',
    inset: '#030405',
    foreground: '#eceef2',
    muted: '#161a20',
    mutedForeground: '#7e8795',
    border: '#1e232c',
    borderBright: '#2e3542',
    accent: '#e8b84a',
    accentDim: 'rgba(232, 184, 74, 0.14)',
    amber: '#e8b84a',
    red: '#ef4444',
    redDim: 'rgba(239, 68, 68, 0.15)',
    redFlash: 'rgba(239, 68, 68, 0.22)',
    green: '#22a06b',
    greenDim: 'rgba(34, 160, 107, 0.15)',
    greenFlash: 'rgba(34, 160, 107, 0.20)',
};

const light: Palette = {
    background: '#f3f1eb',
    panel: '#ffffff',
    panelRaised: '#faf8f4',
    inset: '#f0ede6',
    foreground: '#1a1d24',
    muted: '#ebe7df',
    mutedForeground: '#5c6472',
    border: '#ddd7cc',
    borderBright: '#c4bdb0',
    accent: '#c4921a',
    accentDim: 'rgba(196, 146, 26, 0.12)',
    amber: '#c4921a',
    red: '#d6213a',
    redDim: 'rgba(214, 33, 58, 0.10)',
    redFlash: 'rgba(214, 33, 58, 0.16)',
    green: '#0a8a66',
    greenDim: 'rgba(10, 138, 102, 0.10)',
    greenFlash: 'rgba(10, 138, 102, 0.14)',
};

// tw: red = up (台股慣例); intl: green = up
function makeTokens(p: Palette, convention: 'tw' | 'intl') {
    const up = convention === 'tw' ? p.red : p.green;
    const upDim = convention === 'tw' ? p.redDim : p.greenDim;
    const upFlash = convention === 'tw' ? p.redFlash : p.greenFlash;
    const down = convention === 'tw' ? p.green : p.red;
    const downDim = convention === 'tw' ? p.greenDim : p.redDim;
    const downFlash = convention === 'tw' ? p.greenFlash : p.redFlash;
    return {
        color: {
            background: p.background,
            panel: p.panel,
            panelRaised: p.panelRaised,
            inset: p.inset,
            foreground: p.foreground,
            muted: p.muted,
            mutedForeground: p.mutedForeground,
            border: p.border,
            borderBright: p.borderBright,
            accent: p.accent,
            accentDim: p.accentDim,
            magenta: p.mutedForeground,
            amber: p.amber,
            up,
            upDim,
            upFlash,
            down,
            downDim,
            downFlash,
            flat: p.mutedForeground,
            success: p.green,
            danger: p.red,
        },
        space: {
            xs: '0.25rem',
            sm: '0.5rem',
            md: '1rem',
            lg: '1.5rem',
            xl: '2rem',
        },
        radius: {
            sm: '0.25rem',
            md: '0.375rem',
            lg: '0.5rem',
        },
        font: {
            display:
                "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif",
            mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
            body: "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif",
        },
    };
}

export const [darkTwClass, vars] = createTheme(makeTokens(dark, 'tw'));

export const themeClasses: Record<string, string> = {
    'dark-tw': darkTwClass,
    'dark-intl': createTheme(vars, makeTokens(dark, 'intl')),
    'midnight-tw': createTheme(vars, makeTokens(midnight, 'tw')),
    'midnight-intl': createTheme(vars, makeTokens(midnight, 'intl')),
    'light-tw': createTheme(vars, makeTokens(light, 'tw')),
    'light-intl': createTheme(vars, makeTokens(light, 'intl')),
};

// price-update flash animations follow the active theme
globalKeyframes('flash-up', {
    '0%': { background: vars.color.upFlash },
    '100%': { background: 'transparent' },
});

globalKeyframes('flash-down', {
    '0%': { background: vars.color.downFlash },
    '100%': { background: 'transparent' },
});

globalStyle('html, body', {
    background: vars.color.background,
    color: vars.color.foreground,
});

globalStyle('body', {
    fontFamily: vars.font.body,
});

globalStyle('::-webkit-scrollbar', { width: '8px', height: '8px' });
globalStyle('::-webkit-scrollbar-track', { background: 'transparent' });
globalStyle('::-webkit-scrollbar-thumb', {
    background: vars.color.border,
    borderRadius: '4px',
});
globalStyle('::-webkit-scrollbar-thumb:hover', {
    background: vars.color.borderBright,
});
