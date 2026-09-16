// server/src/lib/session-autonomy/overnight-snapshot.ts
// Built headlessly on NIGHT→PREOPEN (or forced). Never requires UI.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GlobalAssetQuote } from '../market-intelligence/types.ts';
import type { OvernightSnapshot, TradingSessionState } from './types.ts';
import { taipeiParts } from './session-clock.ts';

export function buildOvernightSnapshot(input: {
    nowMs: number;
    during: TradingSessionState;
    assets: GlobalAssetQuote[];
    usBiasLabel?: string | null;
    dataDir: string;
    persistDisk?: boolean;
}): OvernightSnapshot {
    const parts = taipeiParts(input.nowMs);
    const snap: OvernightSnapshot = {
        snapshot_id: `ovn_${parts.ymd}_${input.nowMs}`,
        session_date: parts.ymd,
        created_at: new Date(input.nowMs).toISOString(),
        created_during: input.during,
        source: 'session_autonomy',
        ui_required: false,
        global_assets: input.assets.map((a) => ({
            id: a.id,
            change_pct: a.change_pct,
            available: a.status === 'HEALTHY' && a.change_pct != null,
        })),
        us_overnight_bias: input.usBiasLabel ?? null,
        notes: [
            'Headless Overnight Snapshot — no EventSource / UI_VIEW required.',
        ],
        persisted_to: [],
    };

    if (input.persistDisk !== false) {
        try {
            const dir = join(input.dataDir, 'overnight_snapshots');
            mkdirSync(dir, { recursive: true });
            const path = join(dir, `${parts.ymd}.json`);
            writeFileSync(path, JSON.stringify(snap, null, 2), 'utf8');
            snap.persisted_to.push('disk');
        } catch {
            snap.notes.push('disk_persist_failed');
        }
    }

    return snap;
}
