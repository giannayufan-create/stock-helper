const KEY = 'sj-radar-favorites-v1';

export function loadFavorites(): string[] {
    try {
        const raw = localStorage.getItem(KEY);
        if (!raw) return [];
        const arr = JSON.parse(raw) as unknown;
        return Array.isArray(arr)
            ? arr.filter((x): x is string => typeof x === 'string')
            : [];
    } catch {
        return [];
    }
}

export function saveFavorites(codes: string[]): void {
    localStorage.setItem(KEY, JSON.stringify([...new Set(codes)]));
}

export function toggleFavorite(code: string): string[] {
    const cur = loadFavorites();
    const next = cur.includes(code)
        ? cur.filter((c) => c !== code)
        : [...cur, code];
    saveFavorites(next);
    return next;
}
