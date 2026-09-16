// server/src/lib/research-persistence/cutover.test.ts
// Run: npx tsx src/lib/research-persistence/cutover.test.ts

import assert from 'node:assert/strict';
import {
    loadResearchPersistenceConfig,
    missingFirebaseCredentialNames,
} from './config.ts';

let passed = 0;
function pass(name: string) {
    passed++;
    console.log(`PASS ${name}`);
}

{
    const cfg = loadResearchPersistenceConfig({
        RESEARCH_REPOSITORY: 'dual',
        RESEARCH_REPOSITORY_MODE: 'jsonl',
    } as NodeJS.ProcessEnv);
    assert.equal(cfg.env_conflict, true);
    assert.equal(cfg.configured_mode, 'dual');
    assert.equal(cfg.mode, 'jsonl'); // fail-safe
    pass('CUT-env — conflict fail-safe to jsonl');
}

{
    const cfg = loadResearchPersistenceConfig({
        RESEARCH_REPOSITORY_MODE: 'dual',
    } as NodeJS.ProcessEnv);
    assert.equal(cfg.used_legacy_alias, true);
    assert.equal(cfg.configured_mode, 'dual');
    assert.equal(cfg.mode, 'dual');
    pass('CUT-env — legacy alias RESEARCH_REPOSITORY_MODE');
}

{
    const cfg = loadResearchPersistenceConfig({
        RESEARCH_REPOSITORY: 'firestore',
    } as NodeJS.ProcessEnv);
    assert.equal(cfg.configured_mode, 'firestore');
    assert.equal(cfg.mode, 'firestore');
    assert.equal(cfg.env_conflict, false);
    pass('CUT-env — canonical RESEARCH_REPOSITORY');
}

{
    const missing = missingFirebaseCredentialNames({});
    assert.ok(missing.includes('FIREBASE_PROJECT_ID'));
    assert.ok(missing.includes('FIREBASE_CLIENT_EMAIL'));
    assert.ok(missing.includes('FIREBASE_PRIVATE_KEY'));
    pass('CUT-env — missing credential names listed (no values)');
}

console.log(`\ncutover.test.ts ${passed} passed`);
