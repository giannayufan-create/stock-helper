// server/src/config.ts

export type MarketProviderName = 'mock' | 'fugle' | 'shioaji';
export type TradeProviderName = 'mock' | 'fubon' | 'nova';

export interface Config {
    port: number;
    host: string;
    marketProvider: MarketProviderName;
    /** Explicit cloud flag: SHIOAJI_ENABLED=true → prefer 永豐行情 */
    shioajiEnabled: boolean;
    tradeProvider: TradeProviderName;
    fugleApiKey: string;
    shioajiApiKey: string;
    shioajiSecretKey: string;
    shioajiBridgeUrl: string;
    geminiApiKey: string;
    analyzerUrl: string;
    finmindToken: string;
    broker: {
        idNo: string;
        password: string;
        certPath: string;
        certPass: string;
    };
}

function pick<T extends string>(
    value: string | undefined,
    allowed: readonly T[],
    fallback: T,
): T {
    if (value && (allowed as readonly string[]).includes(value)) {
        return value as T;
    }
    if (value) {
        throw new Error(
            `invalid provider "${value}" — expected one of: ${allowed.join(', ')}`,
        );
    }
    return fallback;
}

function truthy(v: string | undefined): boolean {
    if (!v) return false;
    const s = v.trim().toLowerCase();
    return (
        s === '1' ||
        s === 'true' ||
        s === 'yes' ||
        s === 'on' ||
        s === 'shioaji' // allow SHIOAJI_ENABLED=shioaji
    );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
    const shioajiApiKey = env.SHIOAJI_API_KEY ?? env.SJ_API_KEY ?? '';
    const shioajiSecretKey = env.SHIOAJI_SECRET_KEY ?? env.SJ_SEC_KEY ?? '';
    const shioajiEnabled =
        truthy(env.SHIOAJI_ENABLED) ||
        // auto: keys present + no conflicting preference against
        (Boolean(shioajiApiKey && shioajiSecretKey) &&
            truthy(env.SHIOAJI_AS_PRIMARY));

    let marketProvider = pick(
        env.MARKET_PROVIDER,
        ['mock', 'fugle', 'shioaji'],
        'mock',
    );
    // New name preferred: SHIOAJI_ENABLED=true (does not require changing MARKET_PROVIDER)
    if (shioajiEnabled && shioajiApiKey && shioajiSecretKey) {
        marketProvider = 'shioaji';
    }

    return {
        port: Number(env.PORT) || 8787,
        host: env.HOST || '0.0.0.0',
        marketProvider,
        shioajiEnabled,
        tradeProvider: pick(
            env.TRADE_PROVIDER,
            ['mock', 'fubon', 'nova'],
            'mock',
        ),
        fugleApiKey: env.FUGLE_API_KEY ?? '',
        shioajiApiKey,
        shioajiSecretKey,
        shioajiBridgeUrl:
            env.SHIOAJI_BRIDGE_URL?.replace(/\/$/, '') ||
            'http://127.0.0.1:18080',
        geminiApiKey: env.GEMINI_API_KEY ?? '',
        analyzerUrl: (env.ANALYZER_URL ?? '').replace(/\/$/, ''),
        finmindToken: (env.FINMIND_TOKEN ?? env.FINMIND_API_TOKEN ?? '').trim(),
        broker: {
            idNo: env.BROKER_ID_NO ?? '',
            password: env.BROKER_PASSWORD ?? '',
            certPath: env.BROKER_CERT_PATH ?? '',
            certPass: env.BROKER_CERT_PASS ?? '',
        },
    };
}
