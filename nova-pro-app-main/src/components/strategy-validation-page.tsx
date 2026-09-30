// src/components/strategy-validation-page.tsx
// Fixed OPEN_PASS (bc-strategy-v1) validation panel — research only.

import { useEffect, useState } from 'react';
import { vars } from '../theme.css';
import {
    fetchStrategyValidationSummary,
    moneyLabel,
    pctRateLabel,
    type StrategyValidationSummaryDto,
} from '../lib/strategy-validation';
import * as s from './radar-v2/radar.css';
import { radarColor } from './radar-v2/tokens';

function Stat({
    label,
    value,
}: {
    label: string;
    value: string;
}) {
    return (
        <div className={s.glass} style={{ padding: 12, flex: 1, minWidth: 110 }}>
            <div
                style={{
                    fontSize: 11,
                    color: vars.color.mutedForeground,
                }}
            >
                {label}
            </div>
            <div
                style={{
                    marginTop: 4,
                    fontSize: 16,
                    fontWeight: 700,
                    fontFamily: vars.font.mono,
                }}
            >
                {value}
            </div>
        </div>
    );
}

export function StrategyValidationPage() {
    const [data, setData] = useState<StrategyValidationSummaryDto | null>(
        null,
    );
    const [err, setErr] = useState<string | null>(null);
    const [demo, setDemo] = useState(false);
    const [busy, setBusy] = useState(false);

    const load = (useDemo: boolean) => {
        setBusy(true);
        setErr(null);
        void fetchStrategyValidationSummary({ demo: useDemo })
            .then((d) => {
                setData(d);
                setDemo(useDemo);
            })
            .catch(() => {
                setData(null);
                setErr('無法載入策略驗證摘要');
            })
            .finally(() => setBusy(false));
    };

    useEffect(() => {
        load(false);
    }, []);

    const isSynthetic =
        demo ||
        data?.source_mode === 'synthetic' ||
        (data?.data_source ?? '').includes('synthetic');

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className={s.sectionTitle}>策略驗證（單一版本）</div>
            <div
                style={{
                    fontSize: 12,
                    color: vars.color.mutedForeground,
                    lineHeight: 1.5,
                }}
            >
                固定驗證{' '}
                <strong style={{ color: vars.color.foreground }}>
                    OPEN_PASS / bc-strategy-v1
                </strong>
                。不連實盤帳戶、不下單；模擬損益僅在標註「非原策略假設」時顯示。
                不代表已驗證優勢。
            </div>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                    type="button"
                    className={s.quickBtn}
                    disabled={busy}
                    onClick={() => load(false)}
                >
                    重新載入
                </button>
                <button
                    type="button"
                    className={s.quickBtn}
                    disabled={busy}
                    onClick={() => load(true)}
                >
                    載入合成示範
                </button>
            </div>

            {isSynthetic && (
                <div
                    className={`${s.banner}`}
                    style={{
                        borderColor: radarColor.heating,
                        color: radarColor.heating,
                    }}
                >
                    【測試／合成資料】不可當作實盤績效或 proven edge
                </div>
            )}

            {err && (
                <div className={`${s.banner} ${s.bannerBad}`}>{err}</div>
            )}

            {!err && data?.empty && (
                <div className={s.glass} style={{ padding: 20, textAlign: 'center' }}>
                    <div style={{ fontWeight: 700, fontSize: 15 }}>
                        尚無驗證結果
                    </div>
                    <div
                        style={{
                            marginTop: 8,
                            fontSize: 12,
                            color: vars.color.mutedForeground,
                        }}
                    >
                        待盤中產生 OPEN_PASS 並寫入 raw_strategy_signals 後會出現在此。
                        可先載入合成示範檢查 UI。
                    </div>
                </div>
            )}

            {data && !data.empty && (
                <>
                    <div
                        className={s.glass}
                        style={{
                            padding: 12,
                            fontSize: 12,
                            lineHeight: 1.7,
                            fontFamily: vars.font.mono,
                            color: vars.color.mutedForeground,
                        }}
                    >
                        策略 {data.strategy_name} · {data.strategy_version}
                        <br />
                        驗證日 {data.validation_date} · 來源 {data.data_source}{' '}
                        · mode {data.source_mode}
                        <br />
                        {data.assumptions && (
                            <>
                                假設：delay {data.assumptions.fill_delay_ms}ms ·
                                slip buy{' '}
                                {(data.assumptions.buy_slippage_pct * 100).toFixed(
                                    2,
                                )}
                                % / sell{' '}
                                {(
                                    data.assumptions.sell_slippage_pct * 100
                                ).toFixed(2)}
                                % · TP{' '}
                                {data.assumptions.provisional_take_profit_pct !=
                                null
                                    ? `${(data.assumptions.provisional_take_profit_pct * 100).toFixed(1)}%`
                                    : '—'}{' '}
                                · hold{' '}
                                {data.assumptions.provisional_max_hold_minutes ??
                                    '—'}
                                m
                                <br />
                                <span style={{ color: radarColor.heating }}>
                                    assumptions_not_original_strategy=
                                    {String(
                                        data.assumptions
                                            .assumptions_not_original_strategy,
                                    )}
                                </span>
                            </>
                        )}
                    </div>

                    <div
                        style={{
                            display: 'flex',
                            flexWrap: 'wrap',
                            gap: 8,
                        }}
                    >
                        <Stat
                            label="訊號數"
                            value={String(data.counts.signals)}
                        />
                        <Stat
                            label="可評估"
                            value={String(data.counts.evaluable)}
                        />
                        <Stat
                            label="模擬成交"
                            value={String(data.counts.simulated_fills)}
                        />
                        <Stat
                            label="未成交"
                            value={String(data.counts.unfilled)}
                        />
                        <Stat
                            label="資料不足"
                            value={String(data.counts.insufficient_data)}
                        />
                    </div>

                    {data.sim_stats.assumptions_not_original_strategy &&
                        data.sim_stats.available && (
                            <div
                                className={s.glass}
                                style={{ padding: 12 }}
                            >
                                <div style={{ fontWeight: 700, fontSize: 13 }}>
                                    模擬損益（含成本・非原策略假設）
                                </div>
                                <div
                                    style={{
                                        marginTop: 8,
                                        display: 'flex',
                                        flexWrap: 'wrap',
                                        gap: 8,
                                    }}
                                >
                                    <Stat
                                        label="平均淨損益"
                                        value={moneyLabel(
                                            data.sim_stats.avg_net_pnl,
                                        )}
                                    />
                                    <Stat
                                        label="勝率"
                                        value={pctRateLabel(
                                            data.sim_stats.win_rate,
                                        )}
                                    />
                                    <Stat
                                        label="平均獲利"
                                        value={moneyLabel(
                                            data.sim_stats.avg_win,
                                        )}
                                    />
                                    <Stat
                                        label="平均虧損"
                                        value={moneyLabel(
                                            data.sim_stats.avg_loss,
                                        )}
                                    />
                                    <Stat
                                        label="累計淨損益"
                                        value={moneyLabel(
                                            data.sim_stats.cumulative_net_pnl,
                                        )}
                                    />
                                </div>
                            </div>
                        )}

                    <div className={s.glass} style={{ padding: 12 }}>
                        <div style={{ fontWeight: 700, fontSize: 13 }}>
                            最大回撤
                        </div>
                        <div
                            style={{
                                marginTop: 6,
                                fontSize: 12,
                                color: vars.color.mutedForeground,
                            }}
                        >
                            {data.sim_stats.max_drawdown != null
                                ? moneyLabel(data.sim_stats.max_drawdown)
                                : data.sim_stats.max_drawdown_note}
                        </div>
                    </div>

                    {data.benchmark && (
                        <div className={s.glass} style={{ padding: 12 }}>
                            <div style={{ fontWeight: 700, fontSize: 13 }}>
                                基準比較（同成本／持有假設）
                            </div>
                            <div
                                style={{
                                    marginTop: 6,
                                    fontSize: 12,
                                    fontFamily: vars.font.mono,
                                    color: vars.color.mutedForeground,
                                    lineHeight: 1.6,
                                }}
                            >
                                {data.benchmark.label}
                                <br />
                                平均淨損益{' '}
                                {moneyLabel(data.benchmark.avg_net_pnl)} ·
                                累計{' '}
                                {moneyLabel(data.benchmark.cumulative_net_pnl)}
                                <br />
                                {data.benchmark.note}
                            </div>
                        </div>
                    )}

                    <div className={s.glass} style={{ padding: 12 }}>
                        <div style={{ fontWeight: 700, fontSize: 13 }}>
                            逐筆（signal_id）
                        </div>
                        {data.trades.length === 0 ? (
                            <div
                                style={{
                                    marginTop: 8,
                                    fontSize: 12,
                                    color: vars.color.mutedForeground,
                                }}
                            >
                                尚無驗證結果
                            </div>
                        ) : (
                            <div
                                style={{
                                    marginTop: 8,
                                    display: 'flex',
                                    flexDirection: 'column',
                                    gap: 6,
                                }}
                            >
                                {data.trades.map((t) => (
                                    <div
                                        key={t.signal_id}
                                        style={{
                                            fontSize: 12,
                                            fontFamily: vars.font.mono,
                                            padding: '8px 0',
                                            borderTop: `1px solid ${radarColor.glassBorder}`,
                                            lineHeight: 1.5,
                                        }}
                                    >
                                        <a
                                            href={`#signal-${t.signal_id}`}
                                            style={{
                                                color: radarColor.live,
                                                textDecoration: 'none',
                                            }}
                                        >
                                            {t.signal_id}
                                        </a>{' '}
                                        · {t.symbol}
                                        <br />
                                        path15m{' '}
                                        {t.path.forward_return_15m != null
                                            ? `${(t.path.forward_return_15m * 100).toFixed(2)}%`
                                            : '—'}
                                        {t.simulated && (
                                            <>
                                                {' '}
                                                · sim{' '}
                                                {t.simulated.filled
                                                    ? moneyLabel(
                                                          t.simulated.net_pnl ??
                                                              null,
                                                      )
                                                    : t.simulated.skip_reason ??
                                                      'unfilled'}
                                            </>
                                        )}
                                        {' · '}
                                        real fill —
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    {data.exit_decisions_needed.length > 0 && (
                        <div
                            className={s.glass}
                            style={{ padding: 12, fontSize: 11 }}
                        >
                            <div style={{ fontWeight: 700 }}>
                                尚待決策的出場規則
                            </div>
                            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                                {data.exit_decisions_needed.map((d) => (
                                    <li key={d}>{d}</li>
                                ))}
                            </ul>
                        </div>
                    )}

                    <div
                        style={{
                            fontSize: 11,
                            color: vars.color.mutedForeground,
                            lineHeight: 1.5,
                        }}
                    >
                        {data.disclaimer}
                    </div>
                </>
            )}
        </div>
    );
}
