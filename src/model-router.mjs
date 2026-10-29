import { assertTaskShape, assertPlanShape } from './task-plan.mjs';

const fail = code => { throw new Error(code); };
const text = value => typeof value === 'string' && value.trim().length > 0;
const strings = value => Array.isArray(value) && value.every(text) && new Set(value).size === value.length;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const compareIds = (left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0;

function validateRegistry(profiles, authorization) {
  if (!object(authorization) || Object.keys(authorization).some(key => !['allowedProfileIds', 'mode'].includes(key))
    || !strings(authorization.allowedProfileIds)) fail('INVALID_AUTHORIZATION');
  if (authorization.mode === 'live') fail('LIVE_MODE_UNAVAILABLE');
  if (authorization.mode !== 'mock') fail('INVALID_AUTHORIZATION_MODE');
  if (!Array.isArray(profiles)) fail('INVALID_PROFILES');
  for (const profile of profiles) {
    if (!object(profile) || Object.keys(profile).some(key => !['id', 'framework', 'model', 'capabilities', 'priority', 'enabled', 'mode'].includes(key))) fail('UNKNOWN_PROFILE_FIELD');
    if (!text(profile.id) || !text(profile.model) || !['opencode', 'pi'].includes(profile.framework)
      || !strings(profile.capabilities) || !Number.isSafeInteger(profile.priority)
      || typeof profile.enabled !== 'boolean' || !['mock', 'live'].includes(profile.mode)) fail('INVALID_PROFILE');
  }
  if (new Set(profiles.map(profile => profile.id)).size !== profiles.length) fail('DUPLICATE_PROFILE_ID');
}

function select(task, profiles, authorization) {
  const eligible = [], excludedProfiles = [];
  for (const profile of [...profiles].sort(compareIds)) {
    const reasons = [];
    if (!authorization.allowedProfileIds.includes(profile.id)) reasons.push('NOT_AUTHORIZED');
    if (!profile.enabled) reasons.push('DISABLED');
    if (profile.mode !== authorization.mode) reasons.push('MODE_MISMATCH');
    const missingCapabilities = task.requiredCapabilities.filter(capability => !profile.capabilities.includes(capability));
    if (missingCapabilities.length) reasons.push('MISSING_CAPABILITIES');
    if (reasons.length) excludedProfiles.push({ profileId: profile.id, reasons, missingCapabilities });
    else eligible.push(profile);
  }
  eligible.sort((left, right) => left.priority - right.priority || compareIds(left, right));
  if (!eligible.length) return { status: 'rejected', taskId: task.id, code: 'NO_ELIGIBLE_PROFILE',
    requiredCapabilities: [...task.requiredCapabilities], excludedProfiles };
  return { status: 'assigned', taskId: task.id, profileId: eligible[0].id,
    reason: { code: 'CAPABILITIES_PRIORITY_ID', mode: authorization.mode,
      requiredCapabilities: [...task.requiredCapabilities], priority: eligible[0].priority,
      eligibleProfileIds: eligible.map(profile => profile.id), excludedProfiles } };
}

// Routing does not grant write/check authority; callers validate host scope first.
export function routeTask(task, profiles, authorization) {
  assertTaskShape(task);
  validateRegistry(profiles, authorization);
  return select(task, profiles, authorization);
}

export function planAssignments(plan, profiles, authorization) {
  assertPlanShape(plan);
  validateRegistry(profiles, authorization);
  const routes = plan.tasks.map(task => select(task, profiles, authorization));
  const rejections = routes.filter(route => route.status === 'rejected');
  if (rejections.length) return { status: 'rejected', code: 'UNROUTABLE_PLAN', assignments: [], rejections };
  return { status: 'assigned', assignments: routes };
}
