// server/src/lib/ai-interpretation/snapshot-store.ts
// Immutable point-in-time snapshots for AI interpretation.

import { randomUUID } from 'node:crypto';
import type {
    RadarFilterSnapshot,
    RadarStockRowInput,
    StockInterpretationInput,
} from './types.ts';

export interface StockSnapshotRecord {
    snapshot_id: string;
    snapshot_at: string;
    kind: 'stock';
    input: StockInterpretationInput;
}

export interface RadarSnapshotRecord {
    snapshot_id: string;
    snapshot_at: string;
    kind: 'radar';
    filter: RadarFilterSnapshot;
    rows: RadarStockRowInput[];
    matched_symbols: string[];
    matched_count: number;
}

export class InterpretationSnapshotStore {
    private stock = new Map<string, StockSnapshotRecord>();
    private radar = new Map<string, RadarSnapshotRecord>();
    private max = 200;

    createStock(input: StockInterpretationInput): StockSnapshotRecord {
        const snapshot_at = new Date().toISOString();
        const snapshot_id = `stk_${input.symbol}_${randomUUID().slice(0, 8)}`;
        const rec: StockSnapshotRecord = {
            snapshot_id,
            snapshot_at,
            kind: 'stock',
            input: structuredClone(input),
        };
        this.stock.set(snapshot_id, rec);
        this.trim(this.stock);
        return rec;
    }

    getStock(id: string): StockSnapshotRecord | null {
        return this.stock.get(id) ?? null;
    }

    createRadar(
        filter: RadarFilterSnapshot,
        rows: RadarStockRowInput[],
    ): RadarSnapshotRecord {
        const snapshot_at = new Date().toISOString();
        const snapshot_id = `rad_${randomUUID().slice(0, 8)}`;
        const matched_symbols = rows.map((r) => r.symbol);
        const rec: RadarSnapshotRecord = {
            snapshot_id,
            snapshot_at,
            kind: 'radar',
            filter: structuredClone(filter),
            rows: structuredClone(rows),
            matched_symbols,
            matched_count: rows.length,
        };
        this.radar.set(snapshot_id, rec);
        this.trim(this.radar);
        return rec;
    }

    getRadar(id: string): RadarSnapshotRecord | null {
        return this.radar.get(id) ?? null;
    }

    private trim(map: Map<string, unknown>) {
        while (map.size > this.max) {
            const first = map.keys().next().value as string | undefined;
            if (!first) break;
            map.delete(first);
        }
    }
}
