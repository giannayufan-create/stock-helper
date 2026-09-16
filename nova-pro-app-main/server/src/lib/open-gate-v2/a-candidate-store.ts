// server/src/lib/open-gate-v2/a-candidate-store.ts
// Persist A pool for headless hydrate — does NOT compute A scores.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ACandidate } from './types.ts';

export interface ACandidateSnapshot {
    as_of: string;
    session_date: string;
    source: 'server' | 'legacy_frontend' | 'hydrated';
    ui_required: false;
    count: number;
    candidates: ACandidate[];
}

function taipeiYmd(d = new Date()): string {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Taipei',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(d);
}

export class ACandidateStore {
    constructor(private dataDir: string) {}

    private dir(): string {
        const p = join(this.dataDir, 'a-candidates');
        mkdirSync(p, { recursive: true });
        return p;
    }

    save(candidates: ACandidate[], source: ACandidateSnapshot['source']): string {
        const session_date = taipeiYmd();
        const snap: ACandidateSnapshot = {
            as_of: new Date().toISOString(),
            session_date,
            source,
            ui_required: false,
            count: candidates.length,
            candidates,
        };
        const path = join(this.dir(), `${session_date}.json`);
        writeFileSync(path, JSON.stringify(snap, null, 2), 'utf8');
        // also write latest pointer
        writeFileSync(
            join(this.dir(), 'latest.json'),
            JSON.stringify(snap, null, 2),
            'utf8',
        );
        return path;
    }

    loadLatest(): ACandidateSnapshot | null {
        const latest = join(this.dir(), 'latest.json');
        if (existsSync(latest)) {
            try {
                return JSON.parse(readFileSync(latest, 'utf8')) as ACandidateSnapshot;
            } catch {
                /* fall through */
            }
        }
        const dir = this.dir();
        const files = readdirSync(dir)
            .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
            .sort()
            .reverse();
        for (const f of files) {
            try {
                return JSON.parse(
                    readFileSync(join(dir, f), 'utf8'),
                ) as ACandidateSnapshot;
            } catch {
                /* next */
            }
        }
        return null;
    }

    loadForDate(ymd: string): ACandidateSnapshot | null {
        const path = join(this.dir(), `${ymd}.json`);
        if (!existsSync(path)) return null;
        try {
            return JSON.parse(readFileSync(path, 'utf8')) as ACandidateSnapshot;
        } catch {
            return null;
        }
    }
}
