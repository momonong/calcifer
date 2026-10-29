import { runGoal } from '../../src/goal-runner.mjs';
import { goalFixture } from '../../src/goal-fixture.mjs';
const [framework, variant, stateRoot, hostNodeBinary] = process.argv.slice(2);
const controller = new AbortController();
const fixture = await goalFixture({ framework, variant, stateRoot, hostNodeBinary, controller });
try {
  const result = await runGoal({ ...fixture, signal: controller.signal });
  console.log('CALCIFER_GOAL_RESULT=' + JSON.stringify(result));
  process.exit(result.status === 'completed' ? 0 : 1);
} catch (error) { console.log('CALCIFER_GOAL_RESULT=' + JSON.stringify({ status: 'rejected', code: error.message })); process.exit(1); }
