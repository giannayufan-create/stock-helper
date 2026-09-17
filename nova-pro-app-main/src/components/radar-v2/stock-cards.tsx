import type { IntradayRankItemDto } from '../../lib/backend';
import type { BuyPressureItemDto } from '../../lib/buy-pressure';
import {
    DECISION_STATUS_EMOJI,
    DECISION_STATUS_LABEL,
    type DecisionSummaryDto,
} from '../../lib/decision-summary';
import {
    continuationShort,
    momentumLabel,
    type RadarQualityItemDto,
} from '../../lib/radar-quality';
import { vars } from '../../theme.css';
import {
    chaseLabel,
    eventLabel,
    fmtPctSigned,
    primaryEvent,
    stateLabel,
    stateTone,
} from './helpers';
import { ConfirmLayersRow } from './confirm-layers';
import { FreshnessBadge } from './freshness-badge';
import * as s from './radar.css';
import { radarColor } from './tokens';
import {
    deriveConfirmLayers,
    SECTOR_STATE_LABEL,
    type ConfirmLayers,
} from './ui-context';

function pctTone(pct: number | null | undefined) {
    if (pct == null || pct === 0) return s.toneFlat;
    return pct > 0 ? s.toneUp : s.toneDown;
}

function decisionTone(status: DecisionSummaryDto['status']): string {
    if (status === 'CONFIRMED_STRENGTH') return radarColor.strong;
    if (status === 'EXTENDED') return '#a78bfa';
    if (status === 'WATCH') return '#f59e0b';
    return vars.color.mutedForeground;
}

export interface RadarCardEnrichment {
    bp?: BuyPressureItemDto | null;
    sectorName?: string | null;
    sectorRank?: number | null;
    sectorState?: string | null;
    sectorHeat?: number | null;
    taiwanRegime?: string | null;
    eventConfirmed?: boolean;
    layers?: ConfirmLayers;
    decision?: DecisionSummaryDto | null;
    quality?: RadarQualityItemDto | null;
}

/** Premium radar card — curated metrics only. */
export function CompactStockRow({
    item,
    rank,
    selected,
    onOpen,
    enrich,
}: {
    item: IntradayRankItemDto;
    rank?: number;
    selected?: boolean;
    onOpen: (symbol: string) => void;
    enrich?: RadarCardEnrichment;
}) {
    const bp = enrich?.bp;
    const adj =
        item.adjusted_change_pct ?? item.change_pct ?? item.metrics?.return_3m ?? null;
    const raw = item.raw_change_pct;
    const ca = item.corporate_action;
    const stale =
        item.data_blocked ||
        item.data_health === 'stale' ||
        item.data_health === 'disconnected' ||
        Boolean(bp?.data_stale);
    const price = item.last_price;
    const layers =
        enrich?.decision?.layers ??
        enrich?.layers ??
        deriveConfirmLayers({
            state: item.state,
            bpStates: bp?.states,
            sectorState: enrich?.sectorState,
            sectorHeat: enrich?.sectorHeat,
            taiwanRegime: enrich?.taiwanRegime,
            eventConfirmed: enrich?.eventConfirmed,
        });
    const decision = enrich?.decision ?? null;
    const quality = enrich?.quality ?? null;
    const event = primaryEvent(item);
    const rankChg = item.rank_change;
    const chase = bp?.chase_risk ?? item.risk?.chase_risk;
    const rvol = bp?.rvol ?? item.metrics?.rvol_same_time;
    const vwap =
        bp?.distance_from_vwap_pct ?? item.metrics?.vwap_pos_pct ?? null;

    return (
        <button
            type="button"
            className={`${s.radarCard} ${selected ? s.radarCardOn : ''} ${stale ? s.radarCardStale : ''}`}
            onClick={() => onOpen(item.symbol)}
        >
            <div
                style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 10,
                    alignItems: 'flex-start',
                }}
            >
                <div style={{ minWidth: 0, flex: 1 }}>
                    <div
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            flexWrap: 'wrap',
                        }}
                    >
                        {rank != null && (
                            <span
                                style={{
                                    fontFamily: vars.font.mono,
                                    fontSize: 12,
                                    fontWeight: 700,
                                    color: vars.color.mutedForeground,
                                }}
                            >
                                #{rank}
                            </span>
                        )}
                        <span
                            style={{
                                fontFamily: vars.font.mono,
                                fontSize: 17,
                                fontWeight: 800,
                            }}
                        >
                            {item.symbol}
                        </span>
                        <span
                            style={{
                                fontSize: 13,
                                color: vars.color.mutedForeground,
                            }}
                        >
                            {item.name}
                        </span>
                        {ca?.has_action_today && ca.badge ? (
                            <span
                                style={{
                                    fontSize: 10,
                                    fontWeight: 800,
                                    color: '#e8a87c',
                                    letterSpacing: '0.04em',
                                }}
                            >
                                {ca.badge}
                            </span>
                        ) : null}
                        {stale ? <FreshnessBadge level="STALE" compact /> : null}
                    </div>
                    <div
                        style={{
                            marginTop: 4,
                            fontSize: 12,
                            fontWeight: 700,
                            color: stateTone(item.state),
                        }}
                    >
                        {quality ? (
                            <span style={{ color: radarColor.aiSoft }}>
                                {quality.is_focus
                                    ? `FOCUS #${quality.focus_rank} · `
                                    : ''}
                                {momentumLabel(quality.momentum_state)}
                                {' · '}
                            </span>
                        ) : null}
                        {stateLabel(item.state)}
                        {event ? ` · ${eventLabel(event)}` : ''}
                        {enrich?.sectorName
                            ? ` · ${enrich.sectorName}`
                            : ''}
                        {enrich?.sectorRank != null
                            ? ` #${enrich.sectorRank}`
                            : ''}
                        {quality?.institutional?.continuation
                            ? ` · ${continuationShort(quality.institutional.continuation)}`
                            : ''}
                    </div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    {price != null && price > 0 ? (
                        <div
                            style={{
                                fontFamily: vars.font.mono,
                                fontSize: 16,
                                fontWeight: 700,
                            }}
                        >
                            {price.toFixed(price >= 100 ? 1 : 2)}
                        </div>
                    ) : null}
                    <div className={`${s.pctBig} ${pctTone(adj)}`} style={{ fontSize: 16 }}>
                        {fmtPctSigned(adj)}
                    </div>
                    {ca?.has_action_today &&
                    raw != null &&
                    adj != null &&
                    Math.abs(raw - adj) > 0.05 ? (
                        <div
                            style={{
                                fontSize: 10,
                                color: vars.color.mutedForeground,
                                marginTop: 2,
                            }}
                        >
                            Adj {fmtPctSigned(adj)} · Raw {fmtPctSigned(raw)}
                        </div>
                    ) : null}
                </div>
            </div>

            {decision ? (
                <div className={s.decisionBlock}>
                    <div
                        className={s.decisionStatus}
                        style={{ color: decisionTone(decision.status) }}
                    >
                        {DECISION_STATUS_EMOJI[decision.status]}{' '}
                        {DECISION_STATUS_LABEL[decision.status]}
                    </div>
                    <div className={s.decisionHeadline}>{decision.headline}</div>
                </div>
            ) : null}

            <div className={s.cardMetaGrid}>
                <div className={s.cardMetaCell}>
                    <div className={s.cardMetaLab}>BP</div>
                    <div className={s.cardMetaVal} style={{ color: radarColor.heating }}>
                        {bp != null ? Math.round(bp.buy_pressure_score) : '—'}
                    </div>
                </div>
                <div className={s.cardMetaCell}>
                    <div className={s.cardMetaLab}>C</div>
                    <div className={s.cardMetaVal} style={{ color: radarColor.strong }}>
                        {Math.round(item.intraday_score)}
                    </div>
                </div>
                <div className={s.cardMetaCell}>
                    <div className={s.cardMetaLab}>Rank</div>
                    <div className={s.cardMetaVal}>
                        {item.rank}
                        {rankChg != null && rankChg !== 0 ? (
                            <span
                                style={{
                                    marginLeft: 4,
                                    color:
                                        rankChg < 0
                                            ? vars.color.up
                                            : vars.color.down,
                                    fontSize: 11,
                                }}
                            >
                                {rankChg > 0 ? `↓${rankChg}` : `↑${Math.abs(rankChg)}`}
                            </span>
                        ) : null}
                    </div>
                </div>
                <div className={s.cardMetaCell}>
                    <div className={s.cardMetaLab}>VWAP</div>
                    <div className={s.cardMetaVal}>
                        {vwap != null ? fmtPctSigned(vwap) : '—'}
                    </div>
                </div>
                <div className={s.cardMetaCell}>
                    <div className={s.cardMetaLab}>RVOL</div>
                    <div className={s.cardMetaVal}>
                        {rvol != null ? `${rvol.toFixed(1)}x` : '—'}
                    </div>
                </div>
                <div className={s.cardMetaCell}>
                    <div className={s.cardMetaLab}>Chase</div>
                    <div className={s.cardMetaVal}>{chaseLabel(chase)}</div>
                </div>
            </div>

            {enrich?.sectorState ? (
                <div
                    style={{
                        fontSize: 11,
                        color: vars.color.mutedForeground,
                        marginBottom: 8,
                    }}
                >
                    產業{' '}
                    {SECTOR_STATE_LABEL[enrich.sectorState] ?? enrich.sectorState}
                </div>
            ) : null}

            <ConfirmLayersRow layers={layers} size="sm" />
        </button>
    );
}

export function TopStockCard(props: {
    item: IntradayRankItemDto;
    rank: number;
    onOpen: (symbol: string) => void;
    enrich?: RadarCardEnrichment;
}) {
    return (
        <CompactStockRow
            item={props.item}
            rank={props.rank}
            onOpen={props.onOpen}
            enrich={props.enrich}
        />
    );
}

export function MiniHeatCard({
    item,
    onOpen,
}: {
    item: IntradayRankItemDto;
    onOpen: (symbol: string) => void;
}) {
    const pct = item.adjusted_change_pct ?? item.change_pct;
    return (
        <button
            type="button"
            className={s.chipCard}
            onClick={() => onOpen(item.symbol)}
            style={{ minHeight: 88 }}
        >
            <div className={s.chipCode}>{item.symbol}</div>
            <div className={s.chipMeta}>
                C{Math.round(item.intraday_score)}
                {item.corporate_action?.badge
                    ? ` · ${item.corporate_action.badge}`
                    : ''}
            </div>
            <div className={pctTone(pct)} style={{ fontSize: 13, fontWeight: 700 }}>
                {fmtPctSigned(pct ?? null)}
            </div>
        </button>
    );
}

export function MiniPullbackCard({
    item,
    onOpen,
}: {
    item: IntradayRankItemDto;
    onOpen: (symbol: string) => void;
}) {
    return (
        <button
            type="button"
            className={s.chipCard}
            onClick={() => onOpen(item.symbol)}
            style={{ minHeight: 88 }}
        >
            <div className={s.chipCode}>{item.symbol}</div>
            <div className={s.chipMeta}>回踩</div>
            <div
                style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: stateTone(item.state),
                }}
            >
                {stateLabel(item.state)}
            </div>
        </button>
    );
}
