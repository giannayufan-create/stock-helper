import { style } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const wrap = style({
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
});

export const stats = style({
    display: 'grid',
    gridTemplateColumns: 'repeat(3, minmax(80px, 1fr))',
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

export const statSub = style({
    fontSize: '0.62rem',
    fontWeight: 500,
    color: vars.color.mutedForeground,
    marginLeft: 4,
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

export const actions = style({
    display: 'flex',
    gap: vars.space.sm,
    padding: `0 ${vars.space.sm}`,
    marginTop: vars.space.sm,
});

export const learnPanel = style({
    display: 'grid',
    gap: vars.space.sm,
    padding: vars.space.sm,
    borderTop: `1px solid ${vars.color.border}`,
});

export const learnHeader = style({
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: vars.space.sm,
});

export const learnTitle = style({
    fontSize: '0.74rem',
    fontWeight: 700,
    color: vars.color.foreground,
});

export const learnHint = style({
    fontSize: '0.64rem',
    color: vars.color.mutedForeground,
    marginTop: 2,
});

export const learnGrid = style({
    display: 'grid',
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: vars.space.sm,
    '@media': {
        'screen and (max-width: 1100px)': {
            gridTemplateColumns: '1fr',
        },
    },
});

export const learnMuteCard = style({
    borderColor: 'rgba(239, 68, 68, 0.35)',
    background: 'rgba(239, 68, 68, 0.06)',
});

export const learnCard = style({
    display: 'grid',
    gap: '6px',
    padding: '8px',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    background: vars.color.panelRaised,
});

export const learnCardTitle = style({
    fontSize: '0.68rem',
    fontWeight: 700,
    color: vars.color.foreground,
});

export const learnRow = style({
    display: 'grid',
    gap: '3px',
    padding: '6px 0',
    borderTop: `1px solid ${vars.color.border}`,
});

export const learnTop = style({
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: vars.space.sm,
});

export const learnName = style({
    fontSize: '0.68rem',
    fontWeight: 600,
    color: vars.color.foreground,
});

export const learnDelta = style({
    fontSize: '0.68rem',
    fontWeight: 700,
});

export const learnMeta = style({
    display: 'flex',
    flexWrap: 'wrap',
    gap: '8px',
    fontSize: '0.62rem',
    color: vars.color.mutedForeground,
});

export const learnGood = style({
    color: '#4ade80',
});

export const learnBad = style({
    color: '#f87171',
});

export const learnNeutral = style({
    color: vars.color.mutedForeground,
});

export const learnEmpty = style({
    fontSize: '0.64rem',
    color: vars.color.mutedForeground,
});

export const verifyBtn = style({
    border: `1px solid ${vars.color.accent}`,
    background: 'rgba(224, 164, 60, 0.16)',
    color: vars.color.foreground,
    borderRadius: vars.radius.sm,
    padding: '4px 10px',
    fontSize: '0.68rem',
    fontWeight: 700,
    cursor: 'pointer',
    selectors: {
        '&:disabled': {
            opacity: 0.55,
            cursor: 'wait',
        },
    },
});

export const clearBtn = style({
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

export const badge = style({
    fontSize: '0.68rem',
    fontWeight: 700,
    borderRadius: 999,
    padding: '2px 8px',
    whiteSpace: 'nowrap',
});

export const badgeOpen = style({
    background: 'rgba(148, 163, 184, 0.2)',
    color: vars.color.mutedForeground,
});

export const badgeWin = style({
    background: 'rgba(34, 197, 94, 0.18)',
    color: '#4ade80',
});

export const badgeLoss = style({
    background: 'rgba(239, 68, 68, 0.18)',
    color: '#f87171',
});

export const badgeFlat = style({
    background: 'rgba(148, 163, 184, 0.22)',
    color: vars.color.foreground,
});

