import { runGoal } from './goal-runner.mjs';
import { goalFixture } from './goal-fixture.mjs';
const [framework, stateRoot, hostNodeBinary] = process.argv.slice(2);
const controller = new AbortController();
process.on('SIGTERM', () => controller.abort()); process.on('SIGINT', () => controller.abort());
try {
  const fixture = await goalFixture({ framework, stateRoot, hostNodeBinary, controller });
  const result = await runGoal({ ...fixture, signal: controller.signal });
  console.log('CALCIFER_GOAL_RESULT=' + JSON.stringify({ schemaVersion: 1, status: result.status, code: result.code, runID: result.runID }));
  process.exit(result.status === 'completed' ? 0 : 1);
} catch (error) {
  console.log('CALCIFER_GOAL_RESULT=' + JSON.stringify({ schemaVersion: 1, status: 'rejected', code: /^[A-Z_]+$/.test(error.message) ? error.message : 'GOAL_FAILED' })); process.exit(1);
}
