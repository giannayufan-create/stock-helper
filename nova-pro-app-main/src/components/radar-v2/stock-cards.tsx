import type { IntradayRankItemDto } from '../../lib/backend';
import { vars } from '../../theme.css';
import {
    eventLabel,
    fmtPctSigned,
    primaryEvent,
    stateLabel,
    stateTone,
} from './helpers';
import * as s from './radar.css';

function pctTone(pct: number | null | undefined) {
    if (pct == null || pct === 0) return s.toneFlat;
    return pct > 0 ? s.toneUp : s.toneDown;
}

/** One-line scannable row — primary interaction surface. */
export function CompactStockRow({
    item,
    rank,
    selected,
    onOpen,
}: {
    item: IntradayRankItemDto;
    rank?: number;
    selected?: boolean;
    onOpen: (symbol: string) => void;
}) {
    const pct =
        item.adjusted_change_pct ??
        item.change_pct ??
        item.metrics?.return_3m ??
        null;
    const rawPct = item.raw_change_pct;
    const ca = item.corporate_action;
    const event = primaryEvent(item);
    return (
        <button
            type="button"
            className={`${s.rowCard} ${selected ? s.rowCardOn : ''}`}
            onClick={() => onOpen(item.symbol)}
        >
            <div className={s.rowLeft}>
                {rank != null && <span className={s.rowRank}>#{rank}</span>}
                <div>
                    <div className={s.rowSym}>
                        {item.symbol}
                        <span className={s.rowName}>{item.name}</span>
                        {ca?.has_action_today && ca.badge ? (
                            <span
                                style={{
                                    marginLeft: 6,
                                    fontSize: 10,
                                    fontWeight: 800,
                                    letterSpacing: 0.3,
                                    color: '#c45c26',
                                }}
                            >
                                {ca.badge}
                            </span>
                        ) : null}
                    </div>
                    <div
                        className={s.rowState}
                        style={{ color: stateTone(item.state) }}
                    >
                        {stateLabel(item.state)}
                        {event ? ` · ${eventLabel(event)}` : ''}
                    </div>
                </div>
            </div>
            <div className={s.rowMid}>
                <div>
                    <span className={s.rowCap}>強度</span>
                    <span className={s.rowC}>{Math.round(item.intraday_score)}</span>
                </div>
                <div>
                    <span className={s.rowCap}>熱度</span>
                    <span className={s.rowH}>{Math.round(item.heat_score)}</span>
                </div>
            </div>
            <div className={`${s.rowPct} ${pctTone(pct)}`}>
                <div>{fmtPctSigned(pct)}</div>
                {ca?.has_action_today &&
                rawPct != null &&
                pct != null &&
                Math.abs(rawPct - pct) > 0.05 ? (
                    <div
                        style={{
                            fontSize: 10,
                            fontWeight: 500,
                            opacity: 0.75,
                            marginTop: 2,
                        }}
                    >
                        Raw {fmtPctSigned(rawPct)}
                    </div>
                ) : null}
            </div>
        </button>
    );
}

export function TopStockCard({
    item,
    rank,
    onOpen,
}: {
    item: IntradayRankItemDto;
    rank: number;
    onOpen: (symbol: string) => void;
}) {
    return (
        <CompactStockRow item={item} rank={rank} onOpen={onOpen} />
    );
}

export function MiniHeatCard({
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
        >
            <div className={s.chipCode}>{item.symbol}</div>
            <div className={s.chipMeta}>
                強度{Math.round(item.intraday_score)} · 熱度
                {Math.round(item.heat_score)}
            </div>
            <div
                style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: stateTone(item.state),
                }}
            >
                {(() => {
                    const ev = primaryEvent(item);
                    return ev ? eventLabel(ev) : stateLabel(item.state);
                })()}
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
    const pb = (item.metrics?.pullback_state ?? 'pullback').toLowerCase();
    const pbZh =
        pb === 'reclaiming'
            ? '收復中'
            : pb === 'holding'
              ? '守穩'
              : pb === 'failed'
                ? '失敗'
                : '回踩';
    return (
        <button
            type="button"
            className={s.chipCard}
            onClick={() => onOpen(item.symbol)}
        >
            <div className={s.chipCode}>{item.symbol}</div>
            <div className={s.chipMeta}>
                強度{Math.round(item.intraday_score)} · 熱度
                {Math.round(item.heat_score)}
            </div>
            <div
                style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color:
                        pb === 'reclaiming'
                            ? '#fecaca'
                            : vars.color.mutedForeground,
                }}
            >
                {pbZh}
            </div>
        </button>
    );
}
