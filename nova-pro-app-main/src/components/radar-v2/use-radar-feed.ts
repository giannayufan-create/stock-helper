import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    fetchHealth,
    fetchIntradayEvents,
    fetchIntradayRank,
    fetchOpenConfirmLatest,
    fetchSnapshots,
    type IntradayRankItemDto,
    type OpenConfirmV2Result,
} from '../../lib/backend';
import {
    fetchBuyPressure,
    type BuyPressureItemDto,
} from '../../lib/buy-pressure';
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

export function useRadarFeed(pollMs = 5000): RadarFeed {
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
    const [liveStatus, setLiveStatus] = useState<LiveStatus>('LIVE');
    const [healthNote, setHealthNote] = useState<string | null>(null);
    const [bpBySymbol, setBpBySymbol] = useState<
        Record<string, BuyPressureItemDto>
    >({});
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

    const refresh = useCallback(() => setTick((n) => n + 1), []);

    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            try {
                const settled = await Promise.allSettled([
                    fetchIntradayRank({ limit: 40, includeWatch: true }),
                    fetchIntradayEvents(40),
                    fetchHealth(),
                    fetchSnapshots([TSE, OTC]),
                    fetchBuyPressure({ limit: 80 }),
                    fetchMiOverview(),
                    fetchDecisionSummary({ limit: 80 }),
                    fetchMarketContextOverview(),
                    fetchRadarQuality({ limit: 80 }),
                ]);
                if (cancelled) return;

                const rank =
                    settled[0].status === 'fulfilled' ? settled[0].value : null;
                const ev =
                    settled[1].status === 'fulfilled' ? settled[1].value : null;
                const health =
                    settled[2].status === 'fulfilled' ? settled[2].value : null;
                const snaps =
                    settled[3].status === 'fulfilled'
                        ? settled[3].value
                        : ([] as Awaited<ReturnType<typeof fetchSnapshots>>);
                const bp =
                    settled[4].status === 'fulfilled' ? settled[4].value : null;
                const mi =
                    settled[5].status === 'fulfilled' ? settled[5].value : null;
                const ds =
                    settled[6].status === 'fulfilled' ? settled[6].value : null;
                const mc =
                    settled[7].status === 'fulfilled' ? settled[7].value : null;
                const rq =
                    settled[8].status === 'fulfilled' ? settled[8].value : null;

                if (!rank) {
                    setLiveStatus('DISCONNECTED');
                    setHealthNote('無法連線資料服務');
                    setLoading(false);
                    return;
                }

                const list = rank.items ?? [];
                setItems(list);
                setStrong(rank.strong ?? list.filter((i) => i.state === 'STRONG').length);
                setHeating(
                    rank.heating ?? list.filter((i) => i.state === 'HEATING').length,
                );
                setEmerging(
                    rank.emerging ??
                        list.filter((i) => i.state === 'EMERGING').length,
                );
                setAsOf(rank.as_of ?? null);
                setEvents(
                    (ev?.items ?? []).map((e) => ({
                        ...e,
                        name: undefined,
                    })),
                );

                const bpMap: Record<string, BuyPressureItemDto> = {};
                for (const row of bp?.items ?? []) {
                    bpMap[row.symbol] = row;
                }
                setBpBySymbol(bpMap);

                const secMap: Record<string, SectorHint> = {};
                for (const sec of mi?.top_sectors ?? []) {
                    for (const lead of sec.leaders ?? []) {
                        secMap[lead.symbol] = {
                            name: sec.sector,
                            rank: sec.rank ?? null,
                            heat: sec.heat_score,
                        };
                    }
                }
                setSectorBySymbol(secMap);

                const dsMap: Record<string, DecisionSummaryDto> = {};
                for (const row of ds?.items ?? []) {
                    dsMap[row.symbol] = row;
                }
                setDsBySymbol(dsMap);

                const rqMap: Record<string, RadarQualityItemDto> = {};
                for (const row of rq?.items ?? []) {
                    rqMap[row.symbol] = row;
                }
                setRqBySymbol(rqMap);
                setFocusTop3(rq?.focus_top3 ?? []);
                setRqCounts(rq?.counts ?? null);

                setTaiwanRegime(mc?.taiwan_regime?.state ?? null);

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
                // Shioaji drops IND snapshots — prefer market-context Yahoo %.
                setTaiexPct(
                    snapTaiex ??
                        mc?.taiwan_regime?.taiex_change_pct ??
                        null,
                );
                setTpexPct(
                    snapTpex ??
                        mc?.taiwan_regime?.tpex_change_pct ??
                        null,
                );

                const blocked = list.filter((i) => i.data_blocked).length;
                const stale = list.filter(
                    (i) =>
                        i.data_health === 'stale' ||
                        i.data_health === 'disconnected',
                ).length;
                if (health && health.status !== 'ok' && health.status !== 'healthy') {
                    setLiveStatus('DATA STALE');
                    setHealthNote('伺服器狀態異常，部分即時判斷可能暫停');
                } else if (stale > Math.max(3, list.length * 0.3)) {
                    setLiveStatus('DATA STALE');
                    setHealthNote('行情資料異常 — 部分即時判斷已暫停');
                } else if (blocked > 0) {
                    setLiveStatus('LIVE');
                    setHealthNote(`${blocked} 檔資料受阻，相關訊號已降級`);
                } else if (rank.warnings?.length) {
                    setLiveStatus('LIVE');
                    const w = rank.warnings[0] ?? null;
                    setHealthNote(
                        w === 'historical profile not ready'
                            ? '歷史盤中基準尚未就緒'
                            : w?.includes('historical')
                              ? '歷史盤中基準尚未就緒'
                              : w,
                    );
                } else {
                    setLiveStatus('LIVE');
                    setHealthNote(null);
                }

                try {
                    const oc = await fetchOpenConfirmLatest();
                    if (!cancelled) setOpenConfirm(oc);
                } catch {
                    /* optional */
                }

                setLoading(false);
            } catch {
                if (!cancelled) {
                    setLiveStatus('DISCONNECTED');
                    setHealthNote('無法連線資料服務');
                    setLoading(false);
                }
            }
        };
        void load();
        const t = setInterval(() => void load(), pollMs);
        return () => {
            cancelled = true;
            clearInterval(t);
        };
    }, [pollMs, tick]);

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
