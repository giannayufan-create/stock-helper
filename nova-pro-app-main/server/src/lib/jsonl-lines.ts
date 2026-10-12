import { closeSync, openSync, readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

/**
 * Read a JSONL file in 1MB chunks so memory stays bounded by line size, not file
 * size (a whole multi-MB file with CJK text becomes a 2-byte string plus a split copy).
 * Return false from onLine to stop early.
 */
export function forEachJsonlLine(
    file: string,
    onLine: (line: string) => boolean | void,
): void {
    const fd = openSync(file, 'r');
    const buf = Buffer.allocUnsafe(1 << 20);
    const decoder = new StringDecoder('utf8');
    let rest = '';
    try {
        for (;;) {
            const n = readSync(fd, buf, 0, buf.length, null);
            if (n === 0) break;
            const lines = (rest + decoder.write(buf.subarray(0, n))).split(/\r?\n/);
            rest = lines.pop() ?? '';
            for (const line of lines) {
                if (line && onLine(line) === false) return;
            }
        }
        rest += decoder.end();
        if (rest) onLine(rest);
    } finally {
        closeSync(fd);
    }
}
