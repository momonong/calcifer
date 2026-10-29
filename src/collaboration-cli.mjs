import { readFile } from 'node:fs/promises';
import { validateTaskPlan } from './task-plan.mjs';
import { planAssignments } from './model-router.mjs';

const fail = code => { throw new Error(code); };
const provenance = { kind: 'mock', modelRequests: 0, executesTasks: false };

async function main(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!['--plan', '--registry'].includes(key) || options.has(key) || !value || value.startsWith('--')) fail('USAGE: --plan <plan.json> --registry <mock-registry.json>');
    options.set(key, value);
  }
  if (options.size !== 2) fail('USAGE: --plan <plan.json> --registry <mock-registry.json>');
  const readJson = async path => {
    let source;
    try { source = await readFile(path, 'utf8'); } catch { fail('INPUT_READ_FAILED'); }
    try { return JSON.parse(source); } catch { fail('INVALID_JSON'); }
  };
  const plan = await readJson(options.get('--plan'));
  const registry = await readJson(options.get('--registry'));
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)
    || Object.keys(registry).some(key => !['schemaVersion', 'kind', 'allowedPaths', 'allowedCheckIds', 'profiles', 'authorization'].includes(key))) fail('UNKNOWN_REGISTRY_FIELD');
  if (registry.schemaVersion !== 1) fail('INVALID_REGISTRY_SCHEMA_VERSION');
  if (registry.kind !== 'mock' || !Array.isArray(registry.profiles) || registry.profiles.some(profile => profile?.mode !== 'mock')) fail('MOCK_REGISTRY_REQUIRED');
  const validated = validateTaskPlan(plan, { allowedPaths: registry.allowedPaths, allowedCheckIds: registry.allowedCheckIds });
  const result = planAssignments(validated, registry.profiles, registry.authorization);
  process.stdout.write(JSON.stringify({ schemaVersion: 1, provenance, ...result }) + '\n');
  if (result.status === 'rejected') process.exitCode = 1;
}

try { await main(process.argv.slice(2)); }
catch (error) {
  process.stdout.write(JSON.stringify({ schemaVersion: 1, provenance, status: 'rejected',
    code: error.message }) + '\n');
  process.exitCode = 1;
}
