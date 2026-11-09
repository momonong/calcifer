import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, link, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { thorSourceFiles, prepareProjectWorkspace, readProjectSnapshot, readSourceSnapshot, verifyProjectChanges, exportProjectPatch } from '../src/project-workspace.mjs';
async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'project-workspace-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const repo=join(root,'repo'),stateDir=join(root,'state'); await mkdir(repo);await mkdir(stateDir);
  const put=async(path,text,base=repo)=>{await mkdir(dirname(join(base,path)),{recursive:true});await writeFile(join(base,path),text);};
  await put('erasebot/main.py','original = True\n');await put('fixtures/config.json','{}\n');
  return {root,repo,stateDir,put};
}
test('seed survives preparation while source and initial remain original; existing snapshots reject',async t=>{
  const f=await fixture(t);const sourceFiles=await thorSourceFiles(f.repo);
  const prepared=await prepareProjectWorkspace({...f,sourceFiles,seedContents:{'erasebot/main.py':'seed = True\n','tests/test_new.py':'pass\n'}});
  assert.equal(await readFile(join(f.repo,'erasebot/main.py'),'utf8'),'original = True\n');
  assert.equal((await readProjectSnapshot(join(f.stateDir,'initial'))).contents['erasebot/main.py'],'original = True\n');
  assert.equal((await readProjectSnapshot(prepared.workspaceDir)).contents['erasebot/main.py'],'seed = True\n');
  assert.notEqual(prepared.seedManifest.hash,prepared.initialManifest.hash);
  await assert.rejects(prepareProjectWorkspace({...f,sourceFiles}),/EXIST/);
  await assert.rejects(prepareProjectWorkspace({...f,sourceFiles,seedContents:{'fixtures/config.json':'bad'}}),/SEED|IMMUTABLE/);
});
test('reject symlinks, hardlinks, unexpected hidden entries and immutable/deleted files',async t=>{
  const f=await fixture(t);const before=await readSourceSnapshot(f.repo,await thorSourceFiles(f.repo));
  await symlink(join(f.repo,'erasebot/main.py'),join(f.repo,'erasebot/link.py'));
  await assert.rejects(readProjectSnapshot(f.repo),/SYMLINK/);await rm(join(f.repo,'erasebot/link.py'));
  await link(join(f.repo,'erasebot/main.py'),join(f.repo,'erasebot/hard.py'));
  await assert.rejects(readProjectSnapshot(f.repo),/HARDLINK|REGULAR/);await rm(join(f.repo,'erasebot/hard.py'));
  await f.put('.hidden','no');await assert.rejects(readProjectSnapshot(f.repo),/HIDDEN|ENTRY|PATH/);await rm(join(f.repo,'.hidden'));
  await f.put('fixtures/config.json','changed');assert.throws(()=>verifyProjectChanges(before,{...(before),contents:{...before.contents,'fixtures/config.json':'changed'}}),/SNAPSHOT|IMMUTABLE|HASH/);
  const changed=await readProjectSnapshot(f.repo);assert.throws(()=>verifyProjectChanges(before,changed),/IMMUTABLE/);
  await rm(join(f.repo,'erasebot/main.py'));const deleted=await readProjectSnapshot(f.repo);assert.throws(()=>verifyProjectChanges(before,deleted),/DELETION/);
});
test('cumulative patch contains seed and new files and applies to original source',async t=>{
  const f=await fixture(t);const sourceFiles=await thorSourceFiles(f.repo);
  const p=await prepareProjectWorkspace({...f,sourceFiles,seedContents:{'erasebot/main.py':'seed = True\n'}});
  await f.put('tests/test_new.py','assert True\n',p.workspaceDir);
  const before=await readProjectSnapshot(join(f.stateDir,'initial')),after=await readProjectSnapshot(p.workspaceDir);
  const output=join(f.root,'changes.patch');const result=await exportProjectPatch({before,after,output});
  assert.equal(result.changedFiles,2);assert.ok(result.patchBytes>0);
  const applied=spawnSync('/usr/bin/git',['apply','--check',output],{cwd:f.repo,encoding:'utf8'});assert.equal(applied.status,0,applied.stderr);
  assert.equal(spawnSync('/usr/bin/git',['apply',output],{cwd:f.repo}).status,0);
  assert.equal(await readFile(join(f.repo,'tests/test_new.py'),'utf8'),'assert True\n');
  await assert.rejects(exportProjectPatch({before,after,output}),/EEXIST|EXIST/);
});
test('source selection is scoped, excludes binary/cache/secret data, and context controls are skipped',async t=>{
  const f=await fixture(t);await f.put('erasebot/__pycache__/bad.py','secret');await f.put('fixtures/pic.png',Buffer.from([0,255]));await f.put('fixtures/credentials.json','secret');await f.put('outside/private.py','secret');
  assert.deepEqual(await thorSourceFiles(f.repo),['erasebot/main.py','fixtures/config.json']);
  const workspace=join(f.root,'clean');await mkdir(workspace);await f.put('AGENTS.md','host',workspace);await f.put('.agents/profile.md','host',workspace);await f.put('tests/test_ok.py','pass',workspace);
  assert.deepEqual(Object.keys((await readProjectSnapshot(workspace)).contents),['tests/test_ok.py']);
});

test('limits and malformed text fail closed; state inside source is rejected',async t=>{
  const f=await fixture(t);await assert.rejects(prepareProjectWorkspace({...f,stateDir:f.repo,sourceFiles:['erasebot/main.py']}),/STATE_ROOT_INSIDE_SOURCE/);
  await f.put('erasebot/main.py',Buffer.from([0xff]));await assert.rejects(readSourceSnapshot(f.repo,['erasebot/main.py']),/UTF8/);
  await f.put('erasebot/main.py','x'.repeat(262145));await assert.rejects(readSourceSnapshot(f.repo,['erasebot/main.py']),/SIZE_LIMIT/);
  await f.put('erasebot/main.py','bad\0data');await assert.rejects(readSourceSnapshot(f.repo,['erasebot/main.py']),/BINARY/);
});
