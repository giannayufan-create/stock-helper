// server/src/lib/learning/experiment-repository.ts
// Persist experiments under data/learning/experiments/ — never production config.

import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExperimentReport } from './types.ts';

function defaultRoot(): string {
    const here = dirname(fileURLToPath(import.meta.url));
    return join(here, '..', '..', '..', 'data', 'learning', 'experiments');
}

export class ExperimentRepository {
    private root: string;

    constructor(root = defaultRoot()) {
        this.root = root;
        if (!existsSync(this.root)) {
            mkdirSync(this.root, { recursive: true });
        }
    }

    save(report: ExperimentReport): string {
        const file = join(this.root, `${report.experiment_id}.json`);
        writeFileSync(file, JSON.stringify(report, null, 2));
        return file;
    }

    findById(id: string): ExperimentReport | null {
        const file = join(this.root, `${id}.json`);
        if (!existsSync(file)) return null;
        return JSON.parse(readFileSync(file, 'utf8')) as ExperimentReport;
    }

    list(): ExperimentReport[] {
        if (!existsSync(this.root)) return [];
        return readdirSync(this.root)
            .filter((f) => f.endsWith('.json'))
            .map(
                (f) =>
                    JSON.parse(
                        readFileSync(join(this.root, f), 'utf8'),
                    ) as ExperimentReport,
            )
            .sort((a, b) => b.created_at.localeCompare(a.created_at));
    }
}

/** Config version history for manual rollback — does NOT auto-apply. */
export interface ConfigVersionRecord {
    config_version: string;
    previous_version: string | null;
    created_at: string;
    reason: string;
    experiment_id: string | null;
    target: 'open-gate' | 'intraday-rank';
    /** Snapshot of config object — research archive only. */
    snapshot: Record<string, unknown>;
}

export class ConfigVersionRepository {
    private root: string;

    constructor(root?: string) {
        const here = dirname(fileURLToPath(import.meta.url));
        this.root =
            root ??
            join(here, '..', '..', '..', 'data', 'learning', 'config-versions');
        if (!existsSync(this.root)) {
            mkdirSync(this.root, { recursive: true });
        }
    }

    append(record: ConfigVersionRecord): void {
        const file = join(this.root, `${record.target}.jsonl`);
        appendFileSync(file, `${JSON.stringify(record)}\n`);
    }

    latest(target: 'open-gate' | 'intraday-rank'): ConfigVersionRecord | null {
        const file = join(this.root, `${target}.jsonl`);
        if (!existsSync(file)) return null;
        const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
        if (!lines.length) return null;
        return JSON.parse(lines[lines.length - 1]!) as ConfigVersionRecord;
    }

    list(target: 'open-gate' | 'intraday-rank'): ConfigVersionRecord[] {
        const file = join(this.root, `${target}.jsonl`);
        if (!existsSync(file)) return [];
        return readFileSync(file, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l) as ConfigVersionRecord);
    }
}
