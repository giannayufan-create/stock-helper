// src/components/radar-v2/intel-page.tsx — Market Intelligence full page

import { useEffect, useState } from 'react';
import { vars } from '../../theme.css';
import {
    deltaLabel,
    fetchMiGlobal,
    fetchMiNews,
    fetchMiOverview,
    fetchMiSectors,
    fetchMiThemes,
    type MiOverview,
} from '../../lib/market-intelligence';
import * as s from './radar.css';
import { radarColor } from './tokens';

type IntelTab = 'market' | 'sector' | 'theme' | 'news';

export function IntelPage({ onBack }: { onBack?: () => void }) {
    const [tab, setTab] = useState<IntelTab>('market');
    const [overview, setOverview] = useState<MiOverview | null>(null);
    const [sectors, setSectors] = useState<MiOverview['top_sectors']>([]);
    const [themes, setThemes] = useState<MiOverview['top_themes']>([]);
    const [news, setNews] = useState<NonNullable<MiOverview['top_news']>>([]);
    const [global, setGlobal] = useState<MiOverview['global_markets']>([]);
    const [err, setErr] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const ov = await fetchMiOverview();
                if (cancelled) return;
                setOverview(ov);
                setGlobal(ov.global_markets ?? []);
                setSectors(ov.top_sectors ?? []);
                setThemes(ov.top_themes ?? []);
                setNews(ov.top_news ?? []);
            } catch (e) {
                if (!cancelled) {
                    setErr(e instanceof Error ? e.message : String(e));
                }
            }
        })();
        const t = setInterval(() => {
            void fetchMiOverview()
                .then((ov) => {
                    setOverview(ov);
                    setGlobal(ov.global_markets ?? []);
                    setSectors(ov.top_sectors ?? []);
                    setThemes(ov.top_themes ?? []);
                    setNews(ov.top_news ?? []);
                })
                .catch(() => undefined);
        }, 30_000);
        return () => {
            cancelled = true;
            clearInterval(t);
        };
    }, []);

    useEffect(() => {
        if (tab === 'sector') {
            void fetchMiSectors()
                .then((r) => setSectors(r.items ?? []))
                .catch(() => undefined);
        } else if (tab === 'theme') {
            void fetchMiThemes()
                .then((r) => setThemes(r.items ?? []))
                .catch(() => undefined);
        } else if (tab === 'news') {
            void fetchMiNews()
                .then((r) => setNews(r.items ?? []))
                .catch(() => undefined);
        } else if (tab === 'market') {
            void fetchMiGlobal()
                .then((r) => setGlobal(r.assets ?? []))
                .catch(() => undefined);
        }
    }, [tab]);

    const ctx = overview?.market_context;
    const ai = overview?.ai_summary;

    return (
        <>
            <div className={s.sectionRow}>
                <div className={s.sectionTitle} style={{ marginBottom: 0 }}>
                    市場情報
                </div>
                {onBack && (
                    <button type="button" className={s.linkBtn} onClick={onBack}>
                        返回
                    </button>
                )}
            </div>

            {err && (
                <div className={s.glass} style={{ padding: 14, marginBottom: 12 }}>
                    <span style={{ color: radarColor.healthWarn }}>{err}</span>
                </div>
            )}

            <div className={s.quickBar} style={{ marginBottom: 12 }}>
                {(
                    [
                        ['market', '市場'],
                        ['sector', '產業'],
                        ['theme', '題材'],
                        ['news', '新聞'],
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

            {tab === 'market' && (
                <>
                    <div className={s.glass} style={{ padding: 16, marginBottom: 12 }}>
                        <div style={{ fontWeight: 700, marginBottom: 8 }}>市場環境</div>
                        <div style={{ fontSize: 20, fontWeight: 800, color: radarColor.heating }}>
                            {ctx?.risk_environment ?? '—'}
                        </div>
                        <div
                            style={{
                                fontSize: 13,
                                color: vars.color.mutedForeground,
                                marginTop: 6,
                                lineHeight: 1.45,
                            }}
                        >
                            科技 {ctx?.tech_context ?? '—'} · 半導體{' '}
                            {ctx?.semiconductor_context ?? '—'} · 亞洲{' '}
                            {ctx?.asia_context ?? '—'}
                        </div>
                        <p style={{ fontSize: 13, marginTop: 10, lineHeight: 1.45 }}>
                            {ctx?.summary}
                        </p>
                        {ai?.available && ai.market_summary ? (
                            <p
                                style={{
                                    fontSize: 13,
                                    marginTop: 10,
                                    color: radarColor.aiSoft,
                                    lineHeight: 1.45,
                                }}
                            >
                                AI：{ai.market_summary}
                            </p>
                        ) : (
                            <p
                                style={{
                                    fontSize: 12,
                                    marginTop: 8,
                                    color: vars.color.mutedForeground,
                                }}
                            >
                                AI 摘要暫時不可用
                                {ai?.error ? `（${ai.error.slice(0, 60)}）` : ''}
                            </p>
                        )}
                    </div>

                    <div className={s.sectionTitle}>全球資產</div>
                    <div style={{ display: 'grid', gap: 8, marginBottom: 16 }}>
                        {(global ?? [])
                            .filter((a) => a.status === 'HEALTHY')
                            .map((a) => (
                                <div key={a.id} className={s.glass} style={{ padding: 12 }}>
                                    <div
                                        style={{
                                            display: 'flex',
                                            justifyContent: 'space-between',
                                        }}
                                    >
                                        <strong>{a.name}</strong>
                                        <span
                                            style={{
                                                fontFamily: vars.font.mono,
                                                color:
                                                    (a.change_pct ?? 0) >= 0
                                                        ? radarColor.strong
                                                        : radarColor.health,
                                            }}
                                        >
                                            {a.change_pct == null
                                                ? '—'
                                                : `${a.change_pct >= 0 ? '+' : ''}${a.change_pct.toFixed(2)}%`}
                                        </span>
                                    </div>
                                </div>
                            ))}
                        {(global ?? []).filter((a) => a.status !== 'HEALTHY').length >
                            0 && (
                            <div
                                style={{
                                    fontSize: 12,
                                    color: vars.color.mutedForeground,
                                }}
                            >
                                部分資產暫不可用（未以 0 填補）
                            </div>
                        )}
                    </div>
                </>
            )}

            {tab === 'sector' && (
                <HeatList
                    title="熱門產業"
                    rows={(sectors ?? [])
                        .filter((x) => x.eligible_for_ranking !== false)
                        .slice(0, 20)
                        .map((x) => ({
                            name: x.sector,
                            heat: x.heat_score,
                            delta: x.heat_delta_5m,
                            meta: `STRONG ${x.strong_count ?? 0} · HEATING ${x.heating_count ?? 0}`,
                        }))}
                />
            )}

            {tab === 'theme' && (
                <HeatList
                    title="熱門題材"
                    rows={(themes ?? [])
                        .filter((x) => x.eligible_for_ranking !== false)
                        .slice(0, 20)
                        .map((x) => ({
                            name: x.theme,
                            heat: x.heat_score,
                            delta: x.heat_delta_5m,
                            meta: x.confidence,
                        }))}
                />
            )}

            {tab === 'news' && (
                <>
                    <div className={s.sectionTitle}>聚合新聞</div>
                    <div style={{ display: 'grid', gap: 8 }}>
                        {(news ?? []).slice(0, 30).map((n) => (
                            <div key={n.id} className={s.glass} style={{ padding: 12 }}>
                                <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.4 }}>
                                    {n.title}
                                </div>
                                <div
                                    style={{
                                        fontSize: 12,
                                        color: vars.color.mutedForeground,
                                        marginTop: 4,
                                    }}
                                >
                                    {n.source} · {n.sentiment}
                                </div>
                            </div>
                        ))}
                        {!news?.length && (
                            <div style={{ color: vars.color.mutedForeground, fontSize: 13 }}>
                                新聞層暫不可用或尚在背景更新
                            </div>
                        )}
                    </div>
                </>
            )}

            {overview?.data_health && (
                <div
                    style={{
                        marginTop: 16,
                        fontSize: 11,
                        color: vars.color.mutedForeground,
                    }}
                >
                    健康：{overview.data_health.overall} · 全球{' '}
                    {overview.data_health.global_market?.status} · 產業{' '}
                    {overview.data_health.sector?.status} · 題材{' '}
                    {overview.data_health.theme?.status} · 新聞{' '}
                    {overview.data_health.news?.status}
                </div>
            )}
        </>
    );
}

function HeatList({
    title,
    rows,
}: {
    title: string;
    rows: Array<{
        name: string;
        heat: number | null | undefined;
        delta: number | null | undefined;
        meta?: string;
    }>;
}) {
    return (
        <>
            <div className={s.sectionTitle}>{title}</div>
            <div style={{ display: 'grid', gap: 8 }}>
                {rows.map((r, i) => (
                    <div key={r.name} className={s.glass} style={{ padding: 14 }}>
                        <div
                            style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'baseline',
                            }}
                        >
                            <div>
                                <span
                                    style={{
                                        fontFamily: vars.font.mono,
                                        color: vars.color.mutedForeground,
                                        marginRight: 8,
                                    }}
                                >
                                    #{i + 1}
                                </span>
                                <strong style={{ fontSize: 16 }}>{r.name}</strong>
                            </div>
                            <div style={{ textAlign: 'right' }}>
                                <div
                                    style={{
                                        fontFamily: vars.font.mono,
                                        fontSize: 22,
                                        fontWeight: 800,
                                        color: radarColor.strong,
                                    }}
                                >
                                    {r.heat != null ? Math.round(r.heat) : '—'}
                                </div>
                                <div style={{ fontSize: 12, color: radarColor.heating }}>
                                    {deltaLabel(r.delta)} / 5m
                                </div>
                            </div>
                        </div>
                        {r.meta && (
                            <div
                                style={{
                                    fontSize: 12,
                                    color: vars.color.mutedForeground,
                                    marginTop: 6,
                                }}
                            >
                                {r.meta}
                            </div>
                        )}
                    </div>
                ))}
                {!rows.length && (
                    <div style={{ color: vars.color.mutedForeground, fontSize: 13 }}>
                        尚無足夠覆蓋的排行（需盤中 C 批次）
                    </div>
                )}
            </div>
        </>
    );
}
