import { style } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const wrap = style({
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
});

export const controls = style({
    display: 'grid',
    gap: vars.space.sm,
    padding: vars.space.sm,
    borderBottom: `1px solid ${vars.color.border}`,
    background: vars.color.panelRaised,
});

export const row = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.sm,
    flexWrap: 'wrap',
});

export const label = style({
    fontSize: '0.68rem',
    color: vars.color.mutedForeground,
    minWidth: '5.2rem',
    cursor: 'help',
    borderBottom: `1px dotted ${vars.color.mutedForeground}`,
});

export const select = style({
    background: vars.color.panel,
    color: vars.color.foreground,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '3px 8px',
    fontSize: '0.72rem',
});

export const miniInput = style({
    width: '4.2rem',
    background: vars.color.panel,
    color: vars.color.foreground,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '3px 6px',
    fontSize: '0.72rem',
});

export const section = style({
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(120px, 1fr))',
    gap: '4px 10px',
});

export const checkbox = style({
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '0.7rem',
    color: vars.color.foreground,
    cursor: 'help',
});

export const runBtn = style({
    background: vars.color.accent,
    color: '#111',
    border: 'none',
    borderRadius: vars.radius.sm,
    padding: '5px 10px',
    fontSize: '0.72rem',
    fontWeight: 700,
    cursor: 'pointer',
});

export const body = style({
    overflow: 'auto',
    flex: 1,
});

export const card = style({
    borderBottom: `1px solid ${vars.color.border}`,
    padding: `${vars.space.sm} ${vars.space.md}`,
    display: 'grid',
    gap: '6px',
});

export const topLine = style({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: vars.space.sm,
});

export const title = style({
    fontFamily: vars.font.mono,
    fontWeight: 700,
    fontSize: '0.82rem',
});

export const meta = style({
    display: 'flex',
    gap: vars.space.sm,
    fontSize: '0.68rem',
    color: vars.color.mutedForeground,
    flexWrap: 'wrap',
});

export const badges = style({
    display: 'flex',
    flexWrap: 'wrap',
    gap: '4px',
});

export const badge = style({
    borderRadius: 999,
    border: `1px solid ${vars.color.border}`,
    padding: '1px 7px',
    fontSize: '0.64rem',
});

export const actions = style({
    display: 'flex',
    gap: vars.space.xs,
});

export const actionBtn = style({
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    background: vars.color.muted,
    color: vars.color.foreground,
    padding: '3px 8px',
    fontSize: '0.68rem',
    cursor: 'pointer',
});

export const pickBtn = style({
    border: 'none',
    borderRadius: vars.radius.sm,
    background: vars.color.up,
    color: '#fff',
    padding: '3px 8px',
    fontSize: '0.68rem',
    cursor: 'pointer',
});

export const tipWrap = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: vars.space.xs,
    position: 'relative',
});

export const tipBubble = style({
    position: 'fixed',
    zIndex: 2147483000,
    width: 'min(280px, calc(100vw - 16px))',
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.borderBright}`,
    borderRadius: vars.radius.md,
    boxShadow: '0 12px 32px rgba(0, 0, 0, 0.45)',
    padding: '8px 10px',
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    pointerEvents: 'none',
});

export const tipLine = style({
    fontSize: '0.68rem',
    lineHeight: 1.4,
    color: vars.color.foreground,
});

export const empty = style({
    padding: '1rem',
    fontSize: '0.72rem',
    color: vars.color.mutedForeground,
});

