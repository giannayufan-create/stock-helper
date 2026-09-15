// server/src/lib/market-intelligence/repository/market-intelligence-repository.ts

import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function root(): string {
    const here = dirname(fileURLToPath(import.meta.url));
    return join(here, '..', '..', '..', '..', 'data', 'market-intelligence');
}

function ymd(): string {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Taipei',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(new Date());
}

export class MarketIntelligenceRepository {
    private dir = root();

    constructor() {
        if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    }

    appendHeatSnapshot(row: Record<string, unknown>): void {
        this.append(`heat-${ymd()}.jsonl`, row);
    }

    appendDailyBrief(row: Record<string, unknown>): void {
        this.append(`brief-${ymd()}.jsonl`, row);
    }

    appendGlobal(row: Record<string, unknown>): void {
        this.append(`global-${ymd()}.jsonl`, row);
    }

    private append(file: string, row: Record<string, unknown>): void {
        try {
            appendFileSync(
                join(this.dir, file),
                JSON.stringify({ ...row, persisted_at: new Date().toISOString() }) +
                    '\n',
                'utf8',
            );
        } catch {
            // persistence must never break live MI
        }
    }
}
