// server/src/lib/broker-intelligence/repository/broker-intelligence-repository.ts

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function root(): string {
    const here = dirname(fileURLToPath(import.meta.url));
    return join(here, '..', '..', '..', '..', 'data', 'broker-intelligence');
}

function ymd(): string {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Taipei',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(new Date());
}

export class BrokerIntelligenceRepository {
    private dir = root();

    constructor() {
        if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    }

    appendSummary(row: Record<string, unknown>): void {
        this.append(`summary-${ymd()}.jsonl`, row);
    }

    appendConcentration(row: Record<string, unknown>): void {
        this.append(`concentration-${ymd()}.jsonl`, row);
    }

    private append(file: string, row: Record<string, unknown>): void {
        try {
            appendFileSync(
                join(this.dir, file),
                JSON.stringify({
                    ...row,
                    persisted_at: new Date().toISOString(),
                }) + '\n',
                'utf8',
            );
        } catch {
            // never break live path
        }
    }
}
