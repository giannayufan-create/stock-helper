import { style } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const wrap = style({
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
});

export const stats = style({
    display: 'grid',
    gridTemplateColumns: 'repeat(4, minmax(80px, 1fr))',
    gap: vars.space.xs,
    padding: vars.space.sm,
    borderBottom: `1px solid ${vars.color.border}`,
    background: vars.color.panelRaised,
});

export const statBox = style({
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '5px 8px',
    display: 'grid',
    gap: '2px',
});

export const statLabel = style({
    fontSize: '0.62rem',
    color: vars.color.mutedForeground,
});

export const statValue = style({
    fontFamily: vars.font.mono,
    fontSize: '0.8rem',
    fontWeight: 700,
});

export const body = style({
    overflow: 'auto',
    flex: 1,
});

export const row = style({
    padding: `${vars.space.sm} ${vars.space.md}`,
    borderBottom: `1px solid ${vars.color.border}`,
    display: 'grid',
    gap: '5px',
});

export const top = style({
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: vars.space.sm,
});

export const code = style({
    fontFamily: vars.font.mono,
    fontWeight: 700,
});

export const meta = style({
    display: 'flex',
    gap: vars.space.sm,
    color: vars.color.mutedForeground,
    fontSize: '0.66rem',
    flexWrap: 'wrap',
});

export const notes = style({
    display: 'flex',
    gap: '4px',
    flexWrap: 'wrap',
});

export const note = style({
    border: `1px solid ${vars.color.border}`,
    borderRadius: 999,
    padding: '1px 6px',
    fontSize: '0.62rem',
});

export const clearBtn = style({
    margin: vars.space.sm,
    border: `1px solid ${vars.color.border}`,
    background: vars.color.muted,
    color: vars.color.foreground,
    borderRadius: vars.radius.sm,
    padding: '4px 8px',
    fontSize: '0.68rem',
    cursor: 'pointer',
});

export const empty = style({
    padding: '1rem',
    color: vars.color.mutedForeground,
    fontSize: '0.72rem',
});

