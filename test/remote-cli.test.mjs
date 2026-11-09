import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {remoteMain,loadRemoteConfig} from '../src/remote-cli.mjs';

test('remote setup writes private configuration without granting model resources',async()=>{
 const root=await mkdtemp('/tmp/calcifer-remote-cli-'),config=join(root,'config','remote.json');let out='';
 const io={stdout:{write:v=>out+=v},stderr:{write:v=>out+=v}};
 const args=['configure','--config',config,'--origin','https://example.invalid','--project','sample','--state',join(root,'project'),'--control-state',join(root,'control')];
 assert.equal(await remoteMain(args,io),0);const c=await loadRemoteConfig(config);
 assert.equal(c.origin,'https://example.invalid');assert.equal(c.projects[0].id,'sample');assert.equal(c.port,18470);
 assert.equal((await stat(config)).mode&0o777,0o600);assert.equal((await stat(join(root,'config'))).mode&0o777,0o700);
 assert.ok(!('maxTurns' in c));assert.ok(!out.includes('password='));
 assert.equal(await remoteMain(args,io),1);assert.match(out,/CONFIG_ALREADY_EXISTS/);
 assert.equal(await remoteMain(['password','--config',config],{...io,stdin:{isTTY:false}}),1);assert.match(out,/PRIVATE_TTY_REQUIRED/);
 assert.equal(JSON.parse(await readFile(config,'utf8')).projects.length,1);
});
test('unsafe origin and non-absolute paths are rejected before setup',async()=>{
 let out='';const io={stdout:{write:v=>out+=v},stderr:{write:v=>out+=v}};
 assert.equal(await remoteMain(['configure','--config','relative','--origin','http://public.invalid','--project','sample','--state','relative'],io),1);
 assert.match(out,/REMOTE_OPTIONS_INVALID/);
});
