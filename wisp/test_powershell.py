"""Portable PowerShell checks; these do not substitute for a Windows device test."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest

ROOT=Path(__file__).resolve().parent
PWSH=os.environ.get('WISP_TEST_PWSH') or shutil.which('pwsh')


@unittest.skipUnless(PWSH,'Set WISP_TEST_PWSH for portable PowerShell checks')
class PowerShellTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='wisp ps 中文 '); self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name); self.source=self.root/'payload'; self.source.mkdir()
        names=['launcher.py','install.py','wisp.ps1','wisp.cmd','README.md']
        for n in names:shutil.copyfile(ROOT/n,self.source/n)
        manifest={'version':'0.1.4','files':{n:hashlib.sha256((self.source/n).read_bytes()).hexdigest() for n in names}}
        (self.source/'manifest.json').write_text(json.dumps(manifest))
        self.trace=self.root/'trace.json'; self.engine=self.root/'fake hermes'
        self.engine.write_text('#!'+sys.executable+'\n'+'''import json,os,sys
from pathlib import Path
Path(os.environ['WISP_TEST_TRACE']).write_text(json.dumps({'args':sys.argv[1:],'home':os.environ.get('HERMES_HOME'),'profile':os.environ.get('HERMES_PROFILE'),'runtime':os.environ.get('HERMES_RUNTIME_DIR')}))
print(os.environ.get('WISP_TEST_OUTPUT','Hermes v0.23.1'))
sys.exit(int(os.environ.get('WISP_TEST_EXIT','0')))
''');self.engine.chmod(0o700)
        self.prefix=self.root/'installed'; self.profile=self.root/'existing home';self.profile.mkdir()
        (self.profile/'auth.json').write_text('private fixture')
        (self.profile/'config.yaml').write_text('fixture config')
        self.env=dict(os.environ,WISP_TEST_TRACE=str(self.trace),HERMES_PROFILE='must-not-inherit',HERMES_RUNTIME_DIR='original-runtime-must-not-inherit',PATH=os.defpath)

    def ps(self,path,*args,**env):
        return subprocess.run([PWSH,'-NoLogo','-NoProfile','-File',str(path),*map(str,args)],env={**self.env,**env},capture_output=True,text=True,timeout=30)

    def install(self):
        return self.ps(ROOT/'install.ps1','-Source',self.source,'-InstallRoot',self.prefix,'-HermesCommand',self.engine,'-HermesHome',self.profile,'-NoPath')

    def launch(self,*args,**env):
        receipt=json.loads((self.prefix/'install-receipt.json').read_text())
        return self.ps(Path(receipt['release'])/'wisp.ps1',*args,WISP_CONFIG=str(self.prefix/'config.json'),**env)

    def test_install_doctor_and_reinstall_preserve_existing_profile(self):
        for _ in range(2):
            r=self.install();self.assertEqual(r.returncode,0,r.stderr)
        r=self.launch('doctor');self.assertEqual(r.returncode,0,r.stderr)
        self.assertIn('0.23.1',r.stdout)
        trace=json.loads(self.trace.read_text())
        self.assertEqual(trace['args'],['--version']);self.assertIsNone(trace['profile'])
        self.assertIsNone(trace['runtime'])
        self.assertEqual((self.profile/'auth.json').read_text(),'private fixture')
        self.assertEqual((self.profile/'config.yaml').read_text(),'fixture config')
        self.assertTrue((self.prefix/'bin/wisp.cmd').read_bytes().isascii())

    def test_foreign_command_is_preserved(self):
        command=self.prefix/'bin/wisp.cmd';command.parent.mkdir(parents=True);command.write_text('another tool')
        r=self.install();self.assertNotEqual(r.returncode,0)
        self.assertEqual(command.read_text(),'another tool');self.assertFalse((self.prefix/'config.json').exists())

    def test_git_bash_entry_uses_its_own_config_and_preserves_exit_status(self):
        self.prefix=self.root/"it's & still Wisp"
        r=self.install();self.assertEqual(r.returncode,0,r.stderr)
        entry=self.prefix/'bin/wisp'
        self.assertTrue(entry.is_file(),'Git Bash needs an extensionless wisp entry')
        native=self.root/'native-tools';native.mkdir()
        cygpath=native/'cygpath';cygpath.write_text('#!/bin/sh\nprintf \'%s\\n\' "$2"\n');cygpath.chmod(0o700)
        powershell=native/'powershell.exe'
        powershell.write_text('#!'+sys.executable+'\nimport os,sys\nos.execv('+repr(PWSH)+', ['+repr(PWSH)+']+sys.argv[1:])\n');powershell.chmod(0o700)
        before={p:p.read_bytes() for p in (self.profile/'auth.json',self.profile/'config.yaml')}
        result=subprocess.run(['bash',str(entry),'status'],env={**self.env,
            'PATH':str(native)+os.pathsep+os.defpath,'WISP_CONFIG':'/unrelated/config.json',
            'WISP_TEST_EXIT':'7'},capture_output=True,text=True,timeout=15)
        self.assertEqual(result.returncode,7,result.stderr)
        trace=json.loads(self.trace.read_text())
        self.assertEqual(trace['args'],['webapp','--status'])
        self.assertEqual(trace['home'],str(self.profile))
        self.assertEqual(before,{p:p.read_bytes() for p in before})

    def test_foreign_extensionless_command_is_preserved(self):
        command=self.prefix/'bin/wisp';command.parent.mkdir(parents=True);command.write_text('another tool')
        r=self.install();self.assertNotEqual(r.returncode,0)
        self.assertEqual(command.read_text(),'another tool')
        self.assertFalse((self.prefix/'config.json').exists())

    def test_modified_git_bash_entry_blocks_reinstall(self):
        self.assertEqual(self.install().returncode,0)
        entry=self.prefix/'bin/wisp';entry.write_text('user edited entry')
        old={p:p.read_bytes() for p in (self.prefix/'bin/wisp.cmd',self.prefix/'config.json',self.prefix/'install-receipt.json')}
        r=self.install();self.assertNotEqual(r.returncode,0)
        self.assertEqual(entry.read_text(),'user edited entry')
        self.assertEqual(old,{p:p.read_bytes() for p in old})

    def test_legacy_receipt_upgrade_adds_bash_entry_without_engine_call(self):
        self.assertEqual(self.install().returncode,0)
        entry=self.prefix/'bin/wisp'
        if entry.exists():entry.unlink()
        receipt=self.prefix/'install-receipt.json';data=json.loads(receipt.read_text())
        data.pop('bash_command',None);data.pop('bash_command_sha256',None)
        receipt.write_text(json.dumps(data))
        config=self.prefix/'config.json';before=config.read_bytes()
        r=self.ps(ROOT/'install.ps1','-Source',self.source,'-InstallRoot',self.prefix,'-NoPath',WISP_TEST_EXIT='73')
        self.assertEqual(r.returncode,0,r.stderr)
        self.assertTrue(entry.is_file())
        self.assertEqual(config.read_bytes(),before)
        self.assertFalse(self.trace.exists())

    def test_plain_reinstall_reuses_saved_profile_without_engine_calls(self):
        self.assertEqual(self.install().returncode,0)
        config=self.prefix/'config.json';before=config.read_bytes()
        result=self.ps(ROOT/'install.ps1','-Source',self.source,'-InstallRoot',self.prefix,'-NoPath',WISP_TEST_EXIT='73')
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(config.read_bytes(),before)
        self.assertFalse(self.trace.exists())

    def test_reinstall_does_not_rebuild_an_existing_default_profile(self):
        args=('-Source',self.source,'-InstallRoot',self.prefix,'-HermesCommand',self.engine,'-NoPath')
        self.assertEqual(self.ps(ROOT/'install.ps1',*args).returncode,0)
        self.trace.unlink()
        result=self.ps(ROOT/'install.ps1',*args,WISP_TEST_EXIT='73')
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertFalse(self.trace.exists())

    def test_broken_candidate_keeps_working_command_and_receipt(self):
        self.assertEqual(self.install().returncode,0)
        command=self.prefix/'bin/wisp.cmd';receipt=self.prefix/'install-receipt.json'
        before=(command.read_bytes(),receipt.read_bytes())
        (self.source/'wisp.ps1').write_text('throw "candidate failure"\n')
        manifest=json.loads((self.source/'manifest.json').read_text())
        manifest['files']['wisp.ps1']=hashlib.sha256((self.source/'wisp.ps1').read_bytes()).hexdigest()
        (self.source/'manifest.json').write_text(json.dumps(manifest))
        result=self.install()
        self.assertNotEqual(result.returncode,0)
        self.assertEqual(before,(command.read_bytes(),receipt.read_bytes()))
        self.assertEqual(self.launch('version').returncode,0)

    def test_windows_first_use_progress_does_not_reject_valid_candidate(self):
        # Windows PowerShell 5.1 emits module-autoload progress as CLIXML on
        # stderr. Portable PowerShell does not, so model that observed host
        # behavior while exercising the real installer and child process.
        candidate=self.source/'wisp.ps1'
        candidate.write_text('''if ($ProgressPreference -ne 'SilentlyContinue') {
    [Console]::Error.WriteLine('#< CLIXML')
    [Console]::Error.WriteLine('<Objs><Obj S="progress"><MS><PR><AV>Preparing modules for first use.</AV></PR></MS></Obj></Objs>')
}
Write-Output 'Wisp 0.1.4'
exit 0
''')
        manifest=json.loads((self.source/'manifest.json').read_text())
        manifest['files']['wisp.ps1']=hashlib.sha256(candidate.read_bytes()).hexdigest()
        (self.source/'manifest.json').write_text(json.dumps(manifest))
        r=self.install();self.assertEqual(r.returncode,0,r.stderr)
        self.assertTrue((self.prefix/'bin/wisp.cmd').is_file())
        self.assertFalse(self.trace.exists(),'A version probe must not call Hermes')

    def test_candidate_stderr_error_is_still_rejected_even_with_zero_exit(self):
        self.assertEqual(self.install().returncode,0)
        protected=[self.prefix/'bin/wisp.cmd',self.prefix/'config.json',self.prefix/'install-receipt.json']
        before={p:p.read_bytes() for p in protected}
        candidate=self.source/'wisp.ps1'
        candidate.write_text("[Console]::Error.WriteLine('real candidate error')\nWrite-Output 'Wisp 0.1.4'\nexit 0\n")
        manifest=json.loads((self.source/'manifest.json').read_text())
        manifest['files']['wisp.ps1']=hashlib.sha256(candidate.read_bytes()).hexdigest()
        (self.source/'manifest.json').write_text(json.dumps(manifest))
        r=self.install();self.assertNotEqual(r.returncode,0)
        self.assertEqual(before,{p:p.read_bytes() for p in protected})

    @unittest.skipUnless(os.name=='posix','The outer failure guard uses a POSIX test process group')
    def test_hung_candidate_times_out_and_keeps_the_working_installation(self):
        self.assertEqual(self.install().returncode,0)
        command=self.prefix/'bin/wisp.cmd';receipt=self.prefix/'install-receipt.json';config=self.prefix/'config.json'
        before={p:p.read_bytes() for p in [command,receipt,config,self.profile/'auth.json',self.profile/'config.yaml']}
        pid_file=self.root/'candidate.pid'
        (self.source/'wisp.ps1').write_text('[IO.File]::WriteAllText($env:WISP_TEST_CANDIDATE_PID, [string]$PID)\nStart-Sleep -Seconds 60\n')
        manifest=json.loads((self.source/'manifest.json').read_text())
        manifest['files']['wisp.ps1']=hashlib.sha256((self.source/'wisp.ps1').read_bytes()).hexdigest()
        (self.source/'manifest.json').write_text(json.dumps(manifest))
        started=time.monotonic()
        process=subprocess.Popen([PWSH,'-NoLogo','-NoProfile','-File',str(ROOT/'install.ps1'),
            '-Source',str(self.source),'-InstallRoot',str(self.prefix),'-NoPath'],
            env={**self.env,'WISP_TEST_CANDIDATE_PID':str(pid_file)},
            stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
        try:
            try: stdout,stderr=process.communicate(timeout=24)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid,signal.SIGKILL)
                process.communicate(timeout=5)
                self.fail('Candidate version check exceeded the 24-second test guard')
            self.assertNotEqual(process.returncode,0)
            self.assertIn('timed out',stdout+stderr)
            self.assertLess(time.monotonic()-started,24)
            self.assertTrue(pid_file.exists(),'Candidate probe was not actually started')
            with self.assertRaises(ProcessLookupError): os.kill(int(pid_file.read_text()),0)
            self.assertEqual(before,{p:p.read_bytes() for p in before})
            self.assertFalse(self.trace.exists(),'The version probe must not call Hermes')
            self.assertEqual(self.launch('version').returncode,0)
        finally:
            # Only this test's own process group; also reaps a failed implementation.
            try: os.killpg(process.pid,signal.SIGKILL)
            except ProcessLookupError: pass
            process.wait(timeout=5)

    def test_explicit_profile_change_is_still_refused(self):
        self.assertEqual(self.install().returncode,0)
        alternate=self.root/'alternate';alternate.mkdir()
        config=self.prefix/'config.json';before=config.read_bytes()
        result=self.ps(ROOT/'install.ps1','-Source',self.source,'-InstallRoot',self.prefix,
            '-HermesCommand',self.engine,'-HermesHome',alternate,'-NoPath')
        self.assertNotEqual(result.returncode,0)
        self.assertEqual(config.read_bytes(),before)

    def test_candidate_probe_handles_quoted_path_without_shell_interpretation(self):
        self.prefix=self.root/"it's & still Wisp"
        result=self.install()
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(self.launch('version').returncode,0)
        self.assertFalse(self.trace.exists())

    def test_foreign_wisp_elsewhere_on_path_is_preserved(self):
        foreign=self.root/'foreign';foreign.mkdir()
        command=foreign/'wisp';command.write_text('#!/bin/sh\necho FOREIGN\n');command.chmod(0o700)
        self.env['PATH']=str(foreign)+os.pathsep+os.defpath
        r=self.install();self.assertNotEqual(r.returncode,0)
        self.assertFalse((self.prefix/'config.json').exists())

    def test_foreign_powershell_script_elsewhere_on_path_is_preserved(self):
        foreign=self.root/'foreign';foreign.mkdir()
        command=foreign/'wisp.ps1';command.write_text('Write-Output FOREIGN\n')
        self.env['PATH']=str(foreign)+os.pathsep+os.defpath
        r=self.install();self.assertNotEqual(r.returncode,0)
        self.assertFalse((self.prefix/'config.json').exists())

    def test_default_launch_redacts_private_link_and_keeps_exit_code(self):
        r=self.install();self.assertEqual(r.returncode,0,r.stderr)
        r=self.launch(WISP_TEST_OUTPUT='http://127.0.0.1:18767/?ticket=secret-value',WISP_TEST_EXIT='7')
        self.assertEqual(r.returncode,7,r.stderr)
        self.assertNotIn('secret-value',r.stdout+r.stderr)
        self.assertEqual(json.loads(self.trace.read_text())['args'],['webapp','--skip-build'])

    def test_payload_tampering_is_refused(self):
        (self.source/'wisp.ps1').write_text('modified')
        r=self.install();self.assertNotEqual(r.returncode,0)
        self.assertFalse((self.prefix/'config.json').exists())

    def test_new_profile_prepares_runtime_without_copying_login(self):
        r=self.ps(ROOT/'install.ps1','-Source',self.source,'-InstallRoot',self.prefix,'-HermesCommand',self.engine,'-NoPath')
        self.assertEqual(r.returncode,0,r.stderr)
        config=json.loads((self.prefix/'config.json').read_text())
        self.assertFalse((Path(config['hermes_home'])/'auth.json').exists())
        self.assertEqual(json.loads(self.trace.read_text())['args'],['webapp','--build-only'])

    def test_native_argument_validation_prevents_extra_engine_flags(self):
        r=self.install();self.assertEqual(r.returncode,0,r.stderr)
        r=self.launch('-Yolo');self.assertNotEqual(r.returncode,0)
        self.assertFalse(self.trace.exists())

if __name__=='__main__':unittest.main()
