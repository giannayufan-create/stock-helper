// server/src/runtime-config.test.ts
// Run: npx tsx src/runtime-config.test.ts

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeConfigStore } from './runtime-config.ts';

const dir = mkdtempSync(join(tmpdir(), 'runtime-config-'));
try {
    const file = join(dir, 'config.json');
    writeFileSync(
        file,
        JSON.stringify({ marketProvider: 'shioaji', fugleApiKey: 'old-saved' }),
    );

    const withEnv = new RuntimeConfigStore(file, { fugleApiKey: 'new-env' });
    assert.equal(withEnv.get().fugleApiKey, 'new-env');
    assert.equal(withEnv.get().marketProvider, 'shioaji');
    console.log('PASS env_key_wins_over_saved_key');

    const noEnv = new RuntimeConfigStore(file, { fugleApiKey: '' });
    assert.equal(noEnv.get().fugleApiKey, 'old-saved');
    console.log('PASS saved_key_used_when_env_empty');
} finally {
    rmSync(dir, { recursive: true, force: true });
}

console.log('\nOK 2 tests');
