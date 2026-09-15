// src/components/intraday-rank-panel.css.ts

import { style } from '@vanilla-extract/css';

export const wrap = style({
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
});

export const tabs = style({
    display: 'flex',
    gap: 6,
    padding: '8px 10px 0',
});

export const tabOn = style({
    border: '1px solid rgba(52, 211, 153, 0.5)',
    background: 'rgba(52, 211, 153, 0.15)',
    color: '#e5e7eb',
    borderRadius: 6,
    padding: '4px 10px',
    fontSize: 12,
    cursor: 'pointer',
});

export const tabOff = style({
    border: '1px solid rgba(255,255,255,0.1)',
    background: 'transparent',
    color: '#9ca3af',
    borderRadius: 6,
    padding: '4px 10px',
    fontSize: 12,
    cursor: 'pointer',
});

export const status = style({
    margin: '6px 10px',
    fontSize: 11,
    color: '#9ca3af',
});

export const empty = style({
    padding: '1.5rem',
    textAlign: 'center',
    color: '#9ca3af',
    fontSize: 13,
});

export const row = style({
    display: 'block',
    width: '100%',
    textAlign: 'left',
    border: 'none',
    borderBottom: '1px solid rgba(255,255,255,0.06)',
    background: 'transparent',
    color: 'inherit',
    padding: '8px 10px',
    cursor: 'pointer',
    ':hover': {
        background: 'rgba(255,255,255,0.04)',
    },
});

export const top = style({
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 13,
});

export const rank = style({
    fontWeight: 700,
    color: '#fbbf24',
    minWidth: 28,
});

export const code = style({
    flex: 1,
    fontWeight: 600,
});

export const state = style({
    fontSize: 11,
    fontWeight: 700,
});

export const meta = style({
    display: 'flex',
    flexWrap: 'wrap',
    gap: '4px 10px',
    marginTop: 4,
    fontSize: 11,
    color: '#9ca3af',
});

export const events = style({
    marginTop: 4,
    fontSize: 11,
    color: '#fbbf24',
});

export const hint = style({
    marginTop: 2,
    fontSize: 10,
    color: '#a78bfa',
});

export const eventBar = style({
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    padding: '6px 10px',
    borderTop: '1px solid rgba(255,255,255,0.08)',
    fontSize: 10,
    color: '#9ca3af',
});
