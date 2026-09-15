import { useState } from 'react';
import type {
    IntradayRankItemDto,
    OpenConfirmV2Item,
} from '../../lib/backend';
import { vars } from '../../theme.css';
import {
    chaseLabel,
    fmtNum,
    fmtPctSigned,
    openConfirmLabel,
    stateLabel,
    stateTone,
} from './helpers';
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
                    開盤通過
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
                        目前沒有開盤通過標的
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
                    盤中只看強度／熱度／事件
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
                    {openConfirmLabel(item.open_confirm)}
                </span>
            </div>
            <div className={s.scoreRow}>
                <div>
                    <span className={s.scoreCap}>開盤分</span>
                    <span className={s.scoreBig}>
                        {Math.round(item.final_open_score)}
                    </span>
                </div>
            </div>
            <div className={s.metricGrid}>
                <div>
                    <span className={s.metricLab}>相對量能</span>
                    {item.metrics.rvol_same_time != null
                        ? `${fmtNum(item.metrics.rvol_same_time)}x`
                        : '—'}
                </div>
                <div>
                    <span className={s.metricLab}>均價偏離</span>
                    {fmtPctSigned(item.metrics.vwap_pos_pct)}
                </div>
                <div>
                    <span className={s.metricLab}>確認時間</span>
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
                    已於截止前通過開盤閘門
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
                <span
                    className={s.stateLine}
                    style={{ color: stateTone(item.state), marginBottom: 0 }}
                >
                    {stateLabel(item.state)}
                </span>
            </div>
            <div className={s.scoreRow}>
                <div>
                    <span className={s.scoreCap}>強度</span>
                    <span className={s.scoreBig}>
                        {Math.round(item.intraday_score)}
                    </span>
                </div>
                <div>
                    <span className={s.scoreCap}>熱度</span>
                    <span className={s.heatBig}>
                        {Math.round(item.heat_score)}
                    </span>
                </div>
            </div>
            <div
                style={{
                    fontSize: 12,
                    color: vars.color.mutedForeground,
                    marginTop: 6,
                }}
            >
                追高風險 {chaseLabel(item.risk?.chase_risk)}
            </div>
        </button>
    );
}
