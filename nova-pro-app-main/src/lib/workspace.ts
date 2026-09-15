// src/lib/workspace.ts — dynamic panel blocks + grid layout + named profiles

import type { LayoutItem } from 'react-grid-layout';

export type BlockType =
    | 'watchlist'
    | 'movers'
    | 'dock'
    | 'chart'
    | 'depth'
    | 'ticket'
    | 'tape'
    | 'flash'
    | 'pnl'
    | 'chips'
    | 'volprofile'
    | 'optchain'
    | 'replay'
    | 'depthmap'
    | 'strategyScreener'
    | 'intradayRank'
    | 'predictionBook'
    | 'moneyFlow';

export interface Block {
    id: string;
    type: BlockType;
    // null → follows the globally selected symbol; string → pinned to a code
    pin: string | null;
}

export interface Workspace {
    blocks: Block[];
    layout: LayoutItem[];
}

export interface Profile {
    name: string;
    workspace: Workspace;
}

export const BLOCK_META: Record<
    BlockType,
    {
        label: string;
        pinnable: boolean;
        singleton: boolean;
        defaultSize: { w: number; h: number; minW: number; minH: number };
    }
> = {
    watchlist: {
        label: '自選清單',
        pinnable: false,
        singleton: true,
        defaultSize: { w: 4, h: 14, minW: 3, minH: 6 },
    },
    movers: {
        label: '排行榜',
        pinnable: false,
        singleton: true,
        defaultSize: { w: 4, h: 11, minW: 3, minH: 5 },
    },
    dock: {
        label: '持倉/委託/帳務（已移除）',
        pinnable: false,
        singleton: true,
        defaultSize: { w: 15, h: 9, minW: 6, minH: 5 },
    },
    chart: {
        label: 'K 線圖',
        pinnable: true,
        singleton: false,
        defaultSize: { w: 10, h: 12, minW: 6, minH: 7 },
    },
    depth: {
        label: '五檔',
        pinnable: true,
        singleton: false,
        defaultSize: { w: 5, h: 8, minW: 4, minH: 7 },
    },
    ticket: {
        label: '下單面板（已移除）',
        pinnable: true,
        singleton: false,
        defaultSize: { w: 5, h: 11, minW: 4, minH: 10 },
    },
    tape: {
        label: '成交明細',
        pinnable: true,
        singleton: false,
        defaultSize: { w: 4, h: 8, minW: 3, minH: 4 },
    },
    flash: {
        label: '閃電下單（已移除）',
        pinnable: true,
        singleton: false,
        defaultSize: { w: 5, h: 14, minW: 4, minH: 8 },
    },
    pnl: {
        label: '損益分析（已移除）',
        pinnable: false,
        singleton: true,
        defaultSize: { w: 8, h: 8, minW: 6, minH: 6 },
    },
    chips: {
        label: '籌碼資訊',
        pinnable: true,
        singleton: false,
        defaultSize: { w: 5, h: 8, minW: 4, minH: 5 },
    },
    volprofile: {
        label: '分價量表',
        pinnable: true,
        singleton: false,
        defaultSize: { w: 5, h: 12, minW: 4, minH: 6 },
    },
    optchain: {
        label: '選擇權 T 字',
        pinnable: false,
        singleton: true,
        defaultSize: { w: 10, h: 14, minW: 8, minH: 8 },
    },
    replay: {
        label: '行情回放',
        pinnable: true,
        singleton: false,
        defaultSize: { w: 10, h: 10, minW: 6, minH: 6 },
    },
    depthmap: {
        label: '委託簿熱圖',
        pinnable: true,
        singleton: false,
        defaultSize: { w: 8, h: 9, minW: 5, minH: 6 },
    },
    strategyScreener: {
        label: '智能篩選',
        pinnable: false,
        singleton: true,
        defaultSize: { w: 8, h: 12, minW: 6, minH: 8 },
    },
    intradayRank: {
        label: '盤中強攻雷達',
        pinnable: false,
        singleton: true,
        defaultSize: { w: 8, h: 14, minW: 5, minH: 8 },
    },
    predictionBook: {
        label: '布局本',
        pinnable: false,
        singleton: true,
        defaultSize: { w: 8, h: 10, minW: 6, minH: 7 },
    },
    moneyFlow: {
        label: '資金流排行',
        pinnable: false,
        singleton: true,
        defaultSize: { w: 5, h: 14, minW: 4, minH: 8 },
    },
};

export const DEFAULT_WORKSPACE: Workspace = {
    blocks: [
        { id: 'watchlist-0', type: 'watchlist', pin: null },
        { id: 'strategyScreener-0', type: 'strategyScreener', pin: null },
        { id: 'moneyFlow-0', type: 'moneyFlow', pin: null },
        { id: 'chart-0', type: 'chart', pin: null },
        { id: 'intradayRank-0', type: 'intradayRank', pin: null },
        { id: 'depth-0', type: 'depth', pin: null },
        { id: 'volprofile-0', type: 'volprofile', pin: null },
        { id: 'predictionBook-0', type: 'predictionBook', pin: null },
    ],
    layout: [
        { i: 'watchlist-0', x: 0, y: 0, w: 4, h: 8, minW: 3, minH: 6 },
        {
            i: 'strategyScreener-0',
            x: 0,
            y: 8,
            w: 4,
            h: 12,
            minW: 3,
            minH: 8,
        },
        {
            i: 'moneyFlow-0',
            x: 0,
            y: 20,
            w: 4,
            h: 14,
            minW: 4,
            minH: 8,
        },
        { i: 'chart-0', x: 4, y: 0, w: 15, h: 16, minW: 6, minH: 7 },
        {
            i: 'intradayRank-0',
            x: 4,
            y: 16,
            w: 15,
            h: 14,
            minW: 5,
            minH: 8,
        },
        { i: 'depth-0', x: 19, y: 0, w: 5, h: 8, minW: 4, minH: 7 },
        { i: 'volprofile-0', x: 19, y: 8, w: 5, h: 10, minW: 4, minH: 6 },
        {
            i: 'predictionBook-0',
            x: 19,
            y: 18,
            w: 5,
            h: 10,
            minW: 4,
            minH: 7,
        },
    ],
};

/** Execution-layer panels removed from decision-support product. */
export const REMOVED_BLOCK_TYPES: ReadonlySet<BlockType> = new Set([
    'dock',
    'ticket',
    'flash',
    'pnl',
]);

const WS_KEY = 'sj-pro-workspace-v4';
const PROFILES_KEY = 'sj-pro-profiles-v1';

function validWorkspace(w: unknown): w is Workspace {
    if (!w || typeof w !== 'object') return false;
    const ws = w as Workspace;
    if (!Array.isArray(ws.blocks) || !Array.isArray(ws.layout)) return false;
    if (ws.blocks.length === 0) return false;
    const ids = new Set(ws.blocks.map((b) => b.id));
    return ws.layout.every((l) => ids.has(l.i));
}

/** Ensure newer panels exist for older saved layouts. */
function ensureVolProfile(ws: Workspace): Workspace {
    if (ws.blocks.some((b) => b.type === 'volprofile')) return ws;
    const id = 'volprofile-0';
    const meta = BLOCK_META.volprofile;
    const depth = ws.layout.find((l) => l.i.startsWith('depth-'));
    const x = depth?.x ?? 19;
    const y = depth ? depth.y + depth.h : 8;
    return {
        blocks: [...ws.blocks, { id, type: 'volprofile', pin: null }],
        layout: [
            ...ws.layout,
            {
                i: id,
                x,
                y,
                w: meta.defaultSize.w,
                h: meta.defaultSize.h,
                minW: meta.defaultSize.minW,
                minH: meta.defaultSize.minH,
            },
        ],
    };
}

function ensureMoneyFlow(ws: Workspace): Workspace {
    if (ws.blocks.some((b) => b.type === 'moneyFlow')) return ws;
    const id = 'moneyFlow-0';
    const meta = BLOCK_META.moneyFlow;
    const screener = ws.layout.find((l) => l.i.startsWith('strategyScreener-'));
    const x = screener?.x ?? 0;
    const y = screener ? screener.y + screener.h : 20;
    return {
        blocks: [...ws.blocks, { id, type: 'moneyFlow', pin: null }],
        layout: [
            ...ws.layout,
            {
                i: id,
                x,
                y,
                w: meta.defaultSize.w,
                h: meta.defaultSize.h,
                minW: meta.defaultSize.minW,
                minH: meta.defaultSize.minH,
            },
        ],
    };
}

function stripRemovedBlocks(ws: Workspace): Workspace {
    const blocks = ws.blocks.filter((b) => !REMOVED_BLOCK_TYPES.has(b.type));
    if (blocks.length === ws.blocks.length) return ws;
    if (blocks.length === 0) return structuredClone(DEFAULT_WORKSPACE);
    const keep = new Set(blocks.map((b) => b.id));
    return {
        blocks,
        layout: ws.layout.filter((l) => keep.has(l.i)),
    };
}

function migrateWorkspace(ws: Workspace): Workspace {
    return ensureMoneyFlow(ensureVolProfile(stripRemovedBlocks(ws)));
}

export function loadWorkspace(): Workspace {
    try {
        const raw = localStorage.getItem(WS_KEY);
        if (raw) {
            const w = JSON.parse(raw);
            if (validWorkspace(w)) {
                const next = migrateWorkspace(w);
                if (next !== w) {
                    try {
                        localStorage.setItem(WS_KEY, JSON.stringify(next));
                    } catch {
                        // ignore quota
                    }
                }
                return next;
            }
        }
    } catch {
        // fall through
    }
    return structuredClone(DEFAULT_WORKSPACE);
}

export function saveWorkspace(w: Workspace) {
    localStorage.setItem(WS_KEY, JSON.stringify(w));
}

export function loadProfiles(): Profile[] {
    try {
        const raw = localStorage.getItem(PROFILES_KEY);
        if (raw) {
            const arr = JSON.parse(raw);
            if (Array.isArray(arr)) {
                return (arr as Profile[]).filter(
                    (p) =>
                        typeof p.name === 'string' &&
                        validWorkspace(p.workspace),
                );
            }
        }
    } catch {
        // fall through
    }
    return [];
}

export function saveProfiles(profiles: Profile[]) {
    localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
}

let blockCounter = Date.now() % 100000;
export function newBlockId(type: BlockType): string {
    blockCounter += 1;
    return `${type}-${blockCounter}`;
}
