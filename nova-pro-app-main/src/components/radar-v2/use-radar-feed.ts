import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    beginApiLoad,
    markApiDown,
    markApiReady,
    retryApiReady,
} from '../../lib/api-ready';
import {
    fetchIntradayEvents,
    fetchIntradayRank,
    fetchOpenConfirmLatest,
    fetchSnapshots,
    type IntradayRankItemDto,
    type OpenConfirmV2Result,
} from '../../lib/backend';
import { type BuyPressureItemDto } from '../../lib/buy-pressure';
import {
    fetchDecisionSummary,
    type DecisionSummaryDto,
} from '../../lib/decision-summary';
import { fetchMiOverview } from '../../lib/market-intelligence';
import { fetchMarketContextOverview } from '../../lib/market-context';
import {
    fetchRadarQuality,
    type FocusSlotDto,
    type RadarQualityBatchDto,
    type RadarQualityItemDto,
} from '../../lib/radar-quality';
import { isHostedApi } from '../../lib/runtime';
import type { LiveStatus } from './tokens';

export interface SectorHint {
    name: string;
    rank: number | null;
    heat: number | null;
    state?: string | null;
}

export interface RadarFeed {
    loading: boolean;
    items: IntradayRankItemDto[];
    events: Array<{
        event_type: string;
        symbol: string;
        name?: string;
        rank: number | null;
        timestamp: string;
        intraday_score?: number | null;
        heat_score?: number | null;
    }>;
    openConfirm: OpenConfirmV2Result | null;
    marketScore: number;
    marketRegime: string;
    taiwanRegime: string | null;
    strong: number;
    heating: number;
    emerging: number;
    passCount: number;
    taiexPct: number | null;
    tpexPct: number | null;
    liveStatus: LiveStatus;
    healthNote: string | null;
    asOf: string | null;
    bpBySymbol: Record<string, BuyPressureItemDto>;
    sectorBySymbol: Record<string, SectorHint>;
    dsBySymbol: Record<string, DecisionSummaryDto>;
    rqBySymbol: Record<string, RadarQualityItemDto>;
    focusTop3: FocusSlotDto[];
    rqCounts: RadarQualityBatchDto['counts'] | null;
    refresh: () => void;
}

const TSE = {
    security_type: 'IND' as const,
    exchange: 'TSE' as const,
    code: '001',
    target_code: null,
};
const OTC = {
    security_type: 'IND' as const,
    exchange: 'OTC' as const,
    code: '101',
    target_code: null,
};

export function useRadarFeed(
    pollMs = 5000,
    paused = false,
): RadarFeed {
    const [loading, setLoading] = useState(true);
    const [items, setItems] = useState<IntradayRankItemDto[]>([]);
    const [events, setEvents] = useState<RadarFeed['events']>([]);
    const [openConfirm, setOpenConfirm] = useState<OpenConfirmV2Result | null>(
        null,
    );
    const [strong, setStrong] = useState(0);
    const [heating, setHeating] = useState(0);
    const [emerging, setEmerging] = useState(0);
    const [asOf, setAsOf] = useState<string | null>(null);
    const [taiexPct, setTaiexPct] = useState<number | null>(null);
    const [tpexPct, setTpexPct] = useState<number | null>(null);
    const [liveStatus, setLiveStatus] = useState<LiveStatus>('WAKING');
    const [healthNote, setHealthNote] = useState<string | null>(null);
    const [bpBySymbol] = useState<Record<string, BuyPressureItemDto>>({});
    const [sectorBySymbol, setSectorBySymbol] = useState<
        Record<string, SectorHint>
    >({});
    const [dsBySymbol, setDsBySymbol] = useState<
        Record<string, DecisionSummaryDto>
    >({});
    const [rqBySymbol, setRqBySymbol] = useState<
        Record<string, RadarQualityItemDto>
    >({});
    const [focusTop3, setFocusTop3] = useState<FocusSlotDto[]>([]);
    const [rqCounts, setRqCounts] = useState<
        RadarQualityBatchDto['counts'] | null
    >(null);
    const [taiwanRegime, setTaiwanRegime] = useState<string | null>(null);
    const [tick, setTick] = useState(0);

    const refresh = useCallback(() => {
        void retryApiReady();
        setTick((n) => n + 1);
    }, []);

    useEffect(() => {
        let cancelled = false;
        let inflightLoad = false;
        let cycles = 0;
        let hasPainted = false;
        let failStreak = 0;
        const hosted = isHostedApi();

        const applyRank = (
            rank: Awaited<ReturnType<typeof fetchIntradayRank>>,
        ) => {
            const list = rank.items ?? [];
            setItems(list);
            setStrong(
                rank.strong ?? list.filter((i) => i.state === 'STRONG').length,
            );
            setHeating(
                rank.heating ?? list.filter((i) => i.state === 'HEATING').length,
            );
            setEmerging(
                rank.emerging ??
                    list.filter((i) => i.state === 'EMERGING').length,
            );
            setAsOf(rank.as_of ?? null);

            const blocked = list.filter((i) => i.data_blocked).length;
            const stale = list.filter(
                (i) =>
                    i.data_health === 'stale' ||
                    i.data_health === 'disconnected',
            ).length;
            setLiveStatus('LIVE');
            if (stale > Math.max(3, list.length * 0.3)) {
                setHealthNote('部分行情延遲，名單仍可用');
            } else if (blocked > 0) {
                setHealthNote(`${blocked} 檔資料受阻，相關訊號已降級`);
            } else if (rank.warnings?.length) {
                const w = rank.warnings[0] ?? null;
                setHealthNote(
                    w === 'historical profile not ready'
                        ? '歷史盤中基準尚未就緒'
                        : w?.includes('historical')
                          ? '歷史盤中基準尚未就緒'
                          : w,
                );
            } else {
                setHealthNote(null);
            }
        };

        const noteFail = () => {
            failStreak += 1;
            if (!hasPainted) {
                if (failStreak >= 4) {
                    markApiDown();
                    setLiveStatus('DISCONNECTED');
                    setHealthNote(
                        '後端還沒醒來，會自動再試。也可按重新連線。',
                    );
                } else {
                    setLiveStatus('WAKING');
                    setHealthNote('正在載入雷達…');
                }
                setLoading(false);
                return;
            }
            if (failStreak < 3) {
                setLiveStatus('DATA STALE');
                setHealthNote('這輪資料慢了一點，畫面先留上一筆，正在重試。');
                return;
            }
            markApiDown();
            setLiveStatus('DISCONNECTED');
            setHealthNote('連線不穩，會自動再試。也可按重新連線。');
        };

        const loadCore = async (timeoutMs: number) => {
            const rank = await fetchIntradayRank({
                limit: 40,
                includeWatch: true,
                timeoutMs,
            }).catch(() => null);
            if (cancelled) return false;
            if (!rank) {
                noteFail();
                return false;
            }
            failStreak = 0;
            markApiReady();
            applyRank(rank);
            hasPainted = true;
            setLoading(false);
            return true;
        };

        const loadContext = async (light: boolean) => {
            if (light) {
                const settled = await Promise.allSettled([
                    fetchSnapshots([TSE, OTC]),
                    fetchMarketContextOverview(),
                    fetchOpenConfirmLatest(),
                ]);
                if (cancelled) return;
                const snaps =
                    settled[0].status === 'fulfilled'
                        ? settled[0].value
                        : ([] as Awaited<ReturnType<typeof fetchSnapshots>>);
                const mc =
                    settled[1].status === 'fulfilled' ? settled[1].value : null;
                const oc =
                    settled[2].status === 'fulfilled' ? settled[2].value : null;
                if (oc) setOpenConfirm(oc);
                if (mc) setTaiwanRegime(mc.taiwan_regime?.state ?? null);
                const idx = snaps.find(
                    (s) => s.code === '001' || s.code === 'IX0001',
                );
                const otc = snaps.find(
                    (s) =>
                        s.code === '101' ||
                        s.code === '002' ||
                        s.code === 'IX0043',
                );
                const snapTaiex =
                    idx?.change_rate != null ? Number(idx.change_rate) : null;
                const snapTpex =
                    otc?.change_rate != null ? Number(otc.change_rate) : null;
                setTaiexPct(
                    snapTaiex ?? mc?.taiwan_regime?.taiex_change_pct ?? null,
                );
                setTpexPct(
                    snapTpex ?? mc?.taiwan_regime?.tpex_change_pct ?? null,
                );
                return;
            }

            const settled = await Promise.allSettled([
                fetchIntradayEvents(40),
                fetchSnapshots([TSE, OTC]),
                fetchMiOverview(),
                fetchDecisionSummary({ limit: 80 }),
                fetchMarketContextOverview(),
                fetchRadarQuality({ limit: 80 }),
                fetchOpenConfirmLatest(),
            ]);
            if (cancelled) return;

            const ev =
                settled[0].status === 'fulfilled' ? settled[0].value : null;
            const snaps =
                settled[1].status === 'fulfilled'
                    ? settled[1].value
                    : ([] as Awaited<ReturnType<typeof fetchSnapshots>>);
            const mi =
                settled[2].status === 'fulfilled' ? settled[2].value : null;
            const ds =
                settled[3].status === 'fulfilled' ? settled[3].value : null;
            const mc =
                settled[4].status === 'fulfilled' ? settled[4].value : null;
            const rq =
                settled[5].status === 'fulfilled' ? settled[5].value : null;
            const oc =
                settled[6].status === 'fulfilled' ? settled[6].value : null;

            if (ev) {
                setEvents(
                    (ev.items ?? []).map((e) => ({
                        ...e,
                        name: undefined,
                    })),
                );
            }
            if (mi) {
                const secMap: Record<string, SectorHint> = {};
                for (const sec of mi.top_sectors ?? []) {
                    for (const lead of sec.leaders ?? []) {
                        secMap[lead.symbol] = {
                            name: sec.sector,
                            rank: sec.rank ?? null,
                            heat: sec.heat_score,
                        };
                    }
                }
                setSectorBySymbol(secMap);
            }
            if (ds) {
                const dsMap: Record<string, DecisionSummaryDto> = {};
                for (const row of ds.items ?? []) dsMap[row.symbol] = row;
                setDsBySymbol(dsMap);
            }
            if (rq) {
                const rqMap: Record<string, RadarQualityItemDto> = {};
                for (const row of rq.items ?? []) rqMap[row.symbol] = row;
                setRqBySymbol(rqMap);
                setFocusTop3(rq.focus_top3 ?? []);
                setRqCounts(rq.counts ?? null);
            }
            if (mc) setTaiwanRegime(mc.taiwan_regime?.state ?? null);
            if (oc) setOpenConfirm(oc);

            const idx = snaps.find(
                (s) => s.code === '001' || s.code === 'IX0001',
            );
            const otc = snaps.find(
                (s) =>
                    s.code === '101' ||
                    s.code === '002' ||
                    s.code === 'IX0043',
            );
            const snapTaiex =
                idx?.change_rate != null ? Number(idx.change_rate) : null;
            const snapTpex =
                otc?.change_rate != null ? Number(otc.change_rate) : null;
            setTaiexPct(
                snapTaiex ?? mc?.taiwan_regime?.taiex_change_pct ?? null,
            );
            setTpexPct(
                snapTpex ?? mc?.taiwan_regime?.tpex_change_pct ?? null,
            );
        };

        const load = async () => {
            if (paused) return;
            if (inflightLoad) return;
            if (
                typeof document !== 'undefined' &&
                document.hidden &&
                hasPainted
            ) {
                return;
            }
            inflightLoad = true;
            try {
                if (!hasPainted) {
                    beginApiLoad();
                    setLiveStatus('WAKING');
                    setHealthNote('正在載入雷達…');
                    setLoading(true);
                }
                const ok = await loadCore(
                    hasPainted
                        ? hosted
                            ? 20_000
                            : 10_000
                        : hosted
                          ? 25_000
                          : 12_000,
                );
                if (cancelled || !ok) return;
                // Light context right after first paint; full context every 6 cycles
                if (cycles === 0) {
                    void loadContext(true);
                } else if (cycles % 6 === 0) {
                    void loadContext(false);
                }
                cycles += 1;
            } catch {
                if (!cancelled) noteFail();
            } finally {
                inflightLoad = false;
            }
        };
        const onVis = () => {
            if (!document.hidden) void load();
        };
        document.addEventListener('visibilitychange', onVis);
        if (!paused) {
            void load();
        } else {
            setLoading(false);
            setLiveStatus('LIVE');
            setHealthNote(null);
        }
        const t = setInterval(() => void load(), pollMs);
        return () => {
            cancelled = true;
            clearInterval(t);
            document.removeEventListener('visibilitychange', onVis);
        };
    }, [pollMs, tick, paused]);

    return useMemo(
        () => ({
            loading,
            items,
            events,
            openConfirm,
            marketScore: openConfirm?.market_score ?? 50,
            marketRegime: openConfirm?.market_regime ?? 'neutral',
            taiwanRegime,
            strong,
            heating,
            emerging,
            passCount: openConfirm?.pass ?? 0,
            taiexPct,
            tpexPct,
            liveStatus,
            healthNote,
            asOf,
            bpBySymbol,
            sectorBySymbol,
            dsBySymbol,
            rqBySymbol,
            focusTop3,
            rqCounts,
            refresh,
        }),
        [
            loading,
            items,
            events,
            openConfirm,
            taiwanRegime,
            strong,
            heating,
            emerging,
            taiexPct,
            tpexPct,
            liveStatus,
            healthNote,
            asOf,
            bpBySymbol,
            sectorBySymbol,
            dsBySymbol,
            rqBySymbol,
            focusTop3,
            rqCounts,
            refresh,
        ],
    );
}
