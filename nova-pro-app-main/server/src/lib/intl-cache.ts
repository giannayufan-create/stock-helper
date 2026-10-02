// server/src/lib/intl-cache.ts

/**
 * Constructing an Intl.DateTimeFormat costs ~0.1ms of CPU and leaves native
 * ICU memory that RSS never gives back. Hot paths format dates thousands of
 * times per minute, so every formatter must be built once and reused.
 */
const cache = new Map<string, Intl.DateTimeFormat>();

export function dateTimeFormat(
    locale: string,
    options: Intl.DateTimeFormatOptions = {},
): Intl.DateTimeFormat {
    const key = `${locale}|${JSON.stringify(options)}`;
    let fmt = cache.get(key);
    if (!fmt) {
        fmt = new Intl.DateTimeFormat(locale, options);
        cache.set(key, fmt);
    }
    return fmt;
}
