// src/components/candle-chart.css.ts

import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const wrap = style({
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minHeight: 0,
    '@media': {
        'screen and (max-width: 900px)': {
            // Don't let chart + quote eat the whole phone
            maxHeight: '100%',
        },
    },
});

export const toolbar = style({
    display: 'flex',
    gap: '2px',
    padding: `4px ${vars.space.sm}`,
    borderBottom: `1px solid ${vars.color.border}`,
    flexShrink: 0,
    flexWrap: 'wrap',
    '@media': {
        'screen and (max-width: 900px)': {
            gap: '3px',
            padding: '4px 6px',
            maxHeight: '4.8rem',
            overflowY: 'auto',
        },
    },
});

const tfBase = style({
    fontFamily: vars.font.mono,
    fontSize: '0.7rem',
    fontWeight: 500,
    padding: '2px 10px',
    cursor: 'pointer',
    background: 'transparent',
    border: '1px solid transparent',
    borderRadius: vars.radius.sm,
    color: vars.color.mutedForeground,
    transition: 'all 0.12s',
    ':hover': { color: vars.color.foreground },
});

export const tfBtn = styleVariants({
    normal: [tfBase],
    active: [
        tfBase,
        {
            color: vars.color.foreground,
            background: vars.color.muted,
        },
    ],
});

export const toolbarDivider = style({
    width: '1px',
    alignSelf: 'stretch',
    margin: '2px 4px',
    background: vars.color.border,
});

const modeBase = style({
    fontFamily: vars.font.body,
    fontSize: '0.66rem',
    fontWeight: 500,
    padding: '2px 8px',
    cursor: 'pointer',
    background: 'transparent',
    border: '1px solid transparent',
    borderRadius: vars.radius.sm,
    color: vars.color.mutedForeground,
    transition: 'all 0.12s',
    ':hover': { color: vars.color.foreground },
});

export const modeBtn = styleVariants({
    normal: [modeBase],
    active: [
        modeBase,
        { color: vars.color.foreground, background: vars.color.muted },
    ],
    armed: [
        modeBase,
        {
            color: '#1a1304',
            background: vars.color.amber,
            borderColor: vars.color.amber,
            fontWeight: 600,
        },
    ],
});

export const qtyInput = style({
    width: '3rem',
    marginLeft: 'auto',
    fontFamily: vars.font.mono,
    fontSize: '0.7rem',
    fontWeight: 600,
    textAlign: 'right',
    color: vars.color.foreground,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '1px 6px',
    outline: 'none',
    ':focus': { borderColor: vars.color.accent },
    '@media': {
        'screen and (max-width: 900px)': {
            marginLeft: 0,
            width: '3.6rem',
        },
    },
});

export const indBackdrop = style({
    position: 'fixed',
    inset: 0,
    zIndex: 90,
});

export const maQuickRow = style({
    display: 'flex',
    alignItems: 'center',
    gap: '2px',
    flexWrap: 'wrap',
});

export const indMenu = style({
    position: 'fixed',
    zIndex: 91,
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    width: '12.5rem',
    maxWidth: 'calc(100vw - 16px)',
    maxHeight: 'min(70vh, 24rem)',
    overflowY: 'auto',
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.borderBright}`,
    borderRadius: vars.radius.md,
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.4)',
    padding: '6px',
});

export const indSection = style({
    fontSize: '0.6rem',
    fontWeight: 600,
    letterSpacing: '0.04em',
    color: vars.color.mutedForeground,
    padding: '4px 6px 2px',
});

export const indMaRow = style({
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
});

export const indPeriod = style({
    width: '3.2rem',
    fontFamily: vars.font.mono,
    fontSize: '0.66rem',
    textAlign: 'right',
    color: vars.color.foreground,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '2px 4px',
    outline: 'none',
    ':focus': { borderColor: vars.color.accent },
});

export const indItem = style({
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    flex: 1,
    fontFamily: vars.font.mono,
    fontSize: '0.66rem',
    textAlign: 'left',
    padding: '3px 8px',
    cursor: 'pointer',
    background: 'transparent',
    border: 'none',
    borderRadius: vars.radius.sm,
    color: vars.color.foreground,
    ':hover': { background: vars.color.muted },
});

export const indSwatch = style({
    width: '10px',
    height: '3px',
    borderRadius: '1px',
    flexShrink: 0,
});

export const modeHint = style({
    position: 'absolute',
    top: '8px',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 5,
    fontFamily: vars.font.body,
    fontSize: '0.66rem',
    fontWeight: 600,
    color: '#1a1304',
    background: vars.color.amber,
    borderRadius: vars.radius.sm,
    padding: '2px 10px',
    pointerEvents: 'none',
    '@media': {
        'screen and (max-width: 900px)': {
            top: '56px',
            left: '8px',
            right: '8px',
            transform: 'none',
            textAlign: 'center',
        },
    },
});

export const rangeBadge = style({
    position: 'absolute',
    // Keep off the right price axis / crosshair labels
    left: '8px',
    bottom: '28px',
    top: 'auto',
    right: 'auto',
    zIndex: 4,
    display: 'flex',
    flexDirection: 'row',
    gap: '8px',
    fontFamily: vars.font.mono,
    fontSize: '0.62rem',
    fontVariantNumeric: 'tabular-nums',
    background: 'rgba(20, 22, 28, 0.72)',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '2px 8px',
    color: vars.color.mutedForeground,
    pointerEvents: 'none',
    '@media': {
        'screen and (max-width: 900px)': {
            left: '8px',
            bottom: '24px',
            fontSize: '0.68rem',
        },
    },
});

export const aiBackdrop = style({
    position: 'fixed',
    inset: 0,
    zIndex: 10050,
    border: 'none',
    padding: 0,
    margin: 0,
    background: 'rgba(0, 0, 0, 0.45)',
    cursor: 'pointer',
    touchAction: 'manipulation',
    '@media': {
        'screen and (min-width: 901px)': {
            display: 'none',
        },
    },
});

export const aiBadge = style({
    position: 'fixed',
    zIndex: 10060,
    display: 'flex',
    flexDirection: 'column',
    gap: '3px',
    fontFamily: vars.font.body,
    fontSize: '0.64rem',
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.borderBright}`,
    borderRadius: vars.radius.sm,
    padding: '8px',
    color: vars.color.foreground,
    width: 'min(18rem, calc(100vw - 24px))',
    maxHeight: 'min(70vh, calc(100% - 24px))',
    overflowY: 'auto',
    overflowX: 'hidden',
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.45)',
    pointerEvents: 'auto',
    '@media': {
        'screen and (max-width: 900px)': {
            left: '0 !important',
            right: '0 !important',
            top: 'auto !important',
            bottom: '0',
            width: '100%',
            maxWidth: '100%',
            maxHeight: '78dvh',
            borderRadius: '14px 14px 0 0',
            padding: '10px 12px calc(12px + env(safe-area-inset-bottom))',
            overflowY: 'auto',
            WebkitOverflowScrolling: 'touch',
        },
    },
});

export const aiHeader = style({
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flexShrink: 0,
    position: 'sticky',
    top: 0,
    zIndex: 2,
    background: vars.color.panelRaised,
    paddingBottom: '4px',
});

export const aiClose = style({
    flexShrink: 0,
    marginLeft: 'auto',
    border: `2px solid ${vars.color.amber}`,
    background: vars.color.amber,
    color: '#111',
    width: 44,
    height: 44,
    minWidth: 48,
    minHeight: 48,
    borderRadius: 10,
    fontSize: '1.15rem',
    fontWeight: 800,
    lineHeight: 1,
    padding: 0,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
    zIndex: 5,
    position: 'relative',
    ':hover': {
        filter: 'brightness(1.1)',
    },
});

export const aiDragBar = style({
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    flex: 1,
    minWidth: 0,
    cursor: 'grab',
    userSelect: 'none',
    paddingBottom: '4px',
    borderBottom: `1px solid ${vars.color.border}`,
    ':active': {
        cursor: 'grabbing',
    },
});

export const aiDragHint = style({
    flexShrink: 0,
    fontSize: '0.62rem',
    color: vars.color.mutedForeground,
    letterSpacing: '-0.05em',
});

export const aiCloseFull = style({
    marginTop: '4px',
    width: '100%',
    border: `1px solid ${vars.color.amber}`,
    background: vars.color.panelRaised,
    color: vars.color.amber,
    borderRadius: vars.radius.sm,
    padding: '12px 8px',
    minHeight: 44,
    fontSize: '0.8rem',
    fontWeight: 700,
    cursor: 'pointer',
    touchAction: 'manipulation',
    flexShrink: 0,
    position: 'sticky',
    bottom: 0,
});

export const aiStructure = style({
    display: 'grid',
    gap: '4px',
    paddingTop: '2px',
    borderTop: `1px solid ${vars.color.border}`,
});

export const aiStructureBias = style({
    fontSize: '0.72rem',
    fontWeight: 700,
    color: vars.color.accent,
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
});

export const aiStructureConfidence = style({
    fontStyle: 'normal',
    fontWeight: 500,
    fontSize: '0.62rem',
    color: vars.color.mutedForeground,
});

export const aiStructureHint = style({
    fontSize: '0.62rem',
    lineHeight: 1.4,
    color: vars.color.foreground,
});

export const aiTitle = style({
    fontFamily: vars.font.display,
    fontSize: '0.72rem',
    fontWeight: 700,
    color: vars.color.foreground,
    letterSpacing: '0.02em',
    minWidth: 0,
    flex: 1,
});

export const aiScore = style({
    fontFamily: vars.font.mono,
    fontSize: '0.78rem',
    fontWeight: 700,
    fontVariantNumeric: 'tabular-nums',
    '@media': {
        'screen and (max-width: 900px)': {
            fontSize: '0.98rem',
        },
    },
});

export const aiProbRow = style({
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: '8px',
    padding: '4px 0',
    borderTop: `1px solid ${vars.color.border}`,
    borderBottom: `1px solid ${vars.color.border}`,
});

export const aiProbLabel = style({
    fontSize: '0.72rem',
    fontWeight: 700,
    color: vars.color.foreground,
});

export const aiProbValue = style({
    fontFamily: vars.font.mono,
    fontSize: '1.15rem',
    fontWeight: 800,
    fontVariantNumeric: 'tabular-nums',
});

export const aiPriceRow = style({
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    fontFamily: vars.font.mono,
    fontSize: '0.72rem',
    fontWeight: 600,
});

export const aiContextBox = style({
    display: 'grid',
    gap: '3px',
    padding: '6px 0',
    borderTop: `1px solid ${vars.color.border}`,
});

export const aiContextTitle = style({
    fontSize: '0.7rem',
    fontWeight: 700,
    color: vars.color.accent,
});

export const aiContextText = style({
    fontSize: '0.64rem',
    lineHeight: 1.4,
    color: vars.color.mutedForeground,
});

export const aiNewsLine = style({
    fontSize: '0.62rem',
    lineHeight: 1.35,
    color: vars.color.foreground,
});

const verdictBase = {
    display: 'grid',
    gap: '3px',
    padding: '8px',
    borderRadius: vars.radius.sm,
    fontSize: '0.66rem',
    lineHeight: 1.4,
} as const;

export const aiVerdictDo = style({
    ...verdictBase,
    border: `1px solid ${vars.color.up}`,
    background: 'rgba(46, 160, 90, 0.12)',
    color: vars.color.foreground,
});

export const aiVerdictWatch = style({
    ...verdictBase,
    border: `1px solid ${vars.color.amber}`,
    background: 'rgba(224, 164, 60, 0.12)',
    color: vars.color.foreground,
});

export const aiVerdictAvoid = style({
    ...verdictBase,
    border: `1px solid ${vars.color.danger}`,
    background: 'rgba(220, 70, 70, 0.12)',
    color: vars.color.foreground,
});

export const aiFailExitSell = style({
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    marginTop: 4,
    padding: '4px 6px',
    borderRadius: 4,
    border: `1px solid ${vars.color.danger}`,
    background: 'rgba(220, 70, 70, 0.1)',
    fontSize: '0.62rem',
    lineHeight: 1.35,
});

export const aiFailExitHold = style({
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    marginTop: 4,
    padding: '4px 6px',
    borderRadius: 4,
    border: `1px solid ${vars.color.up}`,
    background: 'rgba(46, 160, 90, 0.1)',
    fontSize: '0.62rem',
    lineHeight: 1.35,
});

export const aiFailExitCut = style({
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    marginTop: 4,
    padding: '4px 6px',
    borderRadius: 4,
    border: `1px solid ${vars.color.amber}`,
    background: 'rgba(224, 164, 60, 0.1)',
    fontSize: '0.62rem',
    lineHeight: 1.35,
});

export const aiReason = style({
    fontSize: '0.62rem',
    color: vars.color.mutedForeground,
    lineHeight: 1.35,
    '@media': {
        'screen and (max-width: 900px)': {
            fontSize: '0.7rem',
            lineHeight: 1.45,
        },
    },
});

export const aiLevels = style({
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '2px 8px',
    fontFamily: vars.font.mono,
    fontSize: '0.62rem',
    color: vars.color.foreground,
    fontVariantNumeric: 'tabular-nums',
    '@media': {
        'screen and (max-width: 900px)': {
            fontSize: '0.72rem',
            gap: '4px 10px',
        },
    },
});

export const coachInline = style({
    flex: '1 1 12rem',
    minWidth: '8rem',
    maxWidth: '100%',
    fontSize: '0.66rem',
    lineHeight: 1.35,
    color: vars.color.foreground,
    background: 'rgba(224, 164, 60, 0.1)',
    border: `1px solid rgba(224, 164, 60, 0.4)`,
    borderRadius: vars.radius.sm,
    padding: '3px 8px',
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
    '@media': {
        'screen and (max-width: 900px)': {
            flexBasis: '100%',
            WebkitLineClamp: 3,
            fontSize: '0.7rem',
        },
    },
});

export const aiHint = style({
    fontSize: '0.58rem',
    color: vars.color.mutedForeground,
    opacity: 0.85,
});

export const aiAlert = style({
    fontSize: '0.62rem',
    lineHeight: 1.35,
    color: vars.color.amber,
    background: 'rgba(224, 164, 60, 0.1)',
    border: `1px solid rgba(224, 164, 60, 0.35)`,
    borderRadius: vars.radius.sm,
    padding: '3px 6px',
    '@media': {
        'screen and (max-width: 900px)': {
            fontSize: '0.7rem',
        },
    },
});

export const aiCoach = style({
    fontSize: '0.62rem',
    lineHeight: 1.4,
    color: vars.color.foreground,
    borderTop: `1px solid ${vars.color.border}`,
    paddingTop: '4px',
    marginTop: '2px',
    '@media': {
        'screen and (max-width: 900px)': {
            fontSize: '0.7rem',
        },
    },
});

export const triggerList = style({
    position: 'absolute',
    top: '8px',
    left: '8px',
    zIndex: 5,
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    fontFamily: vars.font.mono,
    fontSize: '0.64rem',
    fontVariantNumeric: 'tabular-nums',
    pointerEvents: 'auto',
});

export const triggerRow = style({
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    padding: '1px 6px',
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    color: vars.color.foreground,
});

export const orderCancel = style({
    fontFamily: vars.font.display,
    fontSize: '0.58rem',
    fontWeight: 600,
    letterSpacing: '0.04em',
    cursor: 'pointer',
    background: 'transparent',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    color: vars.color.danger,
    padding: '0 6px',
    ':hover': {
        borderColor: vars.color.danger,
        background: vars.color.muted,
    },
});

export const triggerRemove = style({
    fontFamily: vars.font.mono,
    fontSize: '0.62rem',
    lineHeight: 1,
    cursor: 'pointer',
    background: 'transparent',
    border: 'none',
    color: vars.color.mutedForeground,
    padding: '1px 2px',
    ':hover': { color: vars.color.danger },
});

export const chartStage = style({
    flex: 1,
    minHeight: 0,
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    touchAction: 'none', // let LWC own pinch / drag
    '@media': {
        'screen and (max-width: 900px)': {
            // Cap chart so quote + toolbar leave room; user zooms with ＋－適
            flex: '1 1 auto',
            minHeight: '10rem',
            maxHeight: '58dvh',
        },
    },
});

export const chartHost = style({
    flex: 1,
    minHeight: 0,
    position: 'relative',
    zIndex: 1,
});

export const chartOverlay = style({
    position: 'absolute',
    inset: 0,
    zIndex: 30,
    pointerEvents: 'none',
});

export const emptyMsg = style({
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: vars.color.mutedForeground,
    fontFamily: vars.font.display,
    fontSize: '0.78rem',
});
