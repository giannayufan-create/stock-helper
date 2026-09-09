import { style } from '@vanilla-extract/css';
import { vars } from '../theme.css';

/** Always visible when mounted — App only mounts this on mobile */
export const shell = style({
    display: 'flex',
    position: 'fixed',
    inset: 0,
    zIndex: 50,
    flexDirection: 'column',
    background: vars.color.background,
    color: vars.color.foreground,
    overflow: 'hidden',
});

export const topBar = style({
    flex: '0 0 auto',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 12px',
    paddingTop: 'max(8px, env(safe-area-inset-top))',
    borderBottom: `1px solid ${vars.color.border}`,
    background: vars.color.panel,
});

export const brand = style({
    fontFamily: vars.font.display,
    fontSize: 15,
    fontWeight: 700,
    letterSpacing: '0.02em',
    marginRight: 'auto',
});

export const chipBtn = style({
    border: `1px solid ${vars.color.border}`,
    background: vars.color.inset,
    color: vars.color.foreground,
    borderRadius: vars.radius.sm,
    padding: '7px 12px',
    fontSize: 12,
    fontWeight: 600,
    minHeight: 36,
});

/** Sticky live quote under top bar */
export const quoteStrip = style({
    flex: '0 0 auto',
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '8px 12px 4px',
    background: vars.color.panelRaised,
});

export const quoteCode = style({
    fontFamily: vars.font.mono,
    fontWeight: 700,
    fontSize: 14,
});

export const quoteName = style({
    fontSize: 12,
    color: vars.color.mutedForeground,
    maxWidth: '5.5rem',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
});

export const quotePrice = style({
    fontFamily: vars.font.mono,
    fontWeight: 700,
    fontSize: 20,
    fontVariantNumeric: 'tabular-nums',
    marginLeft: 'auto',
});

export const quoteChg = style({
    fontFamily: vars.font.mono,
    fontSize: 12,
    fontWeight: 600,
    fontVariantNumeric: 'tabular-nums',
    textAlign: 'right',
    lineHeight: 1.25,
});

export const quoteUp = style({ color: vars.color.up });
export const quoteDown = style({ color: vars.color.down });
export const quoteFlat = style({ color: vars.color.flat });

/** The ONLY scroll container on phone */
export const page = style({
    flex: '1 1 auto',
    minHeight: 0,
    overflowY: 'auto',
    overflowX: 'hidden',
    WebkitOverflowScrolling: 'touch',
    overscrollBehaviorY: 'contain',
    padding: '10px 12px',
    paddingBottom: 'calc(72px + env(safe-area-inset-bottom))',
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
});

export const section = style({
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    scrollMarginTop: 10,
});

export const sectionTitle = style({
    margin: 0,
    fontSize: 12,
    fontWeight: 700,
    color: vars.color.mutedForeground,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
});

export const chartBox = style({
    display: 'flex',
    flexDirection: 'column',
    border: `1px solid ${vars.color.border}`,
    borderRadius: 12,
    background: vars.color.panel,
    overflow: 'hidden',
});

export const chartInner = style({
    height: 'min(58vh, 420px)',
    minHeight: 280,
    maxHeight: 480,
    overflow: 'hidden',
});

export const ohlcRow = style({
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: 4,
    padding: '0 12px 8px',
    borderBottom: `1px solid ${vars.color.border}`,
    background: vars.color.panelRaised,
    fontFamily: vars.font.mono,
    fontSize: 11,
    fontVariantNumeric: 'tabular-nums',
});

export const ohlcCell = style({
    display: 'flex',
    flexDirection: 'column',
    gap: 1,
});

export const ohlcLabel = style({
    color: vars.color.mutedForeground,
    fontSize: 10,
});

export const hint = style({
    margin: 0,
    padding: '16px 14px',
    fontSize: 13,
    lineHeight: 1.5,
    color: vars.color.mutedForeground,
    border: `1px dashed ${vars.color.border}`,
    borderRadius: 10,
    background: vars.color.panelRaised,
});

export const quickRow = style({
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: 8,
});

export const quickBtn = style({
    border: `1px solid ${vars.color.border}`,
    background: vars.color.panel,
    color: vars.color.foreground,
    borderRadius: 10,
    padding: '12px 8px',
    fontSize: 13,
    fontWeight: 700,
    minHeight: 44,
    cursor: 'pointer',
    selectors: {
        '&:disabled': {
            opacity: 0.4,
            cursor: 'not-allowed',
        },
    },
});

export const quickBtnOn = style({
    borderColor: vars.color.accent,
    background: vars.color.accentDim,
});

export const foldBody = style({
    border: `1px solid ${vars.color.border}`,
    borderRadius: 10,
    background: vars.color.panel,
    padding: 8,
    overflow: 'hidden',
    maxHeight: '70vh',
    overflowY: 'auto',
    WebkitOverflowScrolling: 'touch',
});

export const pageEnd = style({
    height: 8,
    flex: '0 0 auto',
});

/** Bottom dock — jump anchors, not separate pages */
export const dock = style({
    flex: '0 0 auto',
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: 2,
    padding: '6px 6px',
    paddingBottom: 'max(6px, env(safe-area-inset-bottom))',
    borderTop: `1px solid ${vars.color.border}`,
    background: vars.color.panel,
});

export const dockBtn = style({
    border: 'none',
    background: 'transparent',
    color: vars.color.mutedForeground,
    borderRadius: 8,
    padding: '8px 4px',
    fontSize: 11,
    fontWeight: 600,
    minHeight: 44,
    cursor: 'pointer',
});

export const dockBtnOn = style({
    color: vars.color.accent,
    background: vars.color.accentDim,
});
