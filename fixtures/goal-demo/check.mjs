import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
// Trusted host predicate. Snapshot strings are data and never executed.
const input = JSON.parse(await readFile('/input/snapshot.json', 'utf8'));
assert.equal(input.files['note.txt'], 'draft\nfirst\nsecond\n');
