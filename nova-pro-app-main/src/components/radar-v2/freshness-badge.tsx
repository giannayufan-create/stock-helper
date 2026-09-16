import { FRESHNESS_LABEL, normalizeFreshness, type FreshnessLevel } from './ui-context';
import { radarColor } from './tokens';
import { vars } from '../../theme.css';

const tone: Record<FreshnessLevel, string> = {
    REALTIME: radarColor.live,
    NEAR_REALTIME: radarColor.health,
    DELAYED: radarColor.heating,
    EOD: vars.color.mutedForeground,
    PREVIOUS_DAY: vars.color.mutedForeground,
    UNKNOWN: vars.color.mutedForeground,
    STALE: radarColor.healthBad,
};

export function FreshnessBadge({
    level,
    stale,
    compact,
}: {
    level?: string | null;
    stale?: boolean;
    compact?: boolean;
}) {
    const f = normalizeFreshness(level, stale);
    return (
        <span
            style={{
                display: 'inline-flex',
                alignItems: 'center',
                minHeight: compact ? 22 : 28,
                padding: compact ? '0 7px' : '0 9px',
                borderRadius: 8,
                fontSize: compact ? 10 : 11,
                fontWeight: 700,
                letterSpacing: '0.04em',
                fontFamily: vars.font.mono,
                color: tone[f],
                background: 'rgba(0,0,0,0.28)',
                border: `1px solid ${tone[f]}44`,
                opacity: f === 'STALE' ? 0.75 : 1,
            }}
        >
            {FRESHNESS_LABEL[f]}
        </span>
    );
}
