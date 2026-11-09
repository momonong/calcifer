import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { GoalRequestGate, MOCK_POLICY, MODEL_ID } from './goal-request-gate.mjs';
import { installGoalBoundary, runSdkPhase } from './goal-sdk.mjs';
import { readMockScript, startP1Mock } from './p1-mock.mjs';
import { createRunState, readRunState } from './run-state.mjs';
import { digest, fail, hash, secureRoot, writeDurable } from './workspace-tools.mjs';
import { createResearchTools, RESEARCH_LIMITS, RESEARCH_TOOL_DESCRIPTION, RESEARCH_TOOL_SCHEMA } from './research-tools.mjs';
import { renderResearchReport } from './research-report.mjs';
import { startResearchFixture } from '../fixtures/research/http-fixture.mjs';

const profile = 'research-fixture';
const provenance = { kind: 'mock', model: 'scripted', tools: 'local-http-fixture' };
const codeOf = error => /^[A-Z][A-Z0-9_]+$/.test(error?.message) ? error.message : 'RESEARCH_FAILED';

function parseArgs(argv) {
  if (argv[0] !== 'run') fail('RESEARCH_RUN_REQUIRED');
  const values = new Map();
  const options = ['--question', '--profile', '--mock-script', '--output'];
  for (let i = 1; i < argv.length; i += 2) {
    const [flag, value] = argv.slice(i, i + 2);
    if (!options.includes(flag) || values.has(flag) || !value || value.startsWith('--')) fail('RESEARCH_INVALID_ARGUMENTS');
    values.set(flag, value);
  }
  if (values.size !== options.length) fail('RESEARCH_INVALID_ARGUMENTS');
  if (values.get('--profile') !== profile) fail('RESEARCH_FIXTURE_PROFILE_REQUIRED');
  const question = values.get('--question').trim();
  const output = values.get('--output');
  if (!question || Buffer.byteLength(question) > 2000 || question.includes('\0')) fail('RESEARCH_INVALID_QUESTION');
  if (resolve(output) !== output || dirname(output) === output) fail('RESEARCH_OUTPUT_ABSOLUTE_REQUIRED');
  return { question, output, mockScript: resolve(values.get('--mock-script')) };
}

async function runResearch({ question, output, mockScript, userSignal }) {
  if (!process.versions.bun) fail('PINNED_BUN_HOST_REQUIRED');
  const { script, scriptHash } = await readMockScript(mockScript);
  await secureRoot(dirname(output));
  try { await mkdir(output, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') fail('RESEARCH_OUTPUT_EXISTS');
    throw error;
  }
  const deadline = AbortSignal.timeout(RESEARCH_LIMITS.windowMs);
  const signal = AbortSignal.any([userSignal, deadline]);
  const plan = { kind: 'research-fixture', question, scriptHash };
  const state = await createRunState({
    stateRoot: output, sourceDir: output,
    metadata: { kind: 'research', stateRoot: output, plan, planHash: digest(plan),
      startedAt: Date.now(), policy: MOCK_POLICY, researchLimits: RESEARCH_LIMITS, provenance }
  });
  const { runID } = state.metadata;
  let model, fixture, gate, tools, sdk, markdown, boundary, code;
  let status = 'failed';
  try {
    fixture = await startResearchFixture({ runID });
    model = await startP1Mock({ runID, script });
    const nativeFetch = globalThis.fetch.bind(globalThis);
    gate = new GoalRequestGate({
      state, signal, endpoint: model.endpoint,
      transport: async ({ payload, signal: requestSignal }) => {
        const response = await nativeFetch(model.endpoint, {
          method: 'POST', body: JSON.stringify(payload), redirect: 'manual', signal: requestSignal,
          headers: { 'content-type': 'application/json', 'x-calcifer-mock-run': runID }
        });
        if (response.headers.get('x-calcifer-mock-run') !== runID) throw new Error('MOCK_HTTP_IDENTITY_MISMATCH');
        return response;
      }
    });
    boundary = await installGoalBoundary(gate, join(state.runDir, 'runtime'));
    const phase = gate.registerPhase({
      kind: 'worker', taskId: 'research', framework: 'opencode', profileId: profile, model: MODEL_ID
    });
    tools = createResearchTools({ state, fixture, fetch: nativeFetch, signal, admitted: () => phase.open && !gate.unknown });
    const prompt = [
      'Research question: ' + question,
      'Use search to discover sources. Read one original web page and query the one read-only MCP tool.',
      'Return JSON findings [{sourceId,excerpt}] and recommendation {text,sourceIds}.',
      'Copy short exact excerpts from the successful source records. Write the recommendation in Traditional Chinese.'
    ].join('\n');
    sdk = await runSdkPhase({
      gate, phase, prompt, signal, directory: join(state.runDir, 'sdk'),
      dispatch: tools.dispatch, toolSchema: RESEARCH_TOOL_SCHEMA, toolDescription: RESEARCH_TOOL_DESCRIPTION,
      modelBaseURL: new URL('/v1', model.endpoint).href, settlementMs: RESEARCH_LIMITS.windowMs
    });
    if (signal.aborted) fail('RESEARCH_STOPPED');
    if (gate.unknown || !sdk.sdkSettled || !sdk.transportSettled || !sdk.toolsSettled || !sdk.closed) {
      throw new Error('RESEARCH_SDK_OUTCOME_UNKNOWN');
    }
    const obtained = new Set(tools.sources.map(source => source.kind));
    if (!tools.calls.web_search || !obtained.has('web_fetch') || !obtained.has('mcp_read')) {
      fail('RESEARCH_EVIDENCE_INCOMPLETE');
    }
    markdown = renderResearchReport({ question, text: sdk.text, sources: tools.sources, runID });
    status = 'completed';
  } catch (error) {
    sdk ??= error.evidence;
    code = codeOf(error);
    status = userSignal.aborted ? 'cancelled' : 'failed';
  } finally {
    const closures = await Promise.allSettled([model?.close(), fixture?.close()]);
    if (closures.some(result => result.status === 'rejected')) {
      status = 'unknown';
      code = 'RESEARCH_FIXTURE_CLOSE_UNKNOWN';
    }
  }

  let terminalWritten = false;
  try {
    const saved = await readRunState({ stateRoot: output, runID });
    if (saved.unknown.length || gate?.unknown) {
      status = 'unknown';
      code = code ?? 'RESEARCH_UNSETTLED_INTENT';
    }
    if (status === 'completed' && signal.aborted) {
      status = userSignal.aborted ? 'cancelled' : 'failed';
      code = 'RESEARCH_STOPPED';
    }
    const sources = tools?.sources ?? [];
    const sourceRecord = JSON.stringify({ schemaVersion: 1, runID, provenance, sources }, null, 2) + '\n';
    await writeDurable(join(state.runDir, 'sources.json'), sourceRecord, true);
    const artifacts = [{ name: 'sources.json', sha256: hash(sourceRecord) }];
    if (status === 'completed') {
      await writeDurable(join(state.runDir, 'report.md'), markdown, true);
      artifacts.push({ name: 'report.md', sha256: hash(markdown) });
    }
    const report = {
      schemaVersion: 1, runID, runDir: state.runDir, status, code, profile, provenance,
      actualModelRequests: 0, actualExternalRequests: 0, syntheticModelRequests: model?.received.length ?? 0,
      toolCalls: tools?.calls ?? {}, fixtureOperations: fixture?.received ?? [], limits: RESEARCH_LIMITS,
      toolErrors: sdk?.tools.filter(tool => tool.code).map(tool => tool.code) ?? [],
      sdkSettled: sdk?.sdkSettled ?? false, blockedSocketAttempts: boundary?.denied.length ?? 0,
      unknown: saved.unknown, userStoppedWaiting: userSignal.aborted, deadlineReached: deadline.aborted, artifacts
    };
    await state.finish(report);
    terminalWritten = true;
    return report;
  } finally {
    await state.release(terminalWritten && status !== 'unknown');
  }
}

const controller = new AbortController();
const stop = () => controller.abort();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
try {
  const result = await runResearch({ ...parseArgs(process.argv.slice(2)), userSignal: controller.signal });
  process.stdout.write(JSON.stringify(result) + '\n');
  if (result.status !== 'completed') process.exitCode = 1;
} catch (error) {
  process.stderr.write('Research run stopped: ' + codeOf(error) + '\n');
  process.exitCode = 1;
} finally {
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
}
