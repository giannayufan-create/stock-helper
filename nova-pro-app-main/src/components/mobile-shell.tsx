// Mobile shell → AI 當沖雷達 v2 (Premium Dark Fintech, mobile-first)

import type { ContractInfo } from '../lib/types/contract';
import type { Snapshot } from '../lib/types/market';
import type { PredictionRecord } from '../lib/prediction-book';
import { RadarApp } from './radar-v2/radar-app';

/**
 * Keeps the App.tsx MobileShell contract stable while swapping UI to Radar v2.
 * Unused trading props are accepted for backward compatibility.
 */
export function MobileShell({
    contract,
    snapshot,
    onSelectCode,
    onOpenSearch,
}: {
    contract: ContractInfo | null;
    snapshot?: Snapshot;
    trades: import('../lib/types/order').Trade[];
    onOrdersChanged: () => void;
    onRefreshTrading?: () => void;
    watchlistSeed: Array<{ code: string; name: string; close?: number }>;
    onSelectCode: (code: string) => void | Promise<void>;
    onAddPrediction: (record: PredictionRecord) => void;
    onAutoScanPredictions: (records: PredictionRecord[]) => void;
    predictions: PredictionRecord[];
    onClearPredictions: () => void;
    onVerifyPredictions: () => void | Promise<void>;
    verifyingPredictions: boolean;
    onOpenSearch?: () => void;
}) {
    return (
        <RadarApp
            contract={contract}
            snapshot={snapshot}
            onSelectCode={onSelectCode}
            onOpenSearch={onOpenSearch}
        />
    );
}
