import type { PredictionRecord } from '../lib/prediction-book';
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

export function PredictionBookPanel({
    rows,
    onClear,
}: {
    rows: PredictionRecord[];
    onClear: () => void;
}) {
    const total = rows.length;
    const avgRR =
        total === 0 ? 0 : rows.reduce((sum, r) => sum + r.rr, 0) / total;
    const daytrade = rows.filter((r) => r.mode === 'daytrade').length;
    const swing = total - daytrade;

    return (
        <div className={styles.wrap}>
            <div className={styles.stats}>
                <div className={styles.statBox}>
                    <div className={styles.statLabel}>總筆數</div>
                    <div className={styles.statValue}>{total}</div>
                </div>
                <div className={styles.statBox}>
                    <div className={styles.statLabel}>平均 RR</div>
                    <div className={styles.statValue}>{avgRR.toFixed(2)}</div>
                </div>
                <div className={styles.statBox}>
                    <div className={styles.statLabel}>當沖</div>
                    <div className={styles.statValue}>{daytrade}</div>
                </div>
                <div className={styles.statBox}>
                    <div className={styles.statLabel}>波段</div>
                    <div className={styles.statValue}>{swing}</div>
                </div>
            </div>

            <button className={styles.clearBtn} onClick={onClear}>
                清空預測本
            </button>

            <div className={styles.body}>
                {rows.length === 0 && (
                    <div className={styles.empty}>
                        還沒有紀錄。請在「策略篩選器」按「我打算買」。
                    </div>
                )}
                {rows.map((row) => (
                    <div className={styles.row} key={row.id}>
                        <div className={styles.top}>
                            <span className={styles.code}>
                                {row.code} {row.name}
                            </span>
                            <span>
                                RR {row.rr.toFixed(2)} / {row.mode === 'daytrade' ? '當沖' : '波段'}
                            </span>
                        </div>
                        <div className={styles.meta}>
                            <span>{fmtTime(row.createdAt)}</span>
                            <span>價位 {row.close.toFixed(2)}</span>
                            <span>停損 {row.stopLossPct}%</span>
                            <span>停利 {row.takeProfitPct}%</span>
                            <span>命中 {row.softHitCount}</span>
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

