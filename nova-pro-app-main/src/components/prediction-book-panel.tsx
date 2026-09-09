import {
    modeLabel,
    predictionStats,
    statusLabel,
    type PredictionRecord,
    type PredictionStatus,
} from '../lib/prediction-book';
import { buildLearnModel, type LearnBucket } from '../lib/prediction-learn';
import { fmtPrice } from '../lib/utils/format';
import * as styles from './prediction-book-panel.css';

function fmtTime(iso: string): string {
    try {
        return new Date(iso).toLocaleString('zh-TW', {
            hour12: false,
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
        });
    } catch {
        return iso;
    }
}

function statusTone(status: PredictionStatus | undefined): string {
    switch (status) {
        case 'hit_tp':
        case 'win':
            return styles.badgeWin;
        case 'hit_sl':
        case 'loss':
            return styles.badgeLoss;
        case 'flat':
            return styles.badgeFlat;
        default:
            return styles.badgeOpen;
    }
}

function pnlText(v: number): string {
    return `${v > 0 ? '+' : ''}${v}%`;
}

function bucketTone(delta: number): string {
    if (delta > 0) return styles.learnGood;
    if (delta < 0) return styles.learnBad;
    return styles.learnNeutral;
}

function renderBucket(bucket: LearnBucket) {
    return (
        <div className={styles.learnRow} key={bucket.key}>
            <div className={styles.learnTop}>
                <span className={styles.learnName}>
                    {bucket.label.replace(/^當沖·|^隔夜·/, '')}
                    {bucket.muted ? ' · 暫汰' : ''}
                </span>
                <span className={`${styles.learnDelta} ${bucketTone(bucket.delta)}`}>
                    {bucket.delta > 0 ? '+' : ''}
                    {bucket.delta}
                </span>
            </div>
            <div className={styles.learnMeta}>
                <span>{bucket.n} 筆</span>
                <span>命中 {bucket.hitRate}%</span>
                <span>均報酬 {pnlText(bucket.avgPnl)}</span>
                {bucket.muted && bucket.muteReason && (
                    <span className={styles.learnBad}>{bucket.muteReason}</span>
                )}
                {!bucket.muted &&
                    bucket.recentN != null &&
                    bucket.recentN > 0 && (
                        <span>
                            近{bucket.recentN}命中 {bucket.recentHitRate ?? 0}%
                        </span>
                    )}
            </div>
        </div>
    );
}

export function PredictionBookPanel({
    rows,
    onClear,
    onVerify,
    verifying = false,
}: {
    rows: PredictionRecord[];
    onClear: () => void;
    onVerify?: () => void | Promise<void>;
    verifying?: boolean;
}) {
    const stats = predictionStats(rows);
    const learn = buildLearnModel(rows);
    const avgRR =
        stats.total === 0
            ? 0
            : rows.reduce((sum, r) => sum + r.rr, 0) / stats.total;
    const intraday = rows.filter((r) => r.mode === 'intraday').length;
    const overnight = stats.total - intraday;
    const topGood = [...learn.tags]
        .filter((t) => t.delta > 0 && !t.muted)
        .slice(0, 3);
    const topBad = [...learn.tags]
        .filter((t) => t.delta < 0 && !t.muted)
        .slice(0, 3);
    const muted = learn.muted.slice(0, 4);

    return (
        <div className={styles.wrap}>
            <div className={styles.stats}>
                <div className={styles.statBox}>
                    <div className={styles.statLabel}>總筆數</div>
                    <div className={styles.statValue}>{stats.total}</div>
                </div>
                <div className={styles.statBox}>
                    <div className={styles.statLabel}>已驗證</div>
                    <div className={styles.statValue}>
                        {stats.settled}
                        <span className={styles.statSub}>/{stats.open} 待</span>
                    </div>
                </div>
                <div className={styles.statBox}>
                    <div className={styles.statLabel}>命中率</div>
                    <div className={styles.statValue}>
                        {stats.hitRate == null ? '—' : `${stats.hitRate}%`}
                    </div>
                </div>
                <div className={styles.statBox}>
                    <div className={styles.statLabel}>平均報酬</div>
                    <div className={styles.statValue}>
                        {stats.avgPnl == null
                            ? '—'
                            : `${stats.avgPnl > 0 ? '+' : ''}${stats.avgPnl}%`}
                    </div>
                </div>
                <div className={styles.statBox}>
                    <div className={styles.statLabel}>平均 RR</div>
                    <div className={styles.statValue}>{avgRR.toFixed(2)}</div>
                </div>
                <div className={styles.statBox}>
                    <div className={styles.statLabel}>當沖 / 隔夜</div>
                    <div className={styles.statValue}>
                        {intraday}/{overnight}
                    </div>
                </div>
            </div>

            <div className={styles.actions}>
                {onVerify && (
                    <button
                        type="button"
                        className={styles.verifyBtn}
                        disabled={verifying}
                        onClick={() => void onVerify()}
                    >
                        {verifying ? '驗證中…' : '驗證待結算'}
                    </button>
                )}
                <button type="button" className={styles.clearBtn} onClick={onClear}>
                    清空布局本
                </button>
            </div>

            <div className={styles.learnPanel}>
                <div className={styles.learnHeader}>
                    <div>
                        <div className={styles.learnTitle}>學習看板</div>
                        <div className={styles.learnHint}>
                            {learn.ready
                                ? `已用 ${learn.settled} 筆已驗證紀錄做微調${
                                      muted.length
                                          ? `；暫汰 ${muted.length} 個條件`
                                          : ''
                                  }`
                                : `樣本不足，已驗證 ${learn.settled} 筆`}
                        </div>
                    </div>
                </div>
                <div className={styles.learnGrid}>
                    <div className={styles.learnCard}>
                        <div className={styles.learnCardTitle}>最近加分條件</div>
                        {topGood.length > 0 ? (
                            topGood.map(renderBucket)
                        ) : (
                            <div className={styles.learnEmpty}>目前沒有明顯加分條件</div>
                        )}
                    </div>
                    <div className={styles.learnCard}>
                        <div className={styles.learnCardTitle}>最近扣分條件</div>
                        {topBad.length > 0 ? (
                            topBad.map(renderBucket)
                        ) : (
                            <div className={styles.learnEmpty}>目前沒有明顯扣分條件</div>
                        )}
                    </div>
                    <div className={`${styles.learnCard} ${styles.learnMuteCard}`}>
                        <div className={styles.learnCardTitle}>暫時淘汰</div>
                        {muted.length > 0 ? (
                            muted.map(renderBucket)
                        ) : (
                            <div className={styles.learnEmpty}>
                                近況尚可，沒有被暫汰的條件
                            </div>
                        )}
                    </div>
                </div>
            </div>

            <div className={styles.body}>
                {rows.length === 0 && (
                    <div className={styles.empty}>
                        還沒有紀錄。跑一次「智能篩選」會自動記入前 10
                        名；也可手動「加入布局」。
                    </div>
                )}
                {rows.map((row) => (
                    <div className={styles.row} key={row.id}>
                        <div className={styles.top}>
                            <span className={styles.code}>
                                {row.code} {row.name}
                            </span>
                            <span
                                className={`${styles.badge} ${statusTone(row.status)}`}
                            >
                                {statusLabel(row.status)}
                                {row.pnlPct != null
                                    ? ` ${row.pnlPct > 0 ? '+' : ''}${row.pnlPct}%`
                                    : ''}
                            </span>
                        </div>
                        <div className={styles.meta}>
                            <span>{fmtTime(row.createdAt)}</span>
                            <span>{modeLabel(row.mode)}</span>
                            <span>
                                {row.source === 'auto_scan' ? '自動' : '手動'}
                            </span>
                            {row.signalDate && (
                                <span>訊號 {row.signalDate}</span>
                            )}
                            <span>進場 {fmtPrice(row.close)}</span>
                            {row.exitPrice != null && (
                                <span>出場 {fmtPrice(row.exitPrice)}</span>
                            )}
                            <span>停損 {row.stopLossPct}%</span>
                            <span>目標 {row.takeProfitPct}%</span>
                            {row.settleNote && (
                                <span>{row.settleNote}</span>
                            )}
                        </div>
                        <div className={styles.notes}>
                            {row.pickedConditions.map((c) => (
                                <span key={c} className={styles.note}>
                                    {c}
                                </span>
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
