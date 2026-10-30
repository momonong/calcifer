import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { add } from '../src/add.mjs';
test('fixed direct unit example', () => assert.equal(add(2, 3), 5));
test('synthetic npm configuration canaries', () => {
  assert.equal(existsSync('/tmp/calcifer-hook-pretest'), false);
  assert.equal(existsSync('/tmp/calcifer-hook-posttest'), false);
  assert.equal(process.env.CALCIFER_NPM_CANARY, undefined);
  assert.equal(process.env.npm_config_userconfig, '/config/user.npmrc');
  assert.equal(readFileSync('/config/user.npmrc', 'utf8'), '');
  assert.equal(readFileSync('/config/global.npmrc', 'utf8'), '');
  assert.equal(readFileSync('/runtime/npm/.npmrc', 'utf8'), '');
  assert.equal(existsSync('/input/contract.json'), false);
  assert.deepEqual(readdirSync('/workspace').sort(), ['cli.mjs', 'hook.mjs', 'package.json', 'src', 'test']);
});
