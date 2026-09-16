// server/src/lib/event-intelligence/impact-graph.ts
// Multi-path hypotheses — NEVER single hardcode WAR→SHIPPING POSITIVE.

import type {
    EventImpactGraph,
    ImpactDirection,
    ImpactEdge,
    MarketEvent,
    SectorImpactHypothesis,
    TransmissionChannel,
} from './types.ts';

function edge(
    from: string,
    to: string,
    direction: ImpactDirection,
    rationale: string,
    confidence: 'HIGH' | 'MEDIUM' | 'LOW' = 'MEDIUM',
): ImpactEdge {
    return {
        from,
        to,
        direction,
        confidence,
        rationale,
        source_basis: 'deterministic_hypothesis_v1',
    };
}

function hyp(
    sector: string,
    channels: TransmissionChannel[],
    direction: ImpactDirection,
    relevance: number,
    rationale: string,
): SectorImpactHypothesis {
    return {
        sector_or_theme: sector,
        channels,
        direction,
        relevance,
        confidence: 'MEDIUM',
        rationale,
    };
}

export function buildImpactGraph(
    ev: MarketEvent,
    opts?: { oil_change_pct?: number | null },
): EventImpactGraph {
    const edges: ImpactEdge[] = [];
    const hyps: SectorImpactHypothesis[] = [];
    const t = ev.event_type;
    const oilPct = opts?.oil_change_pct;

    if (t === 'WAR_CONFLICT' || t === 'GEOPOLITICAL' || t === 'SHIPPING_DISRUPTION') {
        edges.push(
            edge(t, 'SHIPPING_ROUTE_DISRUPTION', 'UNKNOWN', '航線風險上升（假設）'),
            edge('SHIPPING_ROUTE_DISRUPTION', 'FREIGHT_RATE', 'POSITIVE', '運價可能上升'),
            edge('FREIGHT_RATE', '航運', 'POSITIVE', '運價↑可能支撐營收'),
            edge(t, 'OIL_PRICE', 'POSITIVE', '地緣緊張常推升油價'),
            edge('OIL_PRICE', 'FUEL_COST', 'NEGATIVE', '燃油成本上升'),
            edge('FUEL_COST', '航運', 'NEGATIVE', '成本壓力可能侵蝕利潤'),
            edge('FUEL_COST', '航空', 'NEGATIVE', '燃油占比高'),
            edge(t, 'RISK_OFF', 'NEGATIVE', '風險偏好下降可能壓抑股市評價'),
            edge(t, 'DEFENSE_DEMAND', 'POSITIVE', '防衛需求可能上升'),
            edge('DEFENSE_DEMAND', '軍工', 'POSITIVE', '防衛題材假設'),
        );
        hyps.push(
            hyp('航運', ['FREIGHT_RATE', 'FUEL_COST'], 'MIXED', 91, '運價可能↑但燃油成本也可能↑'),
            hyp('航空', ['FUEL_COST', 'AIR_ROUTE'], 'NEGATIVE', 68, '燃油與航線風險偏壓'),
            hyp('能源', ['OIL_PRICE'], 'POSITIVE', 61, '油價通道可能偏多'),
            hyp('軍工', ['DEFENSE_DEMAND'], 'POSITIVE', 55, '防衛需求假設'),
        );
    }

    if (t === 'ENERGY' || t === 'COMMODITY') {
        const oilConf =
            oilPct != null && Math.abs(oilPct) >= 5 ? 'HIGH' : 'MEDIUM';
        edges.push(
            edge(t, 'OIL_PRICE', 'UNKNOWN', '能源／商品價格事件', oilConf),
            edge('OIL_PRICE', '航空', 'NEGATIVE', '油價↑對航空偏壓', oilConf),
            edge('OIL_PRICE', '航運', 'MIXED', '油價↑成本↑，但運價傳導不一', oilConf),
            edge('OIL_PRICE', '塑膠化工', 'MIXED', '原料成本與轉嫁能力不一'),
        );
        hyps.push(
            hyp('航空', ['OIL_PRICE', 'FUEL_COST'], 'NEGATIVE', 80, '燃油成本敏感'),
            hyp('航運', ['OIL_PRICE', 'FUEL_COST'], 'MIXED', 70, '成本與運價傳導不一'),
            hyp('塑膠化工', ['OIL_PRICE'], 'MIXED', 60, '原料成本假設，非必漲'),
        );
        if (oilPct != null && oilPct >= 5) {
            const energy = hyps.find((h) => h.sector_or_theme === '能源');
            if (energy) {
                energy.confidence = 'HIGH';
                energy.rationale += ` · Oil ${oilPct >= 0 ? '+' : ''}${oilPct.toFixed(1)}% 提升 ENERGY_PRICE_CHANNEL confidence`;
            } else {
                hyps.push(
                    hyp(
                        '能源',
                        ['OIL_PRICE'],
                        'POSITIVE',
                        75,
                        `Oil ${oilPct >= 0 ? '+' : ''}${oilPct.toFixed(1)}% 提升通道 confidence（不改策略分數）`,
                    ),
                );
            }
        }
    }

    if (t === 'EPIDEMIC') {
        edges.push(
            edge(t, 'TESTING_DEMAND', 'POSITIVE', '檢測需求可能上升'),
            edge(t, 'PPE_DEMAND', 'POSITIVE', '防護用品需求可能上升'),
            edge(t, 'VACCINE_DEMAND', 'MIXED', '疫苗需求視病原與階段'),
            edge(t, 'MEDICAL_DEMAND', 'MIXED', '醫療需求分化'),
            edge(t, 'RISK_OFF', 'NEGATIVE', '恐慌可能壓抑風險資產'),
        );
        hyps.push(
            hyp('快篩／檢測', ['TESTING_DEMAND'], 'POSITIVE', 88, '檢測通道'),
            hyp('防護用品', ['PPE_DEMAND'], 'POSITIVE', 70, 'PPE 通道'),
            hyp('疫苗', ['VACCINE_DEMAND'], 'MIXED', 60, '視病原與階段'),
            hyp('生技醫療', ['MEDICAL_DEMAND'], 'UNKNOWN', 35, '產業標籤≠必然受惠'),
        );
    }

    if (t === 'SANCTION' || t === 'EXPORT_CONTROL') {
        edges.push(
            edge(t, 'EXPORT_RESTRICTION', 'NEGATIVE', '出口／技術限制'),
            edge('EXPORT_RESTRICTION', '半導體', 'MIXED', '短空長多／重組供應鏈皆可能'),
            edge(t, 'SUPPLY_SHORTAGE', 'MIXED', '供給重組'),
        );
        hyps.push(
            hyp('半導體', ['EXPORT_RESTRICTION', 'SUPPLY_SHORTAGE'], 'MIXED', 75, '管制影響路徑分歧'),
        );
    }

    if (t === 'EARTHQUAKE' || t === 'NATURAL_DISASTER') {
        edges.push(
            edge(t, 'SUPPLY_SHORTAGE', 'MIXED', '供應中斷風險'),
            edge(t, 'RECONSTRUCTION', 'POSITIVE', '重建需求假設'),
            edge('RECONSTRUCTION', '水泥', 'POSITIVE', '重建物料假設'),
            edge('RECONSTRUCTION', '鋼鐵', 'POSITIVE', '重建物料假設'),
        );
        hyps.push(
            hyp('水泥', ['RECONSTRUCTION'], 'POSITIVE', 50, '重建假設，需市場確認'),
            hyp('鋼鐵', ['RECONSTRUCTION'], 'POSITIVE', 50, '重建假設，需市場確認'),
        );
    }

    if (!edges.length) {
        edges.push(edge(t, 'UNKNOWN', 'UNKNOWN', '資料不足，無預設傳導路徑'));
        hyps.push(hyp('未分類', [], 'UNKNOWN', 20, '資料不足'));
    }

    const dirs = new Set(hyps.map((h) => h.direction));
    let overall: ImpactDirection = 'UNKNOWN';
    if (dirs.has('MIXED') || (dirs.has('POSITIVE') && dirs.has('NEGATIVE'))) {
        overall = 'MIXED';
    } else if (dirs.size === 1) {
        overall = [...dirs][0]!;
    }

    return {
        event_id: ev.event_id,
        cluster_id: ev.cluster_id,
        edges,
        sector_hypotheses: hyps,
        overall_direction: overall,
        note: 'Hypothesis only — requires MarketConfirmationEngine; not trading advice.',
    };
}
