// src/components/radar-v2/broker-radar-page.tsx — 籌碼／主力雷達（context only）

import { useEffect, useState } from 'react';
import {
    fetchBrokerHealth,
    fetchBrokerRanking,
    type BrokerRankingRes,
} from '../../lib/broker-intelligence';
import { vars } from '../../theme.css';
import * as s from './radar.css';
import { radarColor } from './tokens';

type BiTab = 'concentration' | 'persistent' | 'today' | 'alignment';

export function BrokerRadarPage({
    onBack,
    onOpenSymbol,
}: {
    onBack?: () => void;
    onOpenSymbol: (symbol: string) => void;
}) {
    const [tab, setTab] = useState<BiTab>('concentration');
    const [healthNote, setHealthNote] = useState<string | null>(null);
    const [data, setData] = useState<BrokerRankingRes | null>(null);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        void fetchBrokerHealth()
            .then((h) => {
                if (h.status === 'UNAVAILABLE') {
                    setHealthNote(
                        '目前尚未接入券商分點資料來源。法人籌碼（三大法人 T+1）仍可於個股詳情查看，但無法顯示分點買超／主力集中。',
                    );
                }
            })
            .catch(() =>
                setHealthNote('籌碼雷達服務暫不可用'),
            );
    }, []);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        const kind =
            tab === 'concentration'
                ? 'concentration'
                : tab === 'persistent'
                  ? 'persistent-buy'
                  : tab === 'alignment'
                    ? 'alignment'
                    : 'concentration';
        void fetchBrokerRanking(kind)
            .then((r) => {
                if (!cancelled) setData(r);
            })
            .catch(() => {
                if (!cancelled) {
                    setData({
                        available: false,
                        items: [],
                        note: '載入失敗',
                    });
                }
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [tab]);

    return (
        <>
            <div className={s.sectionRow}>
                <div className={s.sectionTitle} style={{ marginBottom: 0 }}>
                    籌碼雷達
                </div>
                {onBack && (
                    <button type="button" className={s.linkBtn} onClick={onBack}>
                        返回
                    </button>
                )}
            </div>

            <p
                style={{
                    fontSize: 12,
                    color: vars.color.mutedForeground,
                    lineHeight: 1.45,
                    marginBottom: 10,
                }}
            >
                券商分點與三大法人分開顯示。主力集中度為推估，不是真實身份；非買進／賣出建議。
            </p>

            {(healthNote || (data && !data.available)) && (
                <div className={s.glass} style={{ padding: 14, marginBottom: 12 }}>
                    <strong style={{ color: radarColor.healthWarn }}>
                        分點資料 UNAVAILABLE
                    </strong>
                    <p
                        style={{
                            fontSize: 13,
                            marginTop: 8,
                            lineHeight: 1.45,
                            color: vars.color.mutedForeground,
                        }}
                    >
                        {healthNote ?? data?.note}
                    </p>
                    <p style={{ fontSize: 12, marginTop: 8, lineHeight: 1.4 }}>
                        需要可提供：券商／分點名稱、買進／賣出張數、歷史日資料的
                        branch trading API（EOD 或 intraday）。請人工確認後再接入，勿假造。
                    </p>
                </div>
            )}

            <div className={s.quickBar} style={{ marginBottom: 12 }}>
                {(
                    [
                        ['concentration', '主力集中'],
                        ['persistent', '連續買進'],
                        ['today', '今日分點'],
                        ['alignment', '籌碼＋動能'],
                    ] as const
                ).map(([id, label]) => (
                    <button
                        key={id}
                        type="button"
                        className={`${s.quickBtn} ${tab === id ? s.dockBtnOn : ''}`}
                        onClick={() => setTab(id)}
                    >
                        {label}
                    </button>
                ))}
            </div>

            {tab === 'today' && (
                <div className={s.glass} style={{ padding: 14 }}>
                    <div style={{ fontWeight: 700, marginBottom: 6 }}>
                        最近交易日分點
                    </div>
                    <p
                        style={{
                            fontSize: 13,
                            color: vars.color.mutedForeground,
                            lineHeight: 1.45,
                        }}
                    >
                        目前無 branch provider，無法列出個股分點排行。請至個股詳情「籌碼情報」查看狀態；接入資料源後此頁會顯示「最近可用交易日分點」（非 LIVE，除非 provider 為 intraday）。
                    </p>
                </div>
            )}

            {tab !== 'today' && (
                <>
                    {loading && <div className={s.empty}>載入中…</div>}
                    {!loading && data?.available && !data.items.length && (
                        <div className={s.empty}>尚無符合條件的股票</div>
                    )}
                    {!loading &&
                        data?.items.map((row) => (
                            <button
                                key={row.symbol}
                                type="button"
                                className={s.stockCard}
                                onClick={() => onOpenSymbol(row.symbol)}
                                style={{ marginBottom: 8, textAlign: 'left' }}
                            >
                                <div
                                    style={{
                                        display: 'flex',
                                        justifyContent: 'space-between',
                                    }}
                                >
                                    <strong>
                                        {row.symbol}{' '}
                                        <span
                                            style={{
                                                fontWeight: 500,
                                                color: vars.color.mutedForeground,
                                            }}
                                        >
                                            {row.name}
                                        </span>
                                    </strong>
                                    <span
                                        style={{
                                            fontFamily: vars.font.mono,
                                            color: radarColor.strong,
                                        }}
                                    >
                                        {row.main_force_score != null
                                            ? Math.round(row.main_force_score)
                                            : '—'}
                                    </span>
                                </div>
                                <div
                                    style={{
                                        fontSize: 12,
                                        color: vars.color.mutedForeground,
                                        marginTop: 6,
                                    }}
                                >
                                    Top3{' '}
                                    {row.concentration_top3 != null
                                        ? `${row.concentration_top3}%`
                                        : '—'}
                                    {' · '}C{' '}
                                    {row.c_score != null
                                        ? Math.round(row.c_score)
                                        : '—'}
                                    {' · '}
                                    {row.state ?? '—'}
                                    {row.events?.[0]
                                        ? ` · ${row.events[0]}`
                                        : ''}
                                </div>
                                {tab === 'alignment' && (
                                    <div
                                        style={{
                                            fontSize: 12,
                                            marginTop: 4,
                                            color: radarColor.heating,
                                        }}
                                    >
                                        值得關注 · 籌碼與動能同向（非買進訊號）
                                    </div>
                                )}
                            </button>
                        ))}
                    {data?.note && data.available && (
                        <div
                            style={{
                                fontSize: 11,
                                color: vars.color.mutedForeground,
                                marginTop: 8,
                            }}
                        >
                            {data.note}
                        </div>
                    )}
                </>
            )}
        </>
    );
}
