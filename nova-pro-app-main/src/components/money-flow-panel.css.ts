// src/components/money-flow-panel.css.ts

import { style } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const wrap = style({
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
});

export const controls = style({
    display: 'grid',
    gap: vars.space.sm,
    padding: vars.space.sm,
    borderBottom: `1px solid ${vars.color.border}`,
    background: vars.color.panelRaised,
});

export const blurb = style({
    margin: 0,
    fontSize: '0.72rem',
    lineHeight: 1.4,
    color: vars.color.mutedForeground,
});

export const tabs = style({
    display: 'flex',
    flexWrap: 'wrap',
    gap: 4,
});

export const tab = style({
    fontSize: '0.7rem',
    padding: '4px 8px',
    borderRadius: vars.radius.sm,
    border: `1px solid ${vars.color.border}`,
    background: vars.color.inset,
    color: vars.color.foreground,
    cursor: 'pointer',
});

export const tabActive = style([
    tab,
    {
        borderColor: vars.color.accent,
        background: vars.color.panelRaised,
    },
]);

export const meta = style({
    display: 'flex',
    flexWrap: 'wrap',
    gap: '8px 12px',
    fontSize: '0.68rem',
    color: vars.color.mutedForeground,
});

export const body = style({
    flex: 1,
    overflow: 'auto',
    padding: vars.space.sm,
    display: 'grid',
    gap: 6,
    alignContent: 'start',
});

export const card = style({
    padding: '8px 10px',
    borderRadius: vars.radius.sm,
    border: `1px solid ${vars.color.border}`,
    background: vars.color.inset,
    display: 'grid',
    gap: 4,
});

export const top = style({
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 8,
});

export const titleBtn = style({
    background: 'none',
    border: 'none',
    padding: 0,
    color: vars.color.foreground,
    fontSize: '0.82rem',
    fontWeight: 600,
    cursor: 'pointer',
    textAlign: 'left',
});

export const badges = style({
    display: 'flex',
    flexWrap: 'wrap',
    gap: 4,
});

export const badge = style({
    fontSize: '0.65rem',
    padding: '1px 6px',
    borderRadius: vars.radius.sm,
    border: `1px solid ${vars.color.border}`,
    color: vars.color.mutedForeground,
});

export const badgeGood = style([
    badge,
    { color: vars.color.up, borderColor: vars.color.up },
]);

export const badgeWarn = style([
    badge,
    { color: vars.color.down, borderColor: vars.color.down },
]);

export const line = style({
    fontSize: '0.72rem',
    color: vars.color.mutedForeground,
    display: 'flex',
    flexWrap: 'wrap',
    gap: '4px 10px',
});

export const empty = style({
    padding: vars.space.md,
    fontSize: '0.78rem',
    color: vars.color.mutedForeground,
});

export const runBtn = style({
    justifySelf: 'start',
    fontSize: '0.72rem',
    padding: '4px 10px',
    borderRadius: vars.radius.sm,
    border: `1px solid ${vars.color.border}`,
    background: vars.color.accent,
    color: '#111',
    cursor: 'pointer',
});
