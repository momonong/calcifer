"""Installation tests use real files and a non-networked synthetic engine."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parent


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='wisp install 中文 ')
        self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)
        self.prefix=self.root/'app'; self.bin=self.root/'bin'; self.config=self.root/'config.json'
        self.source=self.root/'source'; self.source.mkdir()
        self.env=dict(os.environ,PATH=os.defpath)
        for name in ['launcher.py','install.py']:
            if (ROOT/name).exists(): shutil.copyfile(ROOT/name,self.source/name)
        files={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in self.source.iterdir()}
        (self.source/'manifest.json').write_text(json.dumps({'version':'0.1.3','files':files}))
        self.engine=self.root/'hermes'; self.engine.write_text('#!/bin/sh\nprintf "Hermes v0.23.1\\n"\n'); self.engine.chmod(0o700)

    def install(self,*extra):
        return subprocess.run([sys.executable,'-B',str(ROOT/'install.py'),'--source',str(self.source),
            '--prefix',str(self.prefix),'--bin-dir',str(self.bin),'--config',str(self.config),'--hermes',str(self.engine),*extra],env=self.env,capture_output=True,text=True)

    def test_installed_command_works_with_spaces_and_reinstall_preserves_auth(self):
        first=self.install(); self.assertEqual(first.returncode,0,first.stderr)
        config=json.loads(self.config.read_text()); h=Path(config['hermes_home'])
        (h/'auth.json').write_text('DO_NOT_COPY_OR_REPLACE')
        before=(self.config.read_bytes(),(h/'config.yaml').read_bytes())
        run=subprocess.run([str(self.bin/'wisp'),'doctor'],capture_output=True,text=True)
        self.assertEqual(run.returncode,0,run.stderr)
        self.assertIn('0.23.1',run.stdout)
        second=self.install(); self.assertEqual(second.returncode,0,second.stderr)
        self.assertEqual(before,(self.config.read_bytes(),(h/'config.yaml').read_bytes()))
        self.assertEqual((h/'auth.json').read_text(),'DO_NOT_COPY_OR_REPLACE')

    def test_foreign_wisp_command_is_never_overwritten(self):
        self.bin.mkdir(); target=self.bin/'wisp'; target.write_text('some other program')
        result=self.install()
        self.assertNotEqual(result.returncode,0)
        self.assertEqual(target.read_text(),'some other program')
        self.assertFalse(self.config.exists())

    def test_foreign_wisp_elsewhere_on_path_is_not_silently_shadowed(self):
        foreign=self.root/'foreign';foreign.mkdir()
        command=foreign/'wisp';command.write_text('#!/bin/sh\necho FOREIGN\n');command.chmod(0o700)
        self.env['PATH']=str(self.bin)+os.pathsep+str(foreign)+os.pathsep+os.defpath
        result=self.install()
        self.assertNotEqual(result.returncode,0)
        self.assertIn(str(command),result.stderr)
        self.assertFalse((self.bin/'wisp').exists())

    def test_modified_owned_shim_is_not_overwritten(self):
        self.assertEqual(self.install().returncode,0)
        target=self.bin/'wisp'; target.write_text('user customized command')
        self.assertNotEqual(self.install().returncode,0)
        self.assertEqual(target.read_text(),'user customized command')

    def test_tampered_payload_is_refused_before_installing(self):
        with (self.source/'launcher.py').open('a') as f: f.write('\nraise RuntimeError("tampered")\n')
        result=self.install()
        self.assertNotEqual(result.returncode,0)
        self.assertFalse((self.bin/'wisp').exists())
        self.assertFalse(self.config.exists())

    def test_adopted_home_is_not_rewritten(self):
        home=self.root/'existing profile'; home.mkdir()
        (home/'config.yaml').write_text('user config\n'); (home/'auth.json').write_text('PRIVATE')
        result=self.install('--hermes-home',str(home))
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual((home/'config.yaml').read_text(),'user config\n')
        self.assertEqual((home/'auth.json').read_text(),'PRIVATE')

    def test_plain_reinstall_reuses_saved_profile_without_engine_calls(self):
        home=self.root/'existing profile'; home.mkdir()
        desktop=self.root/'existing desktop'
        dist=self.root/'prebuilt'; dist.mkdir(); (dist/'index.html').write_text('ready')
        self.assertEqual(self.install('--hermes-home',str(home),'--desktop-data',str(desktop),'--webapp-dist',str(dist)).returncode,0)
        before=self.config.read_bytes()
        self.engine.write_text('#!/bin/sh\nexit 73\n')
        result=subprocess.run([sys.executable,'-B',str(ROOT/'install.py'),'--source',str(self.source),
            '--prefix',str(self.prefix),'--bin-dir',str(self.bin),'--config',str(self.config)],env=self.env,capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(self.config.read_bytes(),before)
        self.assertFalse((self.prefix/'hermes').exists())

    def test_reinstall_does_not_rebuild_an_existing_default_profile(self):
        self.assertEqual(self.install().returncode,0)
        self.engine.write_text('#!/bin/sh\nexit 73\n')
        before=(self.config.read_bytes(),(self.prefix/'hermes/config.yaml').read_bytes())
        result=self.install()
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(before,(self.config.read_bytes(),(self.prefix/'hermes/config.yaml').read_bytes()))

    def test_broken_candidate_keeps_working_command_and_receipt(self):
        self.assertEqual(self.install().returncode,0)
        command=self.bin/'wisp'; receipt=self.prefix/'install-receipt.json'
        before=(command.read_bytes(),receipt.read_bytes(),self.config.read_bytes())
        (self.source/'launcher.py').write_text('raise RuntimeError("candidate failure")\n')
        manifest=json.loads((self.source/'manifest.json').read_text())
        manifest['files']['launcher.py']=hashlib.sha256((self.source/'launcher.py').read_bytes()).hexdigest()
        (self.source/'manifest.json').write_text(json.dumps(manifest))
        result=self.install()
        self.assertNotEqual(result.returncode,0)
        self.assertEqual(before,(command.read_bytes(),receipt.read_bytes(),self.config.read_bytes()))
        self.assertEqual(subprocess.run([str(command),'--version'],capture_output=True).returncode,0)

    def test_explicit_profile_change_is_still_refused(self):
        self.assertEqual(self.install().returncode,0)
        alternate=self.root/'alternate';alternate.mkdir()
        before=self.config.read_bytes()
        result=self.install('--hermes-home',str(alternate))
        self.assertNotEqual(result.returncode,0)
        self.assertEqual(self.config.read_bytes(),before)

    def test_manifest_traversal_or_symlink_is_refused(self):
        outside=self.root/'outside.py'; outside.write_text('protected')
        data={'version':'0.1.3','files':{'../outside.py':hashlib.sha256(outside.read_bytes()).hexdigest()}}
        (self.source/'manifest.json').write_text(json.dumps(data))
        self.assertNotEqual(self.install().returncode,0)
        self.assertEqual(outside.read_text(),'protected')
        self.assertFalse((self.bin/'wisp').exists())


if __name__=='__main__': unittest.main()
