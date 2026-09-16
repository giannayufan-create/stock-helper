import {
    CONFIRM_LAYER_LABEL,
    type ConfirmLayerKey,
    type ConfirmLayers,
} from './ui-context';
import { radarColor } from './tokens';
import { vars } from '../../theme.css';

const ORDER: ConfirmLayerKey[] = ['stock', 'sector', 'market', 'event'];

export function ConfirmLayersRow({
    layers,
    size = 'md',
}: {
    layers: ConfirmLayers;
    size?: 'sm' | 'md';
}) {
    const dot = size === 'sm' ? 8 : 10;
    const gap = size === 'sm' ? 10 : 14;
    return (
        <div
            style={{
                display: 'flex',
                alignItems: 'center',
                gap,
                flexWrap: 'wrap',
            }}
            aria-label="四層確認"
        >
            {ORDER.map((k) => {
                const on = layers[k];
                return (
                    <div
                        key={k}
                        style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 5,
                            minHeight: 28,
                        }}
                    >
                        <span
                            style={{
                                width: dot,
                                height: dot,
                                borderRadius: '50%',
                                background: on
                                    ? radarColor.strong
                                    : 'transparent',
                                border: on
                                    ? `1.5px solid ${radarColor.strong}`
                                    : `1.5px solid ${vars.color.borderBright}`,
                                boxShadow: on
                                    ? `0 0 8px ${radarColor.strongDim}`
                                    : 'none',
                            }}
                            aria-hidden
                        />
                        <span
                            style={{
                                fontSize: size === 'sm' ? 11 : 12,
                                fontWeight: 600,
                                color: on
                                    ? vars.color.foreground
                                    : vars.color.mutedForeground,
                            }}
                        >
                            {CONFIRM_LAYER_LABEL[k]}
                        </span>
                    </div>
                );
            })}
        </div>
    );
}
