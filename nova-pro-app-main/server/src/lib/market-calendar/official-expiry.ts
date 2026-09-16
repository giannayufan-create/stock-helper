// Optional official TX monthly expiry overrides (TAIFEX contract calendar).
// When present, ALWAYS preferred over third-Wednesday rule estimate.

import type { OfficialExpiryEntry } from './expiry.ts';

/**
 * Seeded from TAIFEX published monthly TX last trading days.
 * Extend / refresh via env MCAL_OFFICIAL_EXPIRY_JSON or fetchOfficialExpiryCalendar().
 *
 * Format: contract_month YYYYMM → settlement / last trading date YYYY-MM-DD
 */
export const OFFICIAL_TX_MONTHLY_SEED: OfficialExpiryEntry[] = [
    // 2025
    { date: '2025-01-15', contract_month: '202501', product: 'TX', source: 'TAIFEX:seed' },
    { date: '2025-02-19', contract_month: '202502', product: 'TX', source: 'TAIFEX:seed' },
    { date: '2025-03-19', contract_month: '202503', product: 'TX', source: 'TAIFEX:seed' },
    { date: '2025-04-16', contract_month: '202504', product: 'TX', source: 'TAIFEX:seed' },
    { date: '2025-05-21', contract_month: '202505', product: 'TX', source: 'TAIFEX:seed' },
    { date: '2025-06-18', contract_month: '202506', product: 'TX', source: 'TAIFEX:seed' },
    { date: '2025-07-16', contract_month: '202507', product: 'TX', source: 'TAIFEX:seed' },
    { date: '2025-08-20', contract_month: '202508', product: 'TX', source: 'TAIFEX:seed' },
    { date: '2025-09-17', contract_month: '202509', product: 'TX', source: 'TAIFEX:seed' },
    { date: '2025-10-15', contract_month: '202510', product: 'TX', source: 'TAIFEX:seed' },
    { date: '2025-11-19', contract_month: '202511', product: 'TX', source: 'TAIFEX:seed' },
    { date: '2025-12-17', contract_month: '202512', product: 'TX', source: 'TAIFEX:seed' },
    // 2026
    { date: '2026-01-21', contract_month: '202601', product: 'TX', source: 'TAIFEX:seed' },
    { date: '2026-02-25', contract_month: '202602', product: 'TX', source: 'TAIFEX:seed' }, // holiday-adjusted from 3rd Wed
    { date: '2026-03-18', contract_month: '202603', product: 'TX', source: 'TAIFEX:seed' },
    { date: '2026-04-15', contract_month: '202604', product: 'TX', source: 'TAIFEX:seed' },
    { date: '2026-05-20', contract_month: '202605', product: 'TX', source: 'TAIFEX:seed' },
    { date: '2026-06-17', contract_month: '202606', product: 'TX', source: 'TAIFEX:seed' },
    { date: '2026-07-15', contract_month: '202607', product: 'TX', source: 'TAIFEX:seed' },
    { date: '2026-08-19', contract_month: '202608', product: 'TX', source: 'TAIFEX:seed' },
    { date: '2026-09-16', contract_month: '202609', product: 'TX', source: 'TAIFEX:seed' },
    { date: '2026-10-21', contract_month: '202610', product: 'TX', source: 'TAIFEX:seed' },
    { date: '2026-11-18', contract_month: '202611', product: 'TX', source: 'TAIFEX:seed' },
    { date: '2026-12-16', contract_month: '202612', product: 'TX', source: 'TAIFEX:seed' },
];

export function loadOfficialExpiryFromEnv(
    env: NodeJS.ProcessEnv = process.env,
): OfficialExpiryEntry[] {
    const raw = env.MCAL_OFFICIAL_EXPIRY_JSON;
    if (!raw) return [...OFFICIAL_TX_MONTHLY_SEED];
    try {
        const parsed = JSON.parse(raw) as OfficialExpiryEntry[];
        if (!Array.isArray(parsed)) return [...OFFICIAL_TX_MONTHLY_SEED];
        const byCm = new Map<string, OfficialExpiryEntry>();
        for (const e of OFFICIAL_TX_MONTHLY_SEED) {
            byCm.set(e.contract_month, e);
        }
        for (const e of parsed) {
            if (e?.date && e?.contract_month) {
                byCm.set(e.contract_month, {
                    ...e,
                    product: e.product ?? 'TX',
                    source: e.source ?? 'TAIFEX:env',
                });
            }
        }
        return [...byCm.values()];
    } catch {
        return [...OFFICIAL_TX_MONTHLY_SEED];
    }
}
