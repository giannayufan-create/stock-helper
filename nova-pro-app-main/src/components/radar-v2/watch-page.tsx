import { useState } from 'react';
import type {
    IntradayRankItemDto,
    OpenConfirmV2Item,
} from '../../lib/backend';
import { vars } from '../../theme.css';
import { fmtNum, fmtPctSigned, stateTone } from './helpers';
import * as s from './radar.css';
import { radarColor } from './tokens';
import type { RadarFeed } from './use-radar-feed';

export function WatchPage({
    feed,
    favorites,
    onOpenSymbol,
}: {
    feed: RadarFeed;
    favorites: string[];
    onOpenSymbol: (symbol: string) => void;
}) {
    const [tab, setTab] = useState<'pass' | 'fav'>('pass');

    const passes = (feed.openConfirm?.items ?? []).filter(
        (i) => i.open_confirm === 'pass' || i.open_confirm === 'early_pass',
    );

    const favItems = feed.items.filter((i) => favorites.includes(i.symbol));

    return (
        <>
            <div className={s.sectionTitle}>觀察</div>
            <div className={s.stickyTabs}>
                <button
                    type="button"
                    className={`${s.tabChip} ${tab === 'pass' ? s.tabChipOn : ''}`}
                    onClick={() => setTab('pass')}
                >
                    OPEN PASS
                </button>
                <button
                    type="button"
                    className={`${s.tabChip} ${tab === 'fav' ? s.tabChipOn : ''}`}
                    onClick={() => setTab('fav')}
                >
                    我的關注
                </button>
            </div>

            {tab === 'pass' ? (
                passes.length === 0 ? (
                    <div className={s.empty}>
                        目前沒有 OPEN PASS
                        <br />
                        開盤證明流程完成後會出現在這裡
                    </div>
                ) : (
                    passes.map((item) => (
                        <PassCard
                            key={item.symbol}
                            item={item}
                            onOpen={onOpenSymbol}
                        />
                    ))
                )
            ) : favItems.length === 0 ? (
                <div className={s.empty}>
                    點股票詳情的 ☆ 加入關注
                    <br />
                    盤中只看 C Score / Heat / Event
                </div>
            ) : (
                favItems.map((item) => (
                    <FavCard key={item.symbol} item={item} onOpen={onOpenSymbol} />
                ))
            )}
        </>
    );
}

function PassCard({
    item,
    onOpen,
}: {
    item: OpenConfirmV2Item;
    onOpen: (symbol: string) => void;
}) {
    const confirmed = item.generated_at
        ? new Date(item.generated_at).toLocaleTimeString('zh-TW', {
              hour: '2-digit',
              minute: '2-digit',
              hour12: false,
              timeZone: 'Asia/Taipei',
          })
        : '—';
    return (
        <button
            type="button"
            className={s.stockCard}
            onClick={() => onOpen(item.symbol)}
        >
            <div className={s.cardTop}>
                <div className={s.symBlock}>
                    <span className={s.symCode}>{item.symbol}</span>
                    <span className={s.symName}>{item.name}</span>
                </div>
                <span
                    className={s.stateLine}
                    style={{ color: radarColor.strong, marginBottom: 0 }}
                >
                    {item.open_confirm.toUpperCase()}
                </span>
            </div>
            <div className={s.scoreRow}>
                <div>
                    <span className={s.scoreCap}>OPEN SCORE</span>
                    <span className={s.scoreBig}>
                        {Math.round(item.final_open_score)}
                    </span>
                </div>
            </div>
            <div className={s.metricGrid}>
                <div>
                    <span className={s.metricLab}>RVOL</span>
                    {item.metrics.rvol_same_time != null
                        ? `${fmtNum(item.metrics.rvol_same_time)}x`
                        : '—'}
                </div>
                <div>
                    <span className={s.metricLab}>VWAP</span>
                    {fmtPctSigned(item.metrics.vwap_pos_pct)}
                </div>
                <div>
                    <span className={s.metricLab}>Confirmed</span>
                    {confirmed}
                </div>
            </div>
            {item.open_gate_passed_before_cutoff && (
                <div
                    style={{
                        marginTop: 8,
                        fontSize: 12,
                        color: vars.color.mutedForeground,
                    }}
                >
                    Opening Gate Passed
                </div>
            )}
        </button>
    );
}

function FavCard({
    item,
    onOpen,
}: {
    item: IntradayRankItemDto;
    onOpen: (symbol: string) => void;
}) {
    return (
        <button
            type="button"
            className={s.stockCard}
            onClick={() => onOpen(item.symbol)}
        >
            <div className={s.cardTop}>
                <div className={s.symBlock}>
                    <span className={s.symCode}>{item.symbol}</span>
                    <span className={s.symName}>{item.name}</span>
                </div>
            </div>
            <div className={s.scoreRow}>
                <div>
                    <span className={s.scoreCap}>C</span>
                    <span className={s.scoreBig}>
                        {Math.round(item.intraday_score)}
                    </span>
                </div>
                <div>
                    <span className={s.scoreCap}>HEAT</span>
                    <span className={s.heatBig}>
                        {Math.round(item.heat_score)}
                    </span>
                </div>
            </div>
            <div className={s.stateLine} style={{ color: stateTone(item.state) }}>
                {item.state}
                {item.events?.[0] ? ` · ${item.events[0]}` : ''}
            </div>
        </button>
    );
}
