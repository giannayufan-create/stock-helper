import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const shell = style({
    display: 'none',
    flexDirection: 'column',
    flex: 1,
    minHeight: 0,
    '@media': {
        'screen and (max-width: 900px)': {
            display: 'flex',
        },
    },
});

export const body = style({
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
    padding: '6px',
    paddingBottom: '4.2rem',
});

export const panel = style({
    display: 'flex',
    flexDirection: 'column',
    minHeight: 'calc(100vh - 7.5rem)',
    background: vars.color.panel,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.md,
    overflow: 'hidden',
});

export const title = style({
    padding: '8px 10px',
    fontSize: '0.72rem',
    fontWeight: 600,
    color: vars.color.mutedForeground,
    borderBottom: `1px solid ${vars.color.border}`,
});

export const content = style({
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
    display: 'flex',
    flexDirection: 'column',
});

export const tabBar = style({
    position: 'fixed',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 50,
    display: 'grid',
    gridTemplateColumns: 'repeat(5, 1fr)',
    gap: '2px',
    padding: '6px 6px calc(6px + env(safe-area-inset-bottom))',
    background: vars.color.panelRaised,
    borderTop: `1px solid ${vars.color.border}`,
});

const tabBase = style({
    border: 'none',
    background: 'transparent',
    color: vars.color.mutedForeground,
    padding: '6px 2px',
    borderRadius: vars.radius.sm,
    fontSize: '0.62rem',
    fontWeight: 600,
    cursor: 'pointer',
});

export const tab = styleVariants({
    off: [
        tabBase,
        {
            ':active': {
                background: vars.color.muted,
            },
        },
    ],
    on: [
        tabBase,
        {
            color: vars.color.accent,
            background: vars.color.accentDim,
        },
    ],
});

export const tabIcon = style({
    display: 'block',
    fontSize: '0.92rem',
    lineHeight: 1.2,
    marginBottom: '2px',
    fontFamily: vars.font.mono,
    fontWeight: 700,
});

export const desktopOnly = style({
    display: 'block',
    '@media': {
        'screen and (max-width: 900px)': {
            display: 'none',
        },
    },
});

export const empty = style({
    padding: '2rem 1rem',
    textAlign: 'center',
    color: vars.color.mutedForeground,
    fontSize: '0.85rem',
});
