// Execution dock (持倉/委託/帳務) — removed from decision-support product.

import type { AccountBalance, Margin } from '../lib/types/portfolio';
import type { Trade } from '../lib/types/order';
import type { Position } from '../lib/types/portfolio';

export function BottomDock(_props: {
    positions: Position[];
    trades: Trade[];
    balance?: AccountBalance;
    margin?: Margin;
    onTradesChanged: () => void;
}) {
    return null;
}
