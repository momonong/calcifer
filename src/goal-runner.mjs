import { mkdir } from 'node:fs/promises';
import { join, dirname, basename, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateTaskPlan } from './task-plan.mjs';
import { planAssignments } from './model-router.mjs';
import { runCollaboration, reopenRun } from './collaboration-runner.mjs';
import { createRunState, readRunState } from './run-state.mjs';
import { bindNpmRepoDefinition, verifyNpmRepoDefinition, verifyNpmRepoSnapshot } from './npm-repo-check.mjs';
import { bindJsonCliDefinition, verifyJsonCliDefinition } from './json-cli-check.mjs';
import { GoalRequestGate, MOCK_POLICY, MOCK_PROFILE, MODEL_ID } from './goal-request-gate.mjs';
import { installGoalBoundary, runSdkPhase } from './goal-sdk.mjs';
import { digest, hash, fail, pathList, secureRoot, snapshotWorkspace, readText, writeDurable } from './workspace-tools.mjs';
const provenance = Object.freeze({ kind: 'mock', actualModelRequests: 0, modelQuality: 'pending', liveCost: 'unknown' });
const knownBudgetStops = new Set(['PHASE_BUDGET_EXHAUSTED','GOAL_BUDGET_EXHAUSTED','GOAL_DISPATCH_WINDOW_EXHAUSTED']);
const settledPhase = evidence => evidence?.sdkSettled && evidence.toolsSettled && evidence.transportSettled && evidence.closed;
const safeCode = error => /^[A-Z_]+$/.test(error?.message) ? error.message : 'GOAL_FAILED';
async function authority(goal, host, plannerProfileId) {
  if (typeof goal !== 'string' || !goal.trim() || Buffer.byteLength(goal) > 2048) fail('INVALID_GOAL');
  if (!host || resolve(host.stateRoot ?? '') !== host.stateRoot) fail('CANONICAL_STATE_ROOT_REQUIRED');
  await secureRoot(host.sourceDir);
  if (typeof host.hostNodeBinary !== 'string' || !host.hostNodeBinary.startsWith('/') || !host.hostNodeBinary.endsWith('/node')) fail('HOST_NODE_BINARY_REQUIRED');
  if (host.stateRoot === host.sourceDir || host.stateRoot.startsWith(host.sourceDir + '/')) fail('STATE_ROOT_INSIDE_SOURCE');
  for (const key of ['sourceFiles', 'readPaths', 'allowedPaths']) pathList(host[key]);
  if (!host.readPaths.every(path => host.sourceFiles.includes(path)) || !host.allowedPaths.every(path => host.readPaths.includes(path))) fail('INVALID_HOST_SCOPE');
  const planner = host.profiles?.find(profile => profile.id === plannerProfileId);
  if (!planner || !planner.enabled || planner.mode !== 'mock' || planner.model !== MODEL_ID || !['opencode', 'pi'].includes(planner.framework)
    || host.authorization?.mode !== 'mock' || !host.authorization.allowedProfileIds.includes(plannerProfileId)) fail('PLANNER_PROFILE_NOT_AUTHORIZED');
  if (host.profiles.some(profile => profile.mode !== 'mock' || profile.model !== MODEL_ID)) fail('MOCK_MODEL_REQUIRED');
  if (!host.allowedCheckIds?.length || !host.finalCheckIds?.length || host.finalCheckIds.some(id => !host.allowedCheckIds.includes(id))) fail('INVALID_FINAL_CHECKS');
  const definitions = {};
  for (const id of host.allowedCheckIds) {
    const check = host.checks?.[id];
    if (check?.kind === 'node-npm-repo') { definitions[id] = await bindNpmRepoDefinition(check, host, host.hostNodeBinary); continue; }
    if (check?.kind === 'node-json-cli') {
      definitions[id] = await bindJsonCliDefinition(check, { ...host, maxOutputBytes: host.limits?.maxOutputBytes }, host.hostNodeBinary);
      continue;
    }
    if (check?.kind !== 'node-data') fail('NODE_DATA_CHECK_REQUIRED');
    const script = await readText(dirname(check.scriptPath), basename(check.scriptPath));
    definitions[id] = { ...check, scriptHash: script.hash };
  }
  const initial = await snapshotWorkspace(host.sourceDir, host.sourceFiles, { writablePaths: host.allowedPaths, limits: host.limits });
  for (const definition of Object.values(definitions)) if (definition.kind === 'node-npm-repo') verifyNpmRepoSnapshot(initial.manifest, definition);
  const descriptor = { kind: 'goal_request', goal };
  const hostScope = { sourceDir: host.sourceDir, stateRoot: host.stateRoot, sourceFiles: host.sourceFiles,
    readPaths: host.readPaths, allowedPaths: host.allowedPaths, allowedCheckIds: host.allowedCheckIds, finalCheckIds: host.finalCheckIds,
    definitions, profiles: host.profiles, authorization: host.authorization, limits: host.limits ?? {}, hostNodeBinary: host.hostNodeBinary, plannerProfileId };
  return { planner, descriptor, initial, hostScope, authorityHash: digest({ hostScope, policy: MOCK_POLICY, model: MOCK_PROFILE }) };
}
const plannerPrompt = (goal, host) => JSON.stringify({ role: 'planner', goal, immutableScope: { readPaths: host.readPaths, writePaths: host.allowedPaths, checkIds: host.allowedCheckIds },
  hostFinalChecks: host.finalCheckIds, maxTasks: 4, format: 'JSON only. Exact TaskPlan: {schemaVersion:1,goal:string,tasks:[{id,instruction,dependsOn,requiredCapabilities,writePaths,checkIds}]}. No other fields. At least one task; decompose only when useful. Paths/checks are proposals within host scope; never new authority.' });
export async function runGoal({ goal, host: originalHost, plannerProfileId, transport, signal, toolObserver }) {
  if (!process.versions.bun) fail('PINNED_BUN_HOST_REQUIRED');
  if (signal?.aborted) return { status: 'cancelled', provenance, actualModelRequests: 0, syntheticModelRequests: 0, integrationAccepted: false };
  const host = structuredClone(originalHost), authorized = await authority(goal, host, plannerProfileId);
  const state = await createRunState({ stateRoot: host.stateRoot, sourceDir: host.sourceDir, metadata: { kind: 'goal', stateRoot: host.stateRoot,
    plan: authorized.descriptor, planHash: digest(authorized.descriptor), authorityHash: authorized.authorityHash, hostScope: authorized.hostScope,
    initialManifest: authorized.initial.manifest, policy: MOCK_POLICY, startedAt: Date.now(), provenance } });
  const gate = new GoalRequestGate({ state, transport, signal }), phases = [];
  let inner, plan, status = 'failed', code, isolation, wireHash, wireBytes, knownWorkerStop;
  const phaseRun = async (identity, prompt, dispatch) => {
    const phase = gate.registerPhase(identity), id = randomUUID();
    await state.append({ type: 'intent', data: { id, kind: 'sdk', phaseId: phase.id, phase: phase.identity } });
    let evidence;
    try {
      evidence = await runSdkPhase({ gate, phase, prompt, dispatch, signal, directory: join(state.runDir, 'sdk', phase.id) });
      return evidence;
    } catch (error) { evidence = error.evidence; throw error; }
    finally {
      if (evidence) {
        const refusal = gate.failures.findLast(item => item.phaseId === phase.id && item.preDispatch && knownBudgetStops.has(item.code));
        if (evidence.code === 'SDK_NATIVE_NOT_SUCCESS' && refusal && !gate.unknown && settledPhase(evidence)
          && gate.pending.size === 0 && !(await gate.state()).unknown.length) evidence.preDispatchStop = refusal.code;
        phases.push(evidence);
        const file = `${phase.id}.json`; await writeDurable(join(state.runDir, 'native', file), JSON.stringify(evidence), true);
        if (!gate.unknown && settledPhase(evidence))
          await state.append({ type: 'completed', data: { id, nativeFile: file, nativeHash: digest(evidence), phaseId: phase.id } });
      }
    }
  };
  try {
    for (const directory of ['sdk', 'native', 'host']) await mkdir(join(state.runDir, directory), { mode: 0o700 });
    isolation = await installGoalBoundary(gate, join(state.runDir, 'host'));
    const proposed = await phaseRun({ kind: 'planner', taskId: 'planner', framework: authorized.planner.framework, profileId: plannerProfileId, model: MODEL_ID }, plannerPrompt(goal, host));
    plan = validateTaskPlan(JSON.parse(proposed.text), host);
    const assignments = planAssignments(plan, host.profiles, host.authorization);
    if (assignments.status !== 'assigned') fail('UNROUTABLE_PLAN');
    await writeDurable(join(state.runDir, 'planner-result.json'), JSON.stringify(plan), true);
    const id = randomUUID(); await state.append({ type: 'intent', data: { id, kind: 'inner', planHash: digest(plan) } });
    inner = await runCollaboration({ plan, host: { ...host, stateRoot: join(state.runDir, 'inner-state'), workerTimeoutMs: 10000 }, signal,
      worker: async context => {
        const profile = host.profiles.find(item => item.id === context.profileId);
        const prompt = JSON.stringify({ role: 'worker', goal, task: context.task,
          dependencyFacts: context.task.dependsOn.map(taskId => ({ taskId, status: 'host-accepted' })),
          hostFinalChecks: host.finalCheckIds, budget: { ...MOCK_POLICY, alreadyAdmitted: (await gate.state()).requests },
          scope: { readPaths: host.readPaths, writePaths: context.task.writePaths, checkIds: context.task.checkIds }, acceptance: 'Host fixed checks only: node-data reads file contents; node-json-cli compares complete CLI JSON output for fixed host cases. node-npm-repo observes fixed npm test plus same-snapshot host JSON cases; unit-test assertion execution is not attested. General project/test-framework support remains pending.' });
        try { await phaseRun({ kind: 'worker', taskId: context.task.id, framework: profile.framework, profileId: profile.id, model: MODEL_ID }, prompt,
          async input => {
            const result = await context.tools.dispatch(input);
            if (toolObserver) await toolObserver({ taskId: context.task.id, input, result });
            return result;
          }); } catch (error) {
          // Only a proven host pre-dispatch budget refusal may become a known M2 failure.
          if (error.evidence?.preDispatchStop && !gate.unknown && settledPhase(error.evidence) && gate.pending.size === 0) {
            context.tools.seal();
            try { await context.tools.drain(); } catch (drainError) { gate.markUnknown('TOOL_OUTCOME_UNKNOWN'); throw drainError; }
            if (!gate.unknown && !(await gate.state()).unknown.length) { knownWorkerStop = error.evidence.preDispatchStop; return { status: 'failed' }; }
          }
          throw error;
        }
        if (gate.unknown) throw new Error('SDK_TASK_OUTCOME_UNKNOWN');
        return { status: 'completed' };
      } });
    if (inner.status !== 'unknown') await state.append({ type: 'completed', data: { id, innerRunID: inner.runID, innerStatus: inner.status, finalManifestHash: inner.finalManifestHash } });
    status = inner.status; code = inner.status === 'failed' && knownWorkerStop ? knownWorkerStop : inner.code;
  } catch (error) { code = safeCode(error); status = gate.unknown ? 'unknown' : signal?.aborted ? 'cancelled' : 'failed'; }
  const budget = await gate.state(), saved = await readRunState({ stateRoot: host.stateRoot, runID: state.metadata.runID });
  if (saved.unknown.length || gate.unknown || inner?.status === 'unknown') status = 'unknown';
  const wire = { requests: gate.wire, requestFailures: gate.failures, phases, isolation }, wireSource = JSON.stringify(wire);
  if (Buffer.byteLength(wireSource) > 4194304) { status = 'unknown'; code = 'SYNTHETIC_WIRE_BYTE_LIMIT'; }
  else { await writeDurable(join(state.runDir, 'synthetic-wire.json'), wireSource, true); wireHash = hash(wireSource); wireBytes = Buffer.byteLength(wireSource); }
  const phaseSummary = [...gate.phases.values()].map(phase => {
    const observed = phases.find(item => item.phase === phase.identity);
    return observed ? { phase: observed.phase, sdkSettled: observed.sdkSettled, toolsSettled: observed.toolsSettled, transportSettled: observed.transportSettled, closed: observed.closed, code: observed.preDispatchStop ?? observed.code }
      : { phase: phase.identity, sdkSettled: false, toolsSettled: phase.tools.size === 0, transportSettled: phase.pending.size === 0, closed: false };
  });
  const acceptanceKinds = [...new Set(host.finalCheckIds.map(id => host.checks[id].kind))];
  const report = { schemaVersion: 1, kind: 'goal', runID: state.metadata.runID, runDir: state.runDir, status, ...(code ? { code } : {}), provenance,
    acceptanceKind: acceptanceKinds.length === 1 ? acceptanceKinds[0] : 'mixed', runtimeCorrectness: acceptanceKinds.includes('node-npm-repo') ? 'fixed_npm_command_and_json_cli_cases_only' : acceptanceKinds.includes('node-json-cli') ? 'fixed_json_cli_cases_only' : 'pending_implementation_verification', unitTestAssertions: 'not_attested', generalTestFrameworks: 'pending_implementation_verification', integrationAccepted: status === 'completed' && inner?.integrationAccepted === true,
    goal, plan, planHash: plan ? digest(plan) : undefined, authorityHash: authorized.authorityHash, inner,
    phases: phaseSummary,
    syntheticModelRequests: gate.wire.length, actualModelRequests: 0, requestAttempts: gate.attempted,
    requestCounts: { attempted: gate.attempted, admitted: budget.requests, dispatched: gate.wire.length, terminalConfirmed: gate.wire.filter(item => item.terminal).length },
    inputBytes: gate.wire.map(item => ({ request: item.bytes, context: item.contextBytes, system: item.systemBytes, tools: item.toolBytes })), reservedOutputTokens: budget.reservedOutputTokens,
    usage: 'unknown', liveCost: 'unknown', wireHash, wireBytes, policy: MOCK_POLICY,
    cancellation: { userStoppedWaiting: !!signal?.aborted, sdk: phaseSummary.every(item => item.sdkSettled && item.closed) ? 'settled' : 'unknown',
      tools: phaseSummary.every(item => item.toolsSettled) && inner?.cancellation.tools !== 'unknown' ? 'settled' : 'unknown',
      syntheticStream: gate.wire.every(item => item.terminal?.streamDrained) ? 'drained' : 'unknown', remoteInference: 'not_applicable' } };
  let finished = false;
  try { await state.finish(report); finished = true; return report; }
  finally { await state.release(finished && status !== 'unknown'); }
}
export async function reopenGoal(options) {
  const state = await readRunState(options), metadata = state.metadata;
  if (metadata.kind !== 'goal' || metadata.plan.kind !== 'goal_request' || digest(metadata.policy) !== digest(MOCK_POLICY)) fail('GOAL_IDENTITY_MISMATCH');
  const expectedAuthority = digest({ hostScope: metadata.hostScope, policy: MOCK_POLICY, model: MOCK_PROFILE });
  if (metadata.authorityHash !== expectedAuthority) fail('GOAL_AUTHORITY_MISMATCH');
  const source = await snapshotWorkspace(metadata.hostScope.sourceDir, metadata.hostScope.sourceFiles, { limits: metadata.hostScope.limits });
  if (source.manifest.hash !== metadata.initialManifest.hash) fail('SOURCE_CHANGED');
  for (const definition of Object.values(metadata.hostScope.definitions)) {
    if (definition.kind === 'node-npm-repo') { await verifyNpmRepoDefinition(definition); continue; }
    if (definition.kind === 'node-json-cli') { await verifyJsonCliDefinition(definition); continue; }
    if (definition.kind !== 'node-data' || (await readText(dirname(definition.scriptPath), basename(definition.scriptPath))).hash !== definition.scriptHash) fail('CHECK_DEFINITION_CHANGED');
  }
  for (const event of state.events.filter(item => item.type === 'completed' && item.data.nativeFile))
    if (hash((await readText(join(state.runDir, 'native'), event.data.nativeFile, { limits: { maxFileBytes: 2097152 } })).content) !== event.data.nativeHash) fail('SDK_EVIDENCE_CHANGED');
  if (state.report?.wireHash) {
    const wire = await readText(state.runDir, 'synthetic-wire.json', { limits: { maxFileBytes: 4194304 } });
    if (wire.hash !== state.report.wireHash || wire.bytes !== state.report.wireBytes) fail('WIRE_EVIDENCE_CHANGED');
  }
  if (state.report?.plan && digest(state.report.plan) !== state.report.planHash) fail('PLANNER_EVIDENCE_CHANGED');
  if (state.report?.inner?.runID) {
    const inner = await reopenRun({ stateRoot: join(state.runDir, 'inner-state'), runID: state.report.inner.runID });
    if (inner.status !== state.report.inner.status || digest(inner.report) !== digest(state.report.inner)) fail('INNER_EVIDENCE_CHANGED');
  }
  return { ...state.report, status: state.status, reopenedWithoutSDK: true, unknown: state.unknown };
}
