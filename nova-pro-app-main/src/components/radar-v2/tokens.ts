/** Premium Dark Fintech semantic colors — radar UI only (not PASS red). */

export const radarColor = {
    glass: 'rgba(20, 28, 44, 0.72)',
    glassBorder: 'rgba(148, 163, 184, 0.14)',
    glassHighlight: 'rgba(255, 255, 255, 0.04)',

    /** STRONG / PASS — 紅系 */
    strong: '#f0434a',
    strongDim: 'rgba(240, 67, 74, 0.16)',

    /** HEATING / WATCH */
    heating: '#f5a524',
    heatingDim: 'rgba(245, 165, 36, 0.16)',

    /** EMERGING */
    emerging: '#e8c547',

    /** COOLING */
    cooling: '#9a8f7e',

    /** INVALID */
    invalid: '#5a6b5e',

    /** AI — 藍紫，不可與 PASS 混淆 */
    ai: '#8b7cf6',
    aiDim: 'rgba(139, 124, 246, 0.16)',
    aiSoft: '#a78bfa',

    /** Shadow research */
    shadow: '#a855f7',
    shadowDim: 'rgba(168, 85, 247, 0.14)',

    /** Data health */
    health: '#2dd4bf',
    healthDim: 'rgba(45, 212, 191, 0.14)',
    healthWarn: '#f5a524',
    healthBad: '#ef4444',

    live: '#34d399',
} as const;

export type LiveStatus = 'LIVE' | 'REPLAY' | 'DATA STALE' | 'DISCONNECTED';

export type RadarTab = 'today' | 'radar' | 'watch' | 'perf' | 'more';
