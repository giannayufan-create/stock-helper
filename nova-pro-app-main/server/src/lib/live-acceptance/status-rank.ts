import type { LiveStatus } from './types.ts';

export function gateStatusRank(s: LiveStatus): number {
    switch (s) {
        case 'FAIL':
            return 3;
        case 'WARNING':
            return 2;
        case 'PARTIAL':
            return 1;
        case 'NOT_RUN':
            return 1;
        default:
            return 0;
    }
}
