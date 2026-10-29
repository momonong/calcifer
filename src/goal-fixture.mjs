import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { MODEL_ID } from './goal-request-gate.mjs';

export async function goalFixture({ framework = 'opencode', variant = 'normal', stateRoot, hostNodeBinary, controller }) {
  if (!['opencode','pi','mixed'].includes(framework) || !['normal','invalid-plan','out-of-scope','one-task','partial-tool','error-frame','lost-tool','cancel','phase-budget'].includes(variant)) throw new Error('INVALID_SYNTHETIC_FIXTURE');
  const sourceDir = fileURLToPath(new URL('../fixtures/goal-demo/', import.meta.url)).replace(/\/$/, '');
  const plan = JSON.parse(await readFile(join(sourceDir, 'plan.json'), 'utf8'));
  if (variant === 'one-task') { plan.tasks = [plan.tasks[0]]; plan.tasks[0].instruction = 'Complete both note edits in one small task'; }
  if (variant === 'out-of-scope') plan.tasks[0].writePaths = ['forbidden.txt'];
  const profile = (id, engine, capabilities, priority) => ({ id, framework: engine, model: MODEL_ID, capabilities, priority, enabled: true, mode: 'mock' });
  const profiles = framework === 'mixed'
    ? [profile('first-worker','opencode',['analysis','edit','verify'],2),profile('second-worker','pi',['edit','verify'],1)]
    : [profile('mock-worker',framework,['analysis','edit','verify'],1)];
  const host = { sourceDir, stateRoot, sourceFiles: ['note.txt'], readPaths: ['note.txt'], allowedPaths: ['note.txt'], allowedCheckIds: ['final'], finalCheckIds: ['final'],
    checks: { final: { kind: 'node-data', scriptPath: join(sourceDir, 'check.mjs') } }, profiles, authorization: { mode: 'mock', allowedProfileIds: profiles.map(item => item.id) }, hostNodeBinary };
  return { goal: plan.goal, host, plannerProfileId: profiles[0].id,
    toolObserver: variant === 'lost-tool' ? async ({ input }) => { if (input.action === 'edit') throw new Error('SYNTHETIC_LOST_TOOL_ACK'); } : undefined,
    transport: async ({ phase, index, payload, signal }) => {
      let text, action;
      if (phase.kind === 'planner') text = variant === 'invalid-plan' ? '```json\n{}\n```' : JSON.stringify(plan);
      else {
        const results = payload.messages.filter(message => message.role === 'tool').map(message => { try { return JSON.parse(message.content); } catch { return {}; } });
        const previous = results.findLast(item => typeof item.hash === 'string' && typeof item.content === 'string');
        const stages = phase.taskId === 'first' ? ['search','read','check','edit'] : ['search','read','edit','check'];
        const stage = stages[index];
        if (stage === 'search') action = { action: 'search', args: { query: 'draft' } };
        if (stage === 'read') action = { action: 'read', args: { path: 'note.txt' } };
        if (stage === 'check') action = { action: 'check', args: { checkId: 'final' } };
        if (stage === 'edit') action = { action: 'edit', args: { path: 'note.txt', expectedHash: previous?.hash,
          content: previous?.content + (variant === 'one-task' ? 'first\nsecond\n' : phase.taskId + '\n') } };
        if (!stage) text = 'Synthetic task work ended; host decides data acceptance.';
        if (variant === 'phase-budget') { action = { action: 'read', args: { path: 'note.txt' } }; text = undefined; }
      }
      const chunk = (delta, finish_reason = null) => ({ id: 'synthetic', object: 'chat.completion.chunk', created: 1, model: MODEL_ID, choices: [{ index: 0, delta, finish_reason }] });
      const frames = [chunk({ role: 'assistant', content: '' }), action
        ? chunk({ tool_calls: [{ index: 0, id: `call_${index}`, type: 'function', function: { name: 'calcifer_tool', arguments: JSON.stringify(action) } }] }) : chunk({ content: text }),
        chunk({}, action ? 'tool_calls' : 'stop')];
      let source = frames.map(item => `data: ${JSON.stringify(item)}\n\n`).join('');
      if (phase.kind === 'worker' && variant === 'error-frame') source += 'data: {"error":{"message":"synthetic SSE failure"}}\n\n';
      if (!(phase.kind === 'worker' && ['partial-tool','error-frame'].includes(variant))) source += 'data: [DONE]\n\n';
      if (phase.kind === 'worker' && variant === 'cancel') {
        setTimeout(() => controller?.abort(), 20);
        return new Response(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode(source)); signal.addEventListener('abort', () => stream.error(new Error('SYNTHETIC_ABORT')), { once: true }); } }), { headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response(source, { headers: { 'content-type': 'text/event-stream' } });
    } };
}
