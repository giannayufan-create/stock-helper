import { globalStyle, style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { radarColor } from './tokens';

export const shell = style({
    display: 'flex',
    position: 'fixed',
    inset: 0,
    zIndex: 50,
    flexDirection: 'column',
    background: `radial-gradient(120% 80% at 50% -10%, #152038 0%, ${vars.color.background} 55%)`,
    color: vars.color.foreground,
    overflow: 'hidden',
    fontFamily: vars.font.body,
});

export const header = style({
    flex: '0 0 auto',
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
    padding: '10px 16px 8px',
    paddingTop: 'max(10px, env(safe-area-inset-top))',
});

export const brand = style({
    fontFamily: vars.font.display,
    fontSize: 20,
    fontWeight: 700,
    letterSpacing: '-0.02em',
    lineHeight: 1.2,
});

export const headerMeta = style({
    marginTop: 4,
    fontSize: 13,
    color: vars.color.mutedForeground,
    fontVariantNumeric: 'tabular-nums',
});

export const statusPill = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    minHeight: 32,
    padding: '0 10px',
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: '0.04em',
    border: `1px solid ${radarColor.glassBorder}`,
    background: radarColor.glass,
});

export const statusDot = style({
    width: 7,
    height: 7,
    borderRadius: '50%',
    background: radarColor.live,
    boxShadow: `0 0 8px ${radarColor.live}`,
});

export const banner = style({
    margin: '0 16px 8px',
    padding: '12px 14px',
    borderRadius: 14,
    background: 'rgba(245, 165, 36, 0.12)',
    border: '1px solid rgba(245, 165, 36, 0.35)',
    color: '#fcd34d',
    fontSize: 14,
    lineHeight: 1.4,
});

export const bannerBad = style({
    background: 'rgba(239, 68, 68, 0.12)',
    border: '1px solid rgba(239, 68, 68, 0.35)',
    color: '#fca5a5',
});

export const page = style({
    flex: 1,
    overflowY: 'auto',
    overflowX: 'hidden',
    padding: '0 16px 12px',
    WebkitOverflowScrolling: 'touch',
});

export const pageEnd = style({
    height: 72,
});

export const glass = style({
    background: radarColor.glass,
    border: `1px solid ${radarColor.glassBorder}`,
    borderRadius: 18,
    boxShadow: `inset 0 1px 0 ${radarColor.glassHighlight}`,
    backdropFilter: 'blur(14px)',
    WebkitBackdropFilter: 'blur(14px)',
});

export const healthStrip = style([
    glass,
    {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
        padding: '12px 14px',
        marginBottom: 12,
        minHeight: 52,
    },
]);

export const radarCard = style([
    glass,
    {
        padding: '14px 14px 12px',
        marginBottom: 10,
        cursor: 'pointer',
        textAlign: 'left',
        width: '100%',
        color: 'inherit',
        display: 'block',
        minHeight: 44,
        transition: 'opacity 160ms ease, border-color 160ms ease',
        border: `1px solid ${radarColor.glassBorder}`,
        selectors: {
            '&:active': {
                opacity: 0.92,
            },
        },
    },
]);

export const radarCardOn = style({
    borderColor: 'rgba(240, 67, 74, 0.45)',
    boxShadow: `0 0 0 1px rgba(240, 67, 74, 0.2)`,
});

export const radarCardStale = style({
    opacity: 0.55,
});

export const cardMetaGrid = style({
    display: 'grid',
    gridTemplateColumns: '1fr 1fr 1fr',
    gap: 8,
    marginTop: 10,
    marginBottom: 10,
});

export const cardMetaCell = style({
    minWidth: 0,
});

export const cardMetaLab = style({
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: '0.04em',
    color: vars.color.mutedForeground,
    marginBottom: 2,
});

export const cardMetaVal = style({
    fontFamily: vars.font.mono,
    fontSize: 13,
    fontWeight: 700,
    fontVariantNumeric: 'tabular-nums',
});

export const zoneTitle = style({
    fontSize: 15,
    fontWeight: 700,
    letterSpacing: '-0.01em',
    marginBottom: 8,
});

export const zoneBlock = style([
    glass,
    {
        padding: '14px',
        marginBottom: 12,
    },
]);

export const section = style({
    marginBottom: 22,
});

export const sectionTitle = style({
    fontSize: 20,
    fontWeight: 700,
    letterSpacing: '-0.02em',
    marginBottom: 10,
});

export const sectionRow = style({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
});

export const linkBtn = style({
    border: 'none',
    background: 'transparent',
    color: vars.color.mutedForeground,
    fontSize: 13,
    fontWeight: 600,
    minHeight: 44,
    minWidth: 44,
    padding: '0 8px',
    boxSizing: 'border-box',
});

export const marketCard = style([
    glass,
    {
        padding: '16px 16px 14px',
    },
]);

export const marketHead = style({
    display: 'flex',
    alignItems: 'baseline',
    gap: 10,
    marginBottom: 12,
});

export const marketIcon = style({
    fontSize: 28,
    lineHeight: 1,
});

export const marketLabel = style({
    fontSize: 24,
    fontWeight: 700,
    letterSpacing: '-0.02em',
});

export const marketScore = style({
    marginLeft: 'auto',
    fontFamily: vars.font.mono,
    fontSize: 28,
    fontWeight: 700,
    fontVariantNumeric: 'tabular-nums',
});

export const indexRow = style({
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 10,
    marginBottom: 14,
});

export const indexCell = style({
    fontSize: 14,
});

export const indexName = style({
    color: vars.color.mutedForeground,
    fontSize: 12,
    marginBottom: 2,
});

export const counts = style({
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: 6,
});

export const countCell = style({
    textAlign: 'center',
    padding: '8px 4px',
    borderRadius: 12,
    background: 'rgba(0,0,0,0.22)',
});

export const countVal = style({
    fontFamily: vars.font.mono,
    fontSize: 18,
    fontWeight: 700,
    fontVariantNumeric: 'tabular-nums',
});

export const countLab = style({
    fontSize: 11,
    color: vars.color.mutedForeground,
    marginTop: 2,
});

export const stockCard = style([
    glass,
    {
        padding: '16px',
        marginBottom: 12,
        cursor: 'pointer',
        textAlign: 'left',
        width: '100%',
        color: 'inherit',
        display: 'block',
        minHeight: 44,
    },
]);

export const cardTop = style({
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    marginBottom: 10,
});

export const rankBadge = style({
    fontFamily: vars.font.mono,
    fontSize: 13,
    fontWeight: 700,
    color: vars.color.mutedForeground,
    minWidth: 28,
});

export const symBlock = style({
    flex: 1,
    minWidth: 0,
});

export const symCode = style({
    fontFamily: vars.font.mono,
    fontSize: 16,
    fontWeight: 700,
});

export const symName = style({
    fontSize: 14,
    color: vars.color.mutedForeground,
    marginLeft: 6,
});

export const pctBig = style({
    fontFamily: vars.font.mono,
    fontSize: 18,
    fontWeight: 700,
    fontVariantNumeric: 'tabular-nums',
});

export const scoreRow = style({
    display: 'flex',
    gap: 16,
    marginBottom: 8,
    alignItems: 'baseline',
});

export const scoreBig = style({
    fontFamily: vars.font.mono,
    fontSize: 26,
    fontWeight: 700,
    fontVariantNumeric: 'tabular-nums',
    color: radarColor.strong,
});

export const heatBig = style({
    fontFamily: vars.font.mono,
    fontSize: 22,
    fontWeight: 700,
    fontVariantNumeric: 'tabular-nums',
    color: radarColor.heating,
});

export const scoreCap = style({
    fontSize: 11,
    fontWeight: 600,
    color: vars.color.mutedForeground,
    marginRight: 6,
    letterSpacing: '0.04em',
});

export const stateLine = style({
    fontSize: 13,
    fontWeight: 700,
    letterSpacing: '0.04em',
    marginBottom: 10,
    color: radarColor.strong,
});

export const metricGrid = style({
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '8px 12px',
    marginBottom: 10,
    fontSize: 13,
});

export const metricLab = style({
    color: vars.color.mutedForeground,
    fontSize: 12,
    marginRight: 6,
});

export const reasonList = style({
    margin: 0,
    padding: 0,
    listStyle: 'none',
    fontSize: 13,
    color: vars.color.mutedForeground,
    lineHeight: 1.45,
});

export const reasonItem = style({
    selectors: {
        '&::before': {
            content: '"● "',
            color: radarColor.heating,
        },
    },
});

export const cardFooter = style({
    marginTop: 12,
    fontSize: 13,
    fontWeight: 600,
    color: vars.color.mutedForeground,
});

export const hScroll = style({
    display: 'flex',
    gap: 10,
    overflowX: 'auto',
    paddingBottom: 4,
    marginInline: -4,
    paddingInline: 4,
    scrollbarWidth: 'none',
});

globalStyle(`${hScroll}::-webkit-scrollbar`, { display: 'none' });

export const miniCard = style([
    glass,
    {
        flex: '0 0 132px',
        padding: '12px',
        cursor: 'pointer',
        textAlign: 'left',
        color: 'inherit',
        minHeight: 120,
    },
]);

export const miniCode = style({
    fontFamily: vars.font.mono,
    fontWeight: 700,
    fontSize: 16,
    marginBottom: 8,
});

export const dock = style({
    flex: '0 0 auto',
    display: 'grid',
    gridTemplateColumns: 'repeat(5, 1fr)',
    gap: 0,
    minHeight: 68,
    paddingBottom: 'max(6px, env(safe-area-inset-bottom))',
    borderTop: `1px solid ${radarColor.glassBorder}`,
    background: 'rgba(8, 12, 20, 0.92)',
    backdropFilter: 'blur(16px)',
    WebkitBackdropFilter: 'blur(16px)',
});

export const dockBtn = style({
    border: 'none',
    background: 'transparent',
    color: vars.color.mutedForeground,
    fontSize: 12,
    fontWeight: 600,
    minHeight: 56,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    cursor: 'pointer',
});

export const dockBtnOn = style({
    color: vars.color.foreground,
});

export const dockIcon = style({
    fontSize: 16,
    lineHeight: 1,
    opacity: 0.9,
});

export const stickyTabs = style({
    position: 'sticky',
    top: 0,
    zIndex: 5,
    display: 'flex',
    gap: 6,
    padding: '8px 0 12px',
    background: `linear-gradient(180deg, ${vars.color.background} 70%, transparent)`,
    overflowX: 'auto',
});

export const tabChip = style({
    flex: '0 0 auto',
    minHeight: 40,
    padding: '0 14px',
    borderRadius: 999,
    border: `1px solid ${radarColor.glassBorder}`,
    background: 'transparent',
    color: vars.color.mutedForeground,
    fontSize: 14,
    fontWeight: 600,
});

export const tabChipOn = style({
    background: radarColor.strongDim,
    borderColor: 'rgba(240, 67, 74, 0.45)',
    color: '#fecaca',
});

export const detailOverlay = style({
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    minWidth: 0,
    background: vars.color.background,
});

export const detailHeader = style({
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '10px 12px',
    paddingTop: 'max(10px, env(safe-area-inset-top))',
    borderBottom: `1px solid ${radarColor.glassBorder}`,
});

export const iconBtn = style({
    boxSizing: 'border-box',
    width: 44,
    height: 44,
    minWidth: 44,
    minHeight: 44,
    flexShrink: 0,
    borderRadius: 12,
    border: `1px solid ${radarColor.glassBorder}`,
    background: radarColor.glass,
    color: vars.color.foreground,
    fontSize: 18,
    display: 'grid',
    placeItems: 'center',
    cursor: 'pointer',
    padding: 0,
});

export const detailBody = style({
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    overflowX: 'hidden',
    padding: '16px',
    paddingBottom: 28,
    WebkitOverflowScrolling: 'touch',
    overscrollBehavior: 'contain',
    touchAction: 'pan-y',
});

export const priceHero = style({
    fontFamily: vars.font.mono,
    fontSize: 32,
    fontWeight: 700,
    fontVariantNumeric: 'tabular-nums',
    lineHeight: 1.1,
});

export const twoCol = style({
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 12,
});

export const metricTile = style([
    glass,
    {
        padding: '12px 14px',
    },
]);

export const metricTileLab = style({
    fontSize: 12,
    color: vars.color.mutedForeground,
    marginBottom: 4,
});

export const metricTileVal = style({
    fontFamily: vars.font.mono,
    fontSize: 20,
    fontWeight: 700,
    fontVariantNumeric: 'tabular-nums',
});

export const tag = style({
    display: 'inline-flex',
    alignItems: 'center',
    minHeight: 28,
    padding: '0 10px',
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 600,
    background: 'rgba(148,163,184,0.12)',
    color: vars.color.mutedForeground,
});

export const aiCard = style([
    glass,
    {
        padding: '16px',
        borderColor: 'rgba(139, 124, 246, 0.35)',
        background: 'rgba(139, 124, 246, 0.08)',
    },
]);

export const aiBtn = style({
    width: '100%',
    minHeight: 48,
    borderRadius: 14,
    border: `1px solid rgba(139, 124, 246, 0.45)`,
    background: radarColor.aiDim,
    color: radarColor.aiSoft,
    fontSize: 15,
    fontWeight: 700,
    cursor: 'pointer',
});

export const empty = style({
    padding: '28px 12px',
    textAlign: 'center',
    color: vars.color.mutedForeground,
    fontSize: 14,
    lineHeight: 1.5,
});

export const sheetMask = style({
    position: 'absolute',
    inset: 0,
    zIndex: 70,
    background: 'rgba(0,0,0,0.55)',
    display: 'flex',
    alignItems: 'flex-end',
});

export const sheet = style([
    glass,
    {
        width: '100%',
        borderBottomLeftRadius: 0,
        borderBottomRightRadius: 0,
        padding: '16px 16px max(16px, env(safe-area-inset-bottom))',
        maxHeight: '78vh',
        overflowY: 'auto',
    },
]);

export const sheetTitle = style({
    fontSize: 18,
    fontWeight: 700,
    marginBottom: 12,
});

export const sheetActions = style({
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 10,
    marginTop: 16,
});

export const btnGhost = style({
    minHeight: 48,
    borderRadius: 14,
    border: `1px solid ${radarColor.glassBorder}`,
    background: 'transparent',
    color: vars.color.foreground,
    fontWeight: 600,
});

export const btnPrimary = style({
    minHeight: 48,
    borderRadius: 14,
    border: 'none',
    background: radarColor.strong,
    color: '#fff',
    fontWeight: 700,
});

export const eventRow = style({
    padding: '12px 0',
    borderBottom: `1px solid ${radarColor.glassBorder}`,
});

export const eventTime = style({
    fontFamily: vars.font.mono,
    fontSize: 12,
    color: vars.color.mutedForeground,
    marginBottom: 4,
});

export const detailPanel = style({
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    // Grid/flex default min-height:auto expands to content → shell clips, no scroll.
    minHeight: 0,
    minWidth: 0,
    overflow: 'hidden',
    background: vars.color.background,
    borderLeft: `1px solid ${radarColor.glassBorder}`,
});

export const desktopShell = style({
    display: 'grid',
    gridTemplateColumns: '200px minmax(0, 1fr) minmax(340px, 420px)',
    height: '100%',
    width: '100%',
    background: `radial-gradient(100% 80% at 40% -10%, #152038 0%, ${vars.color.background} 50%)`,
    color: vars.color.foreground,
    overflow: 'hidden',
    fontFamily: vars.font.body,
    '@media': {
        'screen and (max-width: 1100px)': {
            gridTemplateColumns: '180px minmax(0, 1fr)',
        },
    },
});

globalStyle(`${desktopShell} > *`, {
    minHeight: 0,
    minWidth: 0,
});

export const sideNav = style({
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    padding: '16px 12px',
    borderRight: `1px solid ${radarColor.glassBorder}`,
    background: 'rgba(8, 12, 20, 0.85)',
});

export const sideBrand = style({
    padding: '4px 8px 16px',
});

export const sideBrandMain = style({
    fontSize: 18,
    fontWeight: 800,
    letterSpacing: '-0.02em',
});

export const sideBrandSub = style({
    fontSize: 12,
    color: vars.color.mutedForeground,
    marginTop: 2,
});

export const sideBtn = style({
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    minHeight: 44,
    padding: '0 12px',
    borderRadius: 12,
    border: 'none',
    background: 'transparent',
    color: vars.color.mutedForeground,
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    textAlign: 'left',
});

export const sideBtnOn = style({
    background: radarColor.strongDim,
    color: vars.color.foreground,
});

export const desktopMain = style({
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    minHeight: 0,
    overflow: 'hidden',
});

export const simBadge = style({
    display: 'inline-flex',
    alignItems: 'center',
    minHeight: 24,
    padding: '0 8px',
    borderRadius: 6,
    fontSize: 11,
    fontWeight: 800,
    letterSpacing: '0.06em',
    background: 'rgba(245, 165, 36, 0.16)',
    color: '#fcd34d',
    border: '1px solid rgba(245, 165, 36, 0.35)',
});

export const liveBadge = style({
    background: 'rgba(45, 212, 191, 0.14)',
    color: radarColor.health,
    border: `1px solid rgba(45, 212, 191, 0.35)`,
});

export const toneUp = style({ color: vars.color.up });
export const toneDown = style({ color: vars.color.down });
export const toneFlat = style({ color: vars.color.flat });

export const liveVariants = styleVariants({
    LIVE: { color: radarColor.live },
    REPLAY: { color: radarColor.ai },
    WAKING: { color: radarColor.healthWarn },
    'DATA STALE': { color: radarColor.healthBad },
    DISCONNECTED: { color: radarColor.healthBad },
});

/** Compact scannable list row */
export const rowCard = style({
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    width: '100%',
    minHeight: 64,
    padding: '10px 12px',
    marginBottom: 8,
    textAlign: 'left',
    color: 'inherit',
    cursor: 'pointer',
    background: radarColor.glass,
    border: `1px solid ${radarColor.glassBorder}`,
    borderRadius: 14,
    boxShadow: `inset 0 1px 0 ${radarColor.glassHighlight}`,
});

export const rowCardOn = style({
    borderColor: 'rgba(240, 67, 74, 0.55)',
    background: 'rgba(240, 67, 74, 0.08)',
});

export const rowLeft = style({
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flex: 1,
    minWidth: 0,
});

export const rowRank = style({
    fontFamily: vars.font.mono,
    fontSize: 12,
    fontWeight: 700,
    color: vars.color.mutedForeground,
    width: 28,
    flexShrink: 0,
});

export const rowSym = style({
    fontFamily: vars.font.mono,
    fontSize: 16,
    fontWeight: 700,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
});

export const rowName = style({
    marginLeft: 6,
    fontFamily: vars.font.body,
    fontSize: 13,
    fontWeight: 500,
    color: vars.color.mutedForeground,
});

export const rowState = style({
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.02em',
    marginTop: 2,
});

export const rowMid = style({
    display: 'flex',
    gap: 10,
    flexShrink: 0,
});

export const rowCap = style({
    fontSize: 10,
    color: vars.color.mutedForeground,
    marginRight: 2,
    fontWeight: 600,
});

export const rowC = style({
    fontFamily: vars.font.mono,
    fontSize: 18,
    fontWeight: 800,
    color: radarColor.strong,
    fontVariantNumeric: 'tabular-nums',
});

export const rowH = style({
    fontFamily: vars.font.mono,
    fontSize: 18,
    fontWeight: 800,
    color: radarColor.heating,
    fontVariantNumeric: 'tabular-nums',
});

export const rowPct = style({
    fontFamily: vars.font.mono,
    fontSize: 14,
    fontWeight: 700,
    minWidth: 64,
    textAlign: 'right',
    flexShrink: 0,
    fontVariantNumeric: 'tabular-nums',
});

export const chipCard = style({
    flex: '0 0 108px',
    minHeight: 88,
    padding: '10px',
    textAlign: 'left',
    color: 'inherit',
    cursor: 'pointer',
    background: radarColor.glass,
    border: `1px solid ${radarColor.glassBorder}`,
    borderRadius: 14,
});

export const chipCode = style({
    fontFamily: vars.font.mono,
    fontWeight: 800,
    fontSize: 15,
    marginBottom: 6,
});

export const chipMeta = style({
    fontSize: 12,
    color: vars.color.mutedForeground,
    marginBottom: 4,
});

export const marketStrip = style([
    glass,
    {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '12px 14px',
        marginBottom: 14,
        flexWrap: 'wrap',
    },
]);

export const quickBar = style({
    display: 'grid',
    gridTemplateColumns: '1fr 1fr 1fr',
    gap: 8,
    marginBottom: 16,
});

export const quickBtn = style({
    minHeight: 44,
    borderRadius: 12,
    border: `1px solid ${radarColor.glassBorder}`,
    background: radarColor.glass,
    color: vars.color.foreground,
    fontSize: 13,
    fontWeight: 700,
    cursor: 'pointer',
});

export const detailBackBar = style({
    flex: '0 0 auto',
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 8,
    padding: '10px 16px',
    paddingBottom: 'max(10px, env(safe-area-inset-bottom))',
    borderTop: `1px solid ${radarColor.glassBorder}`,
    background: 'rgba(8, 12, 20, 0.94)',
});

export const decisionBlock = style({
    marginTop: 10,
    marginBottom: 10,
    textAlign: 'left',
});

export const decisionStatus = style({
    fontSize: 13,
    fontWeight: 800,
    letterSpacing: '0.04em',
    lineHeight: 1.3,
});

export const decisionHeadline = style({
    marginTop: 4,
    fontSize: 13,
    fontWeight: 600,
    color: vars.color.foreground,
    lineHeight: 1.4,
});

export const decisionSection = style([
    glass,
    {
        padding: '14px 16px',
        marginBottom: 16,
    },
]);
