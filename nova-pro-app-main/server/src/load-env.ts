// server/src/load-env.ts — load repo-root .env into process.env (no dotenv dep)

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function loadEnvFile(): void {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
        join(here, '..', '..', '.env'), // nova-pro-app-main/.env
        join(here, '..', '.env'), // server/.env
    ];
    for (const file of candidates) {
        if (!existsSync(file)) continue;
        const text = readFileSync(file, 'utf8');
        for (const raw of text.split(/\r?\n/)) {
            const line = raw.trim();
            if (!line || line.startsWith('#')) continue;
            const eq = line.indexOf('=');
            if (eq <= 0) continue;
            const key = line.slice(0, eq).trim();
            let val = line.slice(eq + 1).trim();
            // strip inline comments: KEY=value # comment
            const hash = val.indexOf(' #');
            if (hash >= 0) val = val.slice(0, hash).trim();
            if (
                (val.startsWith('"') && val.endsWith('"')) ||
                (val.startsWith("'") && val.endsWith("'"))
            ) {
                val = val.slice(1, -1);
            }
            // Common paste junk around secrets: 你的「KEY」API key
            val = val.replace(/^你的/, '').trim();
            val = val.replace(/\s*API key$/i, '').trim();
            val = val.replace(/^[「『"']+/, '').replace(/[」』"']+$/, '').trim();
            if (process.env[key] === undefined) {
                process.env[key] = val;
            }
        }
        return;
    }
}
