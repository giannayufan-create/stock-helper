// Minimal store-only ZIP (no compression) — observe/report packaging only.
// Avoids adding archiver/jszip dependency.

import { deflateRawSync } from 'node:zlib';

function crc32(buf: Buffer): number {
    let c = ~0;
    for (let i = 0; i < buf.length; i++) {
        c ^= buf[i]!;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
        }
    }
    return ~c >>> 0;
}

function u16(n: number): Buffer {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(n >>> 0, 0);
    return b;
}

function u32(n: number): Buffer {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n >>> 0, 0);
    return b;
}

export interface ZipEntry {
    name: string;
    data: Buffer | string;
}

/** Build a ZIP buffer with DEFLATE (method 8) entries. */
export function buildZip(entries: ZipEntry[]): Buffer {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;

    for (const e of entries) {
        const nameBuf = Buffer.from(e.name, 'utf8');
        const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
        const compressed = deflateRawSync(raw);
        const crc = crc32(raw);
        const method = 8;

        const local = Buffer.concat([
            u32(0x04034b50),
            u16(20),
            u16(0),
            u16(method),
            u16(0),
            u16(0),
            u32(crc),
            u32(compressed.length),
            u32(raw.length),
            u16(nameBuf.length),
            u16(0),
            nameBuf,
            compressed,
        ]);

        const central = Buffer.concat([
            u32(0x02014b50),
            u16(20),
            u16(20),
            u16(0),
            u16(method),
            u16(0),
            u16(0),
            u32(crc),
            u32(compressed.length),
            u32(raw.length),
            u16(nameBuf.length),
            u16(0),
            u16(0),
            u16(0),
            u16(0),
            u32(0),
            u32(offset),
            nameBuf,
        ]);

        locals.push(local);
        centrals.push(central);
        offset += local.length;
    }

    const centralDir = Buffer.concat(centrals);
    const end = Buffer.concat([
        u32(0x06054b50),
        u16(0),
        u16(0),
        u16(entries.length),
        u16(entries.length),
        u32(centralDir.length),
        u32(offset),
        u16(0),
    ]);

    return Buffer.concat([...locals, centralDir, end]);
}
