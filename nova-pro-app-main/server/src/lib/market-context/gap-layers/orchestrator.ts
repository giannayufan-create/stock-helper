// server/src/lib/market-context/gap-layers/orchestrator.ts
// Assembles all gap layers. Strategy isolation: never mutates C/BP.

import type { GlobalAssetQuote } from '../../market-intelligence/types.ts';
import type { MarketRuntime } from '../../market-runtime/index.ts';
import type { TwDayQuote } from '../../tw-market-day.ts';
import { evaluateAsiaRegime } from './asia-regime.ts';
import { evaluateCrowding } from './crowding.ts';
import { evaluateDerivativesPositioning } from './derivatives-positioning.ts';
import { evaluateFuturesLead } from './futures-lead.ts';
import { evaluateIndexConcentration } from './index-concentration.ts';
import { evaluateIndustryDrivers } from './industry-drivers.ts';
import { evaluateMacroEventCalendar } from './macro-calendar.ts';
import { evaluateOverseasCompany } from './overseas-company.ts';
import { evaluatePassiveFlowCalendar } from './passive-flow.ts';
import { evaluatePreOpenAuction } from './preopen-auction.ts';
import {
    GAP_LAYERS_VERSION,
    type GapLayersSnapshot,
} from './types.ts';

export async function buildGapLayersSnapshot(input: {
    runtime: MarketRuntime;
    quotes: TwDayQuote[];
    breadthAdvancePct: number | null;
    taiwanRegime: string | null;
    globalAssets: GlobalAssetQuote[];
    fetchedAt: string;
}): Promise<GapLayersSnapshot> {
    const [crowding, derivatives, overseas] = await Promise.all([
        evaluateCrowding(input.fetchedAt),
        evaluateDerivativesPositioning(input.fetchedAt),
        evaluateOverseasCompany(input.fetchedAt),
    ]);

    return {
        as_of: input.fetchedAt,
        version: GAP_LAYERS_VERSION,
        mutates_strategy: false,
        creates_upstream_subscription: false,
        preopen_auction: evaluatePreOpenAuction(input.fetchedAt),
        futures_lead: evaluateFuturesLead(input.runtime, input.fetchedAt),
        index_concentration: evaluateIndexConcentration(
            input.quotes,
            input.breadthAdvancePct,
            input.fetchedAt,
        ),
        asia_regime: evaluateAsiaRegime(
            input.globalAssets,
            input.taiwanRegime,
            input.fetchedAt,
        ),
        macro_event_calendar: evaluateMacroEventCalendar(input.fetchedAt),
        passive_flow_calendar: evaluatePassiveFlowCalendar(input.fetchedAt),
        crowding,
        derivatives_positioning: derivatives,
        overseas_company: overseas,
        industry_drivers: evaluateIndustryDrivers(
            input.globalAssets,
            input.fetchedAt,
        ),
    };
}
