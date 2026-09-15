// server/src/lib/market-intelligence/theme/theme-config.ts

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ThemeDefinition {
    theme_id: string;
    name: string;
    aliases: string[];
    symbols: string[];
    source: string;
    confidence: string;
    updated_at: string;
    version: string;
}

export interface ThemeMapFile {
    version: string;
    updated_at: string;
    source: string;
    themes: Array<{
        theme_id: string;
        name: string;
        aliases: string[];
        symbols: string[];
        confidence: string;
    }>;
}

export function loadThemeMap(): {
    version: string;
    themes: ThemeDefinition[];
} {
    const here = dirname(fileURLToPath(import.meta.url));
    const path = join(here, '..', '..', '..', '..', 'config', 'theme-map.json');
    if (!existsSync(path)) {
        return { version: 'theme_map_missing', themes: [] };
    }
    const raw = JSON.parse(readFileSync(path, 'utf8')) as ThemeMapFile;
    const themes: ThemeDefinition[] = (raw.themes ?? []).map((t) => ({
        theme_id: t.theme_id,
        name: t.name,
        aliases: t.aliases ?? [],
        symbols: [...new Set((t.symbols ?? []).map((s) => String(s).trim()))],
        source: raw.source ?? 'manual_curated',
        confidence: t.confidence ?? 'medium',
        updated_at: raw.updated_at ?? '',
        version: raw.version ?? 'theme_map_v1',
    }));
    return { version: raw.version ?? 'theme_map_v1', themes };
}
