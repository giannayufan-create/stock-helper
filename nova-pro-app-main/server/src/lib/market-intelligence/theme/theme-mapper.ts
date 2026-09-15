// server/src/lib/market-intelligence/theme/theme-mapper.ts

import { loadThemeMap, type ThemeDefinition } from './theme-config.ts';

export class ThemeMapper {
    readonly version: string;
    private themes: ThemeDefinition[];
    private bySymbol = new Map<string, ThemeDefinition[]>();

    constructor() {
        const loaded = loadThemeMap();
        this.version = loaded.version;
        this.themes = loaded.themes;
        for (const t of this.themes) {
            for (const sym of t.symbols) {
                const list = this.bySymbol.get(sym) ?? [];
                list.push(t);
                this.bySymbol.set(sym, list);
            }
        }
    }

    all(): ThemeDefinition[] {
        return this.themes;
    }

    get(themeId: string): ThemeDefinition | null {
        return this.themes.find((t) => t.theme_id === themeId) ?? null;
    }

    byName(name: string): ThemeDefinition | null {
        const n = name.trim().toLowerCase();
        return (
            this.themes.find(
                (t) =>
                    t.name.toLowerCase() === n ||
                    t.theme_id === n ||
                    t.aliases.some((a) => a.toLowerCase() === n),
            ) ?? null
        );
    }

    themesOf(symbol: string): ThemeDefinition[] {
        return this.bySymbol.get(symbol) ?? [];
    }

    size(): number {
        return this.themes.length;
    }
}
