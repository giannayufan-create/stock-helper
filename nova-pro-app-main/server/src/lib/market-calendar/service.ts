// MarketCalendarService — unified trading day / expiry / corporate actions.

import {
    DEFAULT_MCAL_CONFIG,
    loadMarketCalendarConfig,
    type MarketCalendarConfig,
} from './config.ts';
import { fetchCorporateActions } from './corporate-actions.ts';
import {
    resolveMonthlyExpiry,
    resolveWeeklyExpiryHint,
    type OfficialExpiryEntry,
} from './expiry.ts';
import {
    breakoutCorporateActionGuard,
    buildCorporateActionContext,
    crossesCorporateAction,
    normalizeGap,
} from './gap-normalizer.ts';
import { loadOfficialExpiryFromEnv } from './official-expiry.ts';
import {
    emptyOverrides,
    taipeiYmd,
    tradingDayInfo,
    type HolidayOverrides,
} from './trading-day.ts';
import type {
    BreakoutCaGuard,
    CalendarTodaySnapshot,
    CorporateAction,
    CorporateActionContext,
    GapNormalization,
    MarketCalendarHealth,
    MonthlyExpiryInfo,
} from './types.ts';
import { MCAL_VERSION as VER } from './types.ts';

export class MarketCalendarService {
    readonly cfg: MarketCalendarConfig;
    private overrides: HolidayOverrides = emptyOverrides();
    private officialExpiry: OfficialExpiryEntry[] = loadOfficialExpiryFromEnv();
    private actions: CorporateAction[] = [];
    private lastRefreshAt: string | null = null;
    private twseOk = false;
    private tpexOk = false;
    private timer: ReturnType<typeof setInterval> | null = null;
    private started = false;
    private refreshing = false;

    constructor(cfg?: Partial<MarketCalendarConfig>) {
        this.cfg = { ...loadMarketCalendarConfig(), ...cfg };
    }

    start(): void {
        if (this.started) return;
        this.started = true;
        void this.refresh();
        this.timer = setInterval(() => {
            void this.refresh();
        }, this.cfg.refresh_interval_ms);
        // Unref so tests / short processes can exit
        if (typeof this.timer === 'object' && 'unref' in this.timer) {
            (this.timer as NodeJS.Timeout).unref?.();
        }
        console.log(
            `market-calendar: ${VER} refresh=${Math.round(this.cfg.refresh_interval_ms / 3600000)}h`,
        );
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.started = false;
    }

    async refresh(): Promise<void> {
        if (this.refreshing) return;
        this.refreshing = true;
        try {
            const asOf = taipeiYmd();
            const result = await fetchCorporateActions(this.cfg, asOf);
            this.actions = result.actions;
            this.twseOk = result.twse_ok;
            this.tpexOk = result.tpex_ok;
            this.lastRefreshAt = result.fetched_at;
            console.log(
                `market-calendar: refreshed actions=${this.actions.length} twse=${this.twseOk} tpex=${this.tpexOk}`,
            );
        } catch (err) {
            console.warn(
                `market-calendar: refresh failed (soft): ${err instanceof Error ? err.message : String(err)}`,
            );
        } finally {
            this.refreshing = false;
        }
    }

    /** Inject actions for tests — no network. */
    seedForTest(opts: {
        actions?: CorporateAction[];
        officialExpiry?: OfficialExpiryEntry[];
        overrides?: HolidayOverrides;
        twseOk?: boolean;
        tpexOk?: boolean;
    }): void {
        if (opts.actions) this.actions = opts.actions;
        if (opts.officialExpiry) this.officialExpiry = opts.officialExpiry;
        if (opts.overrides) this.overrides = opts.overrides;
        if (opts.twseOk != null) this.twseOk = opts.twseOk;
        if (opts.tpexOk != null) this.tpexOk = opts.tpexOk;
        this.lastRefreshAt = new Date().toISOString();
    }

    getActions(filter?: {
        from?: string;
        to?: string;
        symbol?: string;
        action_type?: string;
        market?: string;
    }): CorporateAction[] {
        let list = this.actions;
        if (filter?.symbol) {
            list = list.filter((a) => a.symbol === filter.symbol);
        }
        if (filter?.action_type) {
            list = list.filter((a) => a.action_type === filter.action_type);
        }
        if (filter?.market) {
            list = list.filter((a) => a.market === filter.market);
        }
        if (filter?.from) {
            list = list.filter((a) => a.action_date >= filter.from!);
        }
        if (filter?.to) {
            list = list.filter((a) => a.action_date <= filter.to!);
        }
        return list;
    }

    getActionForSymbol(
        symbol: string,
        asOfYmd: string = taipeiYmd(),
    ): CorporateAction | null {
        return (
            this.getActions({ symbol }).find((a) => a.action_date === asOfYmd) ??
            null
        );
    }

    getCorporateActionContext(
        symbol: string,
        asOfYmd: string = taipeiYmd(),
    ): CorporateActionContext {
        return buildCorporateActionContext({
            symbol,
            asOfYmd,
            actions: this.actions,
            overrides: this.overrides,
        });
    }

    getGapNormalization(opts: {
        symbol: string;
        todayPrice: number;
        openPrice?: number | null;
        vendorPrevClose: number | null;
        asOfYmd?: string;
    }): GapNormalization {
        const ctx = this.getCorporateActionContext(
            opts.symbol,
            opts.asOfYmd ?? taipeiYmd(),
        );
        return normalizeGap({
            todayPrice: opts.todayPrice,
            openPrice: opts.openPrice,
            vendorPrevClose: opts.vendorPrevClose,
            ctx,
        });
    }

    getBreakoutGuard(
        symbol: string,
        asOfYmd: string = taipeiYmd(),
    ): BreakoutCaGuard {
        return breakoutCorporateActionGuard(
            this.getCorporateActionContext(symbol, asOfYmd),
        );
    }

    crossesCorporateAction(opts: {
        symbol: string;
        fromYmd: string;
        toYmd: string;
    }): boolean {
        return crossesCorporateAction({
            ...opts,
            actions: this.actions,
        });
    }

    getMonthlyExpiry(asOfYmd: string = taipeiYmd()): MonthlyExpiryInfo {
        return resolveMonthlyExpiry({
            asOfYmd,
            overrides: this.overrides,
            official: this.officialExpiry,
        });
    }

    getWeeklyExpiry(asOfYmd: string = taipeiYmd()) {
        const monthly = this.getMonthlyExpiry(asOfYmd);
        return resolveWeeklyExpiryHint(asOfYmd, monthly, this.overrides);
    }

    getTradingDay(asOfYmd: string = taipeiYmd()) {
        return tradingDayInfo(asOfYmd, this.overrides);
    }

    getToday(asOfYmd: string = taipeiYmd()): CalendarTodaySnapshot {
        const trading_day = this.getTradingDay(asOfYmd);
        const monthly_expiry = this.getMonthlyExpiry(asOfYmd);
        const corporate_actions_today = this.getActions({
            from: asOfYmd,
            to: asOfYmd,
        });
        const fetched = this.lastRefreshAt ?? new Date().toISOString();
        return {
            date: asOfYmd,
            trading_day,
            monthly_expiry,
            corporate_actions_today,
            corporate_action_count: corporate_actions_today.length,
            major_event_count: 0, // filled by route via EventIntelligence if available
            calendar_context: {
                monthly_expiry_label: monthly_expiry.is_monthly_expiry_day
                    ? '台指期月結算'
                    : '台指期月契約',
                expiry_phase: monthly_expiry.expiry_phase,
                days_to_monthly_expiry: monthly_expiry.days_to_monthly_expiry,
                institutional_roll_sensitive:
                    monthly_expiry.institutional_roll_sensitive,
            },
            meta: {
                source: 'MarketCalendarService',
                published_at: null,
                fetched_at: fetched,
                observed_at: new Date().toISOString(),
                freshness: this.twseOk || this.tpexOk ? 'OK' : 'STALE',
                confidence:
                    this.twseOk || this.tpexOk ? 'HIGH' : 'LOW',
                available: true,
            },
            creates_upstream_subscription: false,
            mutates_strategy: false,
        };
    }

    getHealth(): MarketCalendarHealth {
        const ok = this.twseOk || this.tpexOk || this.actions.length > 0;
        return {
            enabled: true,
            status: ok ? 'OK' : this.lastRefreshAt ? 'DEGRADED' : 'UNAVAILABLE',
            version: VER,
            trading_day_available: true,
            expiry_available: true,
            twse_actions_available: this.twseOk,
            tpex_actions_available: this.tpexOk,
            last_refresh_at: this.lastRefreshAt,
            action_count: this.actions.length,
            creates_upstream_subscription: false,
            mutates_strategy: false,
        };
    }
}

export { DEFAULT_MCAL_CONFIG, VER as MCAL_VERSION };
