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
import type { LiveStatus } from './tokens';

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
    strong: number;
    heating: number;
    emerging: number;
    passCount: number;
    taiexPct: number | null;
    tpexPct: number | null;
    liveStatus: LiveStatus;
    healthNote: string | null;
    asOf: string | null;
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
    const [tick, setTick] = useState(0);

    const refresh = useCallback(() => setTick((n) => n + 1), []);

    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            try {
                const [rank, ev, health, snaps] = await Promise.all([
                    fetchIntradayRank({ limit: 40, includeWatch: true }),
                    fetchIntradayEvents(40),
                    fetchHealth().catch(() => null),
                    fetchSnapshots([TSE, OTC]).catch(() => [] as Awaited<
                        ReturnType<typeof fetchSnapshots>
                    >),
                ]);
                if (cancelled) return;

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
                    (ev.items ?? []).map((e) => ({
                        ...e,
                        name: undefined,
                    })),
                );

                const idx = snaps.find((s) => s.code === '001');
                const otc = snaps.find((s) => s.code === '101');
                setTaiexPct(
                    idx?.change_rate != null ? Number(idx.change_rate) : null,
                );
                setTpexPct(
                    otc?.change_rate != null ? Number(otc.change_rate) : null,
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
                    setHealthNote('⚠ 行情資料異常 — 部分即時判斷已暫停');
                } else if (blocked > 0) {
                    setLiveStatus('LIVE');
                    setHealthNote(
                        `⚠ ${blocked} 檔資料受阻，相關訊號已降級`,
                    );
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

                // Read-only B — never POST /open-confirm (would replace A pool)
                try {
                    const oc = await fetchOpenConfirmLatest();
                    if (!cancelled) setOpenConfirm(oc);
                } catch {
                    /* open confirm optional for home */
                }

                setLoading(false);
            } catch {
                if (!cancelled) {
                    setLiveStatus('DISCONNECTED');
                    setHealthNote('⚠ 無法連線資料服務');
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
            strong,
            heating,
            emerging,
            passCount: openConfirm?.pass ?? 0,
            taiexPct,
            tpexPct,
            liveStatus,
            healthNote,
            asOf,
            refresh,
        }),
        [
            loading,
            items,
            events,
            openConfirm,
            strong,
            heating,
            emerging,
            taiexPct,
            tpexPct,
            liveStatus,
            healthNote,
            asOf,
            refresh,
        ],
    );
}
