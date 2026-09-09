import { style } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const wrap = style({
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
    flex: 1,
    overflow: 'hidden',
});

/** Mobile shell scrolls the pane; this panel just flows as a document */
export const wrapFlow = style({
    display: 'block',
    height: 'auto',
    minHeight: 'min-content',
    overflow: 'visible',
});

export const controls = style({
    display: 'grid',
    gap: vars.space.sm,
    padding: vars.space.sm,
    borderBottom: `1px solid ${vars.color.border}`,
    background: vars.color.panelRaised,
    flexShrink: 0,
});

export const controlsCompact = style({
    display: 'grid',
    gap: '6px',
    padding: '8px',
    border: `1px solid ${vars.color.border}`,
    borderBottom: `1px solid ${vars.color.border}`,
    background: vars.color.panelRaised,
    flexShrink: 0,
    borderRadius: '10px 10px 0 0',
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
    width: '100%',
    background: vars.color.inset,
    color: vars.color.foreground,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '3px 8px',
    fontSize: '0.72rem',
});

export const miniInput = style({
    width: '100%',
    maxWidth: '5rem',
    background: vars.color.inset,
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
    marginLeft: 'auto',
});

/** Mobile: full-width tap target so 智能篩選 is always easy to hit */
export const runBtnMobile = style({
    background: vars.color.accent,
    color: '#111',
    border: 'none',
    borderRadius: vars.radius.md,
    padding: '12px 14px',
    fontSize: '0.92rem',
    fontWeight: 800,
    cursor: 'pointer',
    width: '100%',
    minHeight: 48,
    marginTop: 4,
});

export const modeTabs = style({
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '6px',
});

export const modeTab = style({
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    background: vars.color.inset,
    color: vars.color.mutedForeground,
    padding: '8px 10px',
    fontSize: '0.78rem',
    fontWeight: 600,
    cursor: 'pointer',
});

export const modeTabActive = style({
    border: `1px solid ${vars.color.accent}`,
    borderRadius: vars.radius.sm,
    background: 'rgba(224, 164, 60, 0.18)',
    color: vars.color.foreground,
    padding: '8px 10px',
    fontSize: '0.78rem',
    fontWeight: 700,
    cursor: 'pointer',
});

export const modeBlurb = style({
    margin: 0,
    fontSize: '0.68rem',
    lineHeight: 1.4,
    color: vars.color.mutedForeground,
});

export const presetBar = style({
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '8px',
    fontSize: '0.68rem',
    color: vars.color.mutedForeground,
});

export const inlineCheck = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    cursor: 'pointer',
    color: vars.color.foreground,
});

export const priceRow = style({
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
});

export const priceBox = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '1px',
});

export const priceLabel = style({
    fontSize: '0.6rem',
    color: vars.color.mutedForeground,
});

export const priceValue = style({
    fontFamily: vars.font.mono,
    fontSize: '0.92rem',
    fontWeight: 700,
    fontVariantNumeric: 'tabular-nums',
});

export const priceArrow = style({
    color: vars.color.mutedForeground,
    fontSize: '0.9rem',
});

export const body = style({
    overflowY: 'scroll',
    overflowX: 'hidden',
    flex: '1 1 0',
    minHeight: 0,
    WebkitOverflowScrolling: 'touch',
    touchAction: 'pan-y',
    overscrollBehavior: 'contain',
});

/** One-page mobile: list is document content (no nested scroll) */
export const bodyFlow = style({
    display: 'block',
    overflow: 'visible',
    height: 'auto',
    border: `1px solid ${vars.color.border}`,
    borderTop: 'none',
    borderRadius: '0 0 10px 10px',
    background: vars.color.panel,
});

export const card = style({
    borderBottom: `1px solid ${vars.color.border}`,
    padding: `${vars.space.sm} ${vars.space.md}`,
    display: 'grid',
    gap: '6px',
    '@media': {
        'screen and (max-width: 900px)': {
            padding: '12px 10px',
            gap: '8px',
        },
    },
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

export const titleBtn = style({
    fontFamily: vars.font.mono,
    fontWeight: 700,
    fontSize: '0.82rem',
    color: vars.color.foreground,
    background: 'transparent',
    border: 'none',
    padding: 0,
    textAlign: 'left',
    cursor: 'pointer',
    ':hover': {
        color: vars.color.accent,
        textDecoration: 'underline',
    },
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

export const fieldGrid = style({
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(11.5rem, 1fr))',
    gap: vars.space.sm,
});

export const fieldCard = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    padding: '6px 8px',
    background: vars.color.panel,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    minWidth: 0,
});

export const fieldHead = style({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '4px',
});

export const fieldTitle = style({
    fontSize: '0.7rem',
    fontWeight: 700,
    color: vars.color.foreground,
});

export const fieldHelpMark = style({
    fontSize: '0.62rem',
    fontWeight: 700,
    color: vars.color.mutedForeground,
    border: `1px solid ${vars.color.border}`,
    borderRadius: '999px',
    width: '1rem',
    height: '1rem',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
});

export const fieldControl = style({
    display: 'flex',
});

export const fieldShort = style({
    fontSize: '0.6rem',
    lineHeight: 1.35,
    color: vars.color.mutedForeground,
});

export const sectionTitle = style({
    fontSize: '0.68rem',
    fontWeight: 700,
    color: vars.color.foreground,
    width: '100%',
});

export const miniInputWide = style({
    width: '100%',
    maxWidth: '7rem',
    background: vars.color.inset,
    color: vars.color.foreground,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '3px 6px',
    fontSize: '0.72rem',
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

