// Pure JSON contract validation. Paths are declarations, never filesystem access.
const fail = code => { throw new Error(code); };
const text = value => typeof value === 'string' && value.trim().length > 0;
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fields = (value, allowed, code) => {
  if (!object(value)) fail(code);
  if (Object.keys(value).some(key => !allowed.includes(key))) fail(code);
};
const strings = (value, code, check = identifier) => {
  if (!Array.isArray(value) || value.some(item => !check(item)) || new Set(value).size !== value.length) fail(code);
};
const relativePath = value => text(value) && value === value.trim()
  && !/[\\:\x00-\x1f\x7f*?\[\]]/.test(value)
  && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');

// Shape-only checks are shared with the router. They grant no path/check authority.
export function assertTaskShape(task) {
  fields(task, ['id', 'instruction', 'dependsOn', 'requiredCapabilities', 'writePaths', 'checkIds'], 'UNKNOWN_TASK_FIELD');
  if (!identifier(task.id)) fail('INVALID_TASK_ID');
  if (!text(task.instruction)) fail('INVALID_INSTRUCTION');
  strings(task.dependsOn, 'INVALID_DEPENDENCIES');
  strings(task.requiredCapabilities, 'INVALID_CAPABILITIES');
  strings(task.writePaths, 'INVALID_PATH', relativePath);
  strings(task.checkIds, 'INVALID_CHECK_IDS');
  if (task.writePaths.length && !task.requiredCapabilities.includes('edit')) fail('EDIT_CAPABILITY_REQUIRED');
  if (task.checkIds.length && !task.requiredCapabilities.includes('verify')) fail('VERIFY_CAPABILITY_REQUIRED');
}

export function assertPlanShape(plan, maxTasks = 4) {
  if (!Number.isInteger(maxTasks) || maxTasks < 1 || maxTasks > 4) fail('INVALID_MAX_TASKS');
  fields(plan, ['schemaVersion', 'goal', 'tasks'], 'UNKNOWN_PLAN_FIELD');
  if (plan.schemaVersion !== 1) fail('INVALID_SCHEMA_VERSION');
  if (!text(plan.goal)) fail('INVALID_GOAL');
  if (!Array.isArray(plan.tasks) || plan.tasks.length < 1 || plan.tasks.length > maxTasks) fail('TASK_LIMIT');
  plan.tasks.forEach(assertTaskShape);
  const byId = new Map(plan.tasks.map(task => [task.id, task]));
  if (byId.size !== plan.tasks.length) fail('DUPLICATE_TASK_ID');
  for (const task of plan.tasks) {
    if (task.dependsOn.some(id => !byId.has(id))) fail('UNKNOWN_DEPENDENCY');
  }
  const active = new Set(), complete = new Set();
  const visit = id => {
    if (active.has(id)) fail('CYCLIC_DEPENDENCY');
    if (complete.has(id)) return;
    active.add(id);
    byId.get(id).dependsOn.forEach(visit);
    active.delete(id); complete.add(id);
  };
  plan.tasks.forEach(task => visit(task.id));
}

export function validateTaskPlan(value, { allowedPaths, allowedCheckIds, maxTasks = 4 } = {}) {
  strings(allowedPaths, 'INVALID_ALLOWED_PATHS', relativePath);
  strings(allowedCheckIds, 'INVALID_ALLOWED_CHECK_IDS');
  assertPlanShape(value, maxTasks);
  const paths = new Set(allowedPaths), checks = new Set(allowedCheckIds);
  for (const task of value.tasks) {
    if (task.writePaths.some(path => !paths.has(path))) fail('PATH_NOT_ALLOWED');
    if (task.checkIds.some(id => !checks.has(id))) fail('CHECK_NOT_ALLOWED');
  }
  return structuredClone(value);
}
