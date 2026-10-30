import { mkdir } from 'node:fs/promises';
import { join, dirname, basename, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateTaskPlan } from './task-plan.mjs';
import { planAssignments } from './model-router.mjs';
import { createRunState, readRunState } from './run-state.mjs';
import { bindNpmRepoDefinition, runNpmRepoCheck, verifyNpmRepoDefinition, verifyNpmRepoEvidence, verifyNpmRepoSnapshot } from './npm-repo-check.mjs';
import { bindJsonCliDefinition, runNodeJsonCliCheck, verifyJsonCliDefinition, verifyJsonCliEvidence } from './json-cli-check.mjs';
import { runNodeDataCheck, nodeDataCheckProtocol, readNodeDataInput } from './sandbox-check.mjs';
import { hash, digest, fail, pathList, boundedLimits, secureRoot, readText, snapshotWorkspace,
  materializeSnapshot, diffSnapshots, applyArtifacts, createWorkspaceTools, writeDurable } from './workspace-tools.mjs';

const provenance = Object.freeze({ kind: 'mock', generations: 0, remoteInference: 'not_applicable' });
const ids = value => Array.isArray(value) && value.every(id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) && new Set(value).size === value.length;
async function prepare(host, input) {
  if (!host || typeof host !== 'object' || Object.keys(host).some(key => !['sourceDir', 'stateRoot', 'sourceFiles', 'readPaths', 'allowedPaths', 'allowedCheckIds', 'finalCheckIds', 'checks', 'profiles', 'authorization', 'limits', 'workerTimeoutMs', 'hostNodeBinary'].includes(key))) fail('INVALID_HOST_CONFIG');
  for (const key of ['sourceFiles', 'readPaths', 'allowedPaths', 'allowedCheckIds', 'finalCheckIds']) if (!Array.isArray(host[key])) fail('INVALID_HOST_CONFIG');
  const config = { ...host, sourceFiles: [...host.sourceFiles], readPaths: [...host.readPaths], allowedPaths: [...host.allowedPaths],
    allowedCheckIds: [...host.allowedCheckIds], finalCheckIds: [...host.finalCheckIds], profiles: structuredClone(host.profiles), authorization: structuredClone(host.authorization) };
  for (const values of [config.sourceFiles, config.readPaths, config.allowedPaths]) pathList(values);
  if (!config.sourceFiles.length || config.readPaths.some(path => !config.sourceFiles.includes(path)) || config.allowedPaths.some(path => !config.readPaths.includes(path))) fail('INVALID_HOST_SCOPE');
  if (!ids(config.allowedCheckIds) || !ids(config.finalCheckIds) || !config.finalCheckIds.length || config.finalCheckIds.some(id => !config.allowedCheckIds.includes(id))) fail('INVALID_FINAL_CHECKS');
  if (typeof config.stateRoot !== 'string' || resolve(config.stateRoot) !== config.stateRoot) fail('CANONICAL_STATE_ROOT_REQUIRED');
  await secureRoot(config.sourceDir);
  if (config.stateRoot === config.sourceDir || config.stateRoot.startsWith(config.sourceDir + '/')) fail('STATE_ROOT_INSIDE_SOURCE');
  config.limits = boundedLimits(config.limits);
  config.workerTimeoutMs ??= 1000;
  config.hostNodeBinary ??= !process.versions.bun && process.release?.name === 'node' ? process.execPath : undefined;
  if (!Number.isInteger(config.workerTimeoutMs) || config.workerTimeoutMs < 50 || config.workerTimeoutMs > 10000) fail('INVALID_WORKER_TIMEOUT');
  const plan = validateTaskPlan(input, config);
  const routes = planAssignments(plan, config.profiles, config.authorization);
  if (routes.status !== 'assigned') fail('UNROUTABLE_PLAN');
  if (!config.checks || typeof config.checks !== 'object' || Array.isArray(config.checks)
    || Object.keys(config.checks).some(id => !config.allowedCheckIds.includes(id))) fail('INVALID_CHECK_REGISTRY');
  const checks = {}, definitions = {};
  for (const id of config.allowedCheckIds) {
    const value = config.checks[id];
    if (!value || !['mock', 'node-data', 'node-json-cli', 'node-npm-repo'].includes(value.kind)) fail('INVALID_CHECK_DEFINITION');
    if (value.kind === 'node-npm-repo') {
      definitions[id] = await bindNpmRepoDefinition(value, config, config.hostNodeBinary);
      checks[id] = definitions[id]; continue;
    }
    if (value.kind === 'node-json-cli') {
      definitions[id] = await bindJsonCliDefinition(value, { ...config, maxOutputBytes: config.limits.maxOutputBytes }, config.hostNodeBinary);
      checks[id] = definitions[id]; continue;
    }
    const allowed = value.kind === 'mock' ? ['kind', 'definition', 'evaluate', 'timeoutMs'] : ['kind', 'scriptPath', 'timeoutMs', 'maxOutputBytes'];
    if (Object.keys(value).some(key => !allowed.includes(key))) fail('INVALID_CHECK_DEFINITION');
    const timeoutMs = value.timeoutMs ?? 1000, maxOutputBytes = value.maxOutputBytes ?? 8192;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 5000 || !Number.isInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > config.limits.maxOutputBytes) fail('INVALID_CHECK_LIMITS');
    if (value.kind === 'mock') {
      if (typeof value.evaluate !== 'function' || typeof value.definition !== 'string' || !value.definition.trim()) fail('INVALID_CHECK_DEFINITION');
      definitions[id] = { kind: 'mock', codeHash: hash(value.evaluate.toString()), definition: value.definition, timeoutMs };
      checks[id] = { ...value, timeoutMs };
    } else {
      if (!config.hostNodeBinary) fail('HOST_NODE_BINARY_REQUIRED');
      if (typeof value.scriptPath !== 'string' || resolve(value.scriptPath) !== value.scriptPath || !value.scriptPath.endsWith('.mjs')) fail('INVALID_CHECK_DEFINITION');
      const file = await readText(dirname(value.scriptPath), basename(value.scriptPath), { limits: config.limits });
      definitions[id] = { kind: 'node-data', scriptHash: file.hash, protocol: nodeDataCheckProtocol(), timeoutMs, maxOutputBytes };
      checks[id] = { kind: 'node-data', content: file.content, timeoutMs, maxOutputBytes };
    }
    definitions[id].definitionHash = digest(definitions[id]);
  }
  const initial = await snapshotWorkspace(config.sourceDir, config.sourceFiles, { writablePaths: config.allowedPaths, limits: config.limits });
  for (const definition of Object.values(definitions)) if (definition.kind === 'node-npm-repo') verifyNpmRepoSnapshot(initial.manifest, definition);
  const authority = { sourceDir: config.sourceDir, stateRoot: config.stateRoot, sourceFiles: config.sourceFiles,
    readPaths: config.readPaths, allowedPaths: config.allowedPaths, allowedCheckIds: config.allowedCheckIds,
    finalCheckIds: config.finalCheckIds, profiles: config.profiles, authorization: config.authorization,
    limits: config.limits, workerTimeoutMs: config.workerTimeoutMs, hostNodeBinary: config.hostNodeBinary, definitions };
  return { config, plan, routes, checks, definitions, initial, authorityHash: digest(authority) };
}
function bounded(promise, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let settled = false, timer;
    const finish = (callback, value) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort); callback(value);
    };
    const abort = () => finish(reject, new Error('WAIT_STOPPED_RESULT_UNKNOWN'));
    timer = setTimeout(() => finish(reject, new Error('DEADLINE_RESULT_UNKNOWN')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error));
  });
}

function topology(tasks) {
  const result = [], done = new Set();
  while (result.length < tasks.length) {
    const next = tasks.find(task => !done.has(task.id) && task.dependsOn.every(id => done.has(id)));
    if (!next) fail('CYCLIC_DEPENDENCY'); result.push(next); done.add(next.id);
  }
  return result;
}
export async function runCollaboration({ plan: input, host, worker, signal }) {
  if (typeof worker !== 'function') fail('HOST_WORKER_REQUIRED');
  if (signal?.aborted) return { schemaVersion: 1, status: 'cancelled', provenance, cancellation: { userStoppedWaiting: true, worker: 'not_dispatched', tools: 'not_started', streamDrain: 'not_applicable' } };
  const { config, plan, routes, checks, definitions, initial, authorityHash } = await prepare(host, input);
  const state = await createRunState({ stateRoot: config.stateRoot, sourceDir: config.sourceDir, metadata: {
    plan, planHash: digest(plan), authorityHash, assignments: routes.assignments, initialManifest: initial.manifest,
    sourceFiles: config.sourceFiles, allowedPaths: config.allowedPaths, finalCheckIds: config.finalCheckIds,
    definitions, provenance, limits: config.limits } });
  const { runID } = state.metadata, runDir = state.runDir, taskResults = [], checkResults = [];
  const integrationDir = join(runDir, 'integration'); let finalManifestHash, status = 'failed', code, currentTools;
  let workerActive = false, toolsSettled = true, acceptedArtifacts = [];
  const append = (type, data) => state.append({ type, data });
  const doCheck = async (workspaceDir, checkId) => {
    if (signal?.aborted) fail('CHECK_CANCELLED_BEFORE_DISPATCH');
    const definition = definitions[checkId], check = checks[checkId];
    if (!definition || !check) fail('CHECK_NOT_ALLOWED');
    const before = await snapshotWorkspace(workspaceDir, config.sourceFiles, { limits: config.limits, complete: true });
    const scriptPath = join(runDir, 'checks', `${checkId}.mjs`);
    if (check.kind === 'node-data' && (await readText(dirname(scriptPath), basename(scriptPath), { limits: config.limits })).hash !== definition.scriptHash) fail('CHECK_DEFINITION_CHANGED');
    const id = randomUUID();
    const inputSource = JSON.stringify({ schemaVersion: 1, manifest: before.manifest, files: before.contents });
    const inputHash = check.kind === 'node-data' ? hash(inputSource) : undefined;
    const inputFile = check.kind === 'node-data' ? `${id}.snapshot.json` : undefined;
    const entryFile = check.kind === 'node-json-cli' ? `${id}.entry.mjs` : undefined;
    const repoSnapshot = check.kind === 'node-npm-repo' ? `${id}.repo` : undefined;
    const inputPath = inputFile ? join(runDir, 'checks', inputFile) : undefined;
    await append('intent', { id, kind: 'check', checkId, manifestHash: before.manifest.hash, definitionHash: definition.definitionHash, inputHash });
    let result;
    if (check.kind === 'node-npm-repo') {
      const snapshotDir = join(runDir, 'checks', repoSnapshot);
      await materializeSnapshot(snapshotDir, before);
      try { result = await runNpmRepoCheck({ snapshotDir, definition, signal, journal: append }); }
      catch (error) { if (!error.known) throw error; result = { status: 'failed', code: error.message }; }
    } else if (check.kind === 'node-json-cli') {
      const entryPath = join(runDir, 'checks', entryFile);
      await writeDurable(entryPath, before.contents[definition.entryPath], true);
      try { result = await runNodeJsonCliCheck({ entryFile: entryPath, definition, sourceManifest: before.manifest, signal }); }
      catch (error) { if (!error.known) throw error; result = { status: 'failed', code: error.message }; }
    } else if (check.kind === 'node-data') {
      await writeDurable(inputPath, inputSource, true);
      try { result = await runNodeDataCheck({ inputPath, scriptPath, expectedInputHash: inputHash, expectedManifestHash: before.manifest.hash, timeoutMs: check.timeoutMs, maxOutputBytes: check.maxOutputBytes, signal, hostNodeBinary: config.hostNodeBinary, expectedProtocol: definition.protocol }); }
      catch (error) { if (!error.known) throw error; result = { status: 'failed', code: error.message }; }
    }
    else {
      const passed = await bounded(Promise.resolve().then(() => check.evaluate({ files: structuredClone(before.contents), workspaceDir })), check.timeoutMs, signal);
      result = { status: passed === true ? 'passed' : 'failed', code: passed === true ? 'CHECK_PASSED' : 'CHECK_FAILED' };
    }
    let after;
    try { after = await snapshotWorkspace(workspaceDir, config.sourceFiles, { limits: config.limits, complete: true }); }
    catch (error) { result = { status: 'failed', code: 'CHECK_MANIFEST_CHANGED' }; }
    if (after?.manifest.hash !== before.manifest.hash) result = { status: 'failed', code: 'CHECK_MANIFEST_CHANGED' };
    const evidence = { checkId, ...result, kind: check.kind, manifestHash: before.manifest.hash, definitionHash: definition.definitionHash, ...(inputHash ? { inputHash, inputFile } : {}), ...(entryFile ? { entryFile } : {}), ...(repoSnapshot ? { repoSnapshot } : {}) };
    checkResults.push(evidence); await append('completed', { id, resultHash: digest(evidence), evidence });
    if (result.code === 'CHECK_MANIFEST_CHANGED') fail('CHECK_MANIFEST_CHANGED');
    return evidence;
  };
  try {
    await materializeSnapshot(join(runDir, 'initial'), initial);
    await mkdir(join(runDir, 'tasks'), { mode: 0o700 }); await mkdir(join(runDir, 'checks'), { mode: 0o700 });
    for (const [id, check] of Object.entries(checks)) if (check.kind === 'node-data') await writeDurable(join(runDir, 'checks', `${id}.mjs`), check.content, true);
    const ordered = topology(plan.tasks), accepted = new Map();
    for (const task of ordered) {
      if (signal?.aborted) { status = 'cancelled'; code = 'CANCELLED_BEFORE_TASK'; break; }
      const ancestors = new Set();
      const collect = id => { for (const parent of plan.tasks.find(value => value.id === id).dependsOn) { if (!ancestors.has(parent)) { ancestors.add(parent); collect(parent); } } };
      collect(task.id);
      let baseline = initial;
      for (const earlier of ordered) if (ancestors.has(earlier.id)) baseline = applyArtifacts(baseline, accepted.get(earlier.id).artifacts, config.limits);
      const workspaceDir = join(runDir, 'tasks', task.id);
      await materializeSnapshot(workspaceDir, baseline);
      const assignment = routes.assignments.find(value => value.taskId === task.id), id = randomUUID();
      await append('intent', { id, kind: 'task', taskId: task.id, profileId: assignment.profileId, inputManifestHash: baseline.manifest.hash });
      const tools = createWorkspaceTools({ root: workspaceDir, sourceFiles: config.sourceFiles, readPaths: config.readPaths,
        writePaths: [...task.writePaths], checkIds: [...task.checkIds], check: checkId => doCheck(workspaceDir, checkId),
        journal: state.append, limits: config.limits });
      currentTools = tools; workerActive = true; toolsSettled = false;
      let observed;
      try {
        observed = await bounded(Promise.resolve().then(() => worker({ task: structuredClone(task), profileId: assignment.profileId,
          workspaceDir, tools, signal })), config.workerTimeoutMs, signal);
        workerActive = false;
      } finally { tools.seal(); }
      await bounded(tools.drain(), config.workerTimeoutMs + 200, undefined); toolsSettled = true;
      let output, artifacts;
      try {
        if (!observed || Object.keys(observed).length !== 1 || !['completed', 'failed'].includes(observed.status)) fail('WORKER_RESULT_INVALID');
        if (observed.status !== 'completed') fail('WORKER_REPORTED_FAILURE');
        output = await snapshotWorkspace(workspaceDir, config.sourceFiles, { writablePaths: task.writePaths, limits: config.limits, complete: true });
        artifacts = diffSnapshots(baseline, output, task.writePaths);
      } catch (error) {
        await append('completed', { id, failed: true, code: error.code === 'ENOENT' ? 'WORKSPACE_FILE_MISSING' : error.message });
        if (error.code === 'ENOENT') fail('WORKSPACE_FILE_MISSING'); throw error;
      }
      const result = { taskId: task.id, profileId: assignment.profileId, inputManifestHash: baseline.manifest.hash,
        outputManifestHash: output.manifest.hash, artifacts };
      accepted.set(task.id, result); taskResults.push(result);
      await append('completed', { id, resultHash: digest(result), taskResult: result });
      currentTools = null;
    }
    if (signal?.aborted) status = 'cancelled';
    if (status !== 'cancelled') {
      let integrated = initial;
      for (const result of taskResults) integrated = applyArtifacts(integrated, result.artifacts, config.limits);
      await materializeSnapshot(integrationDir, integrated); finalManifestHash = integrated.manifest.hash;
      for (const checkId of config.finalCheckIds) {
        const result = await doCheck(integrationDir, checkId);
        if (result.status !== 'passed') fail(result.code === 'CHECK_ISOLATION_UNAVAILABLE' ? result.code : 'FINAL_CHECK_FAILED');
      }
      const final = await snapshotWorkspace(integrationDir, config.sourceFiles, { limits: config.limits, complete: true });
      if (final.manifest.hash !== finalManifestHash) fail('FINAL_MANIFEST_CHANGED');
      const source = await snapshotWorkspace(config.sourceDir, config.sourceFiles, { limits: config.limits });
      if (source.manifest.hash !== initial.manifest.hash) fail('SOURCE_CHANGED');
      acceptedArtifacts = diffSnapshots(initial, final, config.allowedPaths);
      status = 'completed';
    }
  } catch (error) {
    code = /^[A-Z_]+$/.test(error.message) ? error.message : 'WORKER_OR_TOOL_FAILED';
    currentTools?.seal();
    if (currentTools) {
      try { await bounded(currentTools.drain(), config.workerTimeoutMs + 200, undefined); toolsSettled = true; } catch { toolsSettled = false; }
    }
    const persisted = await readRunState({ stateRoot: config.stateRoot, runID });
    status = persisted.unknown.length ? 'unknown' : signal?.aborted ? 'cancelled' : 'failed';
  }
  const report = { schemaVersion: 1, runID, runDir, integrationDir, status, ...(code ? { code } : {}), provenance,
    integrationAccepted: status === 'completed', initialManifestHash: initial.manifest.hash, finalManifestHash,
    taskResults, assignments: routes.assignments, checks: checkResults,
    artifacts: status === 'completed' ? acceptedArtifacts : [],
    cancellation: { userStoppedWaiting: !!signal?.aborted, worker: workerActive ? 'unknown' : 'completed', tools: toolsSettled ? 'settled' : 'unknown', streamDrain: 'not_applicable' } };
  let saved = false;
  try { await state.finish(report); saved = true; return report; }
  finally { await state.release(saved && status !== 'unknown'); }
}
export async function reopenRun(options) {
  const state = await readRunState(options), { metadata } = state;
  const initial = await snapshotWorkspace(join(state.runDir, 'initial'), metadata.sourceFiles, { limits: metadata.limits, complete: true });
  if (initial.manifest.hash !== metadata.initialManifest.hash) fail('EVIDENCE_MANIFEST_MISMATCH');
  for (const result of state.report?.taskResults ?? []) {
    const snapshot = await snapshotWorkspace(join(state.runDir, 'tasks', result.taskId), metadata.sourceFiles, { writablePaths: metadata.allowedPaths, limits: metadata.limits, complete: true });
    if (snapshot.manifest.hash !== result.outputManifestHash) fail('EVIDENCE_MANIFEST_MISMATCH');
  }
  if (state.status === 'completed') {
    const integrated = await snapshotWorkspace(join(state.runDir, 'integration'), metadata.sourceFiles, { limits: metadata.limits, complete: true });
    if (integrated.manifest.hash !== state.report.finalManifestHash || metadata.finalCheckIds.some(id => !state.report.checks.some(check => check.checkId === id && check.status === 'passed' && check.manifestHash === integrated.manifest.hash && check.definitionHash === metadata.definitions[id].definitionHash))) fail('EVIDENCE_MANIFEST_MISMATCH');
  }
  for (const definition of Object.values(metadata.definitions)) if (!['mock', 'node-data', 'node-json-cli', 'node-npm-repo'].includes(definition.kind)) fail('CHECK_KIND_UNSUPPORTED');
  for (const evidence of state.report?.checks ?? []) if (metadata.definitions[evidence.checkId]?.kind === 'node-data') {
    if (evidence.kind !== 'node-data' || !evidence.inputFile || !evidence.inputHash) fail('CHECK_INPUT_MISMATCH');
    await readNodeDataInput(join(state.runDir, 'checks', evidence.inputFile), { expectedInputHash: evidence.inputHash, expectedManifestHash: evidence.manifestHash });
  }
  for (const [id, definition] of Object.entries(metadata.definitions)) if (definition.kind === 'node-data') {
    if (!definition.protocol || digest(definition.protocol) !== digest(nodeDataCheckProtocol())) fail('CHECK_PROTOCOL_MISMATCH');
    if ((await readText(join(state.runDir, 'checks'), `${id}.mjs`, { limits: metadata.limits })).hash !== definition.scriptHash) fail('CHECK_DEFINITION_CHANGED');
  }
  for (const definition of Object.values(metadata.definitions)) if (definition.kind === 'node-json-cli') await verifyJsonCliDefinition(definition);
  for (const evidence of state.report?.checks ?? []) if (metadata.definitions[evidence.checkId]?.kind === 'node-json-cli') {
    const definition = metadata.definitions[evidence.checkId];
    verifyJsonCliEvidence(evidence, definition);
    if (!evidence.entryFile || (await readText(join(state.runDir,'checks'), evidence.entryFile)).hash !== evidence.entryHash) fail('CHECK_ENTRY_MISMATCH');
    const completion = state.events.find(event => event.type === 'completed' && event.data.evidence && digest(event.data.evidence) === digest(evidence));
    const intent = state.events.find(event => event.type === 'intent' && event.data.id === completion?.data.id);
    if (!completion || completion.data.resultHash !== digest(evidence) || intent?.data.manifestHash !== evidence.manifestHash || intent?.data.definitionHash !== definition.definitionHash) fail('CHECK_EVIDENCE_MISMATCH');
  }
  for (const definition of Object.values(metadata.definitions)) if (definition.kind === 'node-npm-repo') await verifyNpmRepoDefinition(definition);
  for (const evidence of state.report?.checks ?? []) if (metadata.definitions[evidence.checkId]?.kind === 'node-npm-repo') {
    const definition = metadata.definitions[evidence.checkId]; verifyNpmRepoEvidence(evidence, definition);
    for (const [stage, observation, caseId] of [['npm', evidence.npm], ...(evidence.oracle?.cases ?? []).map(item => ['oracle', item, item.id])]) {
      const completed = state.events.find(event => event.type === 'completed' && event.data.id === observation.intentId && event.data.repoStep);
      const intended = state.events.find(event => event.type === 'intent' && event.data.id === observation.intentId);
      const savedObservation = completed?.data.repoStep?.observation;
      if (!savedObservation || completed.data.resultHash !== digest(savedObservation) || completed.data.repoStep.stage !== stage || completed.data.repoStep.caseId !== caseId
        || intended?.data.kind !== 'repo-command' || intended.data.stage !== stage || intended.data.caseId !== caseId || intended.data.manifestHash !== evidence.manifestHash || intended.data.definitionHash !== definition.definitionHash || intended.data.inputHash !== hash(stage === 'npm' ? '' : JSON.stringify(definition.cases.find(item => item.id === caseId)?.input))
        || (stage === 'npm' ? digest(savedObservation) !== digest(observation) : Object.keys(savedObservation).some(key => digest(savedObservation[key]) !== digest(observation[key])))) fail('CHECK_STEP_EVIDENCE_MISMATCH');
    }

    if (!evidence.repoSnapshot || !evidence.emptyConfigFile) fail('CHECK_SNAPSHOT_MISSING');
    if ((await readText(join(state.runDir, 'checks'), evidence.emptyConfigFile, { anyExtension: true })).hash !== hash('')) fail('CHECK_CONFIG_CHANGED');
    const saved = await snapshotWorkspace(join(state.runDir, 'checks', evidence.repoSnapshot), definition.sourceFiles, { limits: metadata.limits, complete: true });
    if (saved.manifest.hash !== evidence.manifestHash) fail('CHECK_MANIFEST_MISMATCH');
    const completion = state.events.find(event => event.type === 'completed' && event.data.evidence && digest(event.data.evidence) === digest(evidence));
    const intent = state.events.find(event => event.type === 'intent' && event.data.id === completion?.data.id);
    if (!completion || completion.data.resultHash !== digest(evidence) || intent?.data.manifestHash !== evidence.manifestHash || intent?.data.definitionHash !== definition.definitionHash) fail('CHECK_EVIDENCE_MISMATCH');
  }
  return { status: state.status, metadata, report: state.report, unknown: state.unknown };
}
