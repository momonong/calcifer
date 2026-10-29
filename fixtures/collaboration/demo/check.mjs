import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Trusted host check: snapshot contents remain data; never eval/import them.
const snapshot = JSON.parse(await readFile('/input/snapshot.json', 'utf8'));
assert.equal(snapshot.files['note.txt'], 'draft\nfirst\nsecond\n');
console.log('synthetic dependent data verified');
