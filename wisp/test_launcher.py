"""Behavior checks for the user-facing launcher; never call a real model."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parent


class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='wisp space 中文 ')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.trace = self.root / 'trace.json'
        self.engine = self.root / 'fake hermes'
        self.engine.write_text('#!' + sys.executable + '\n' + '''import json,os,sys
from pathlib import Path
Path(os.environ['WISP_TEST_TRACE']).write_text(json.dumps({'args':sys.argv[1:],'home':os.environ.get('HERMES_HOME'),'dist':os.environ.get('HERMES_WEBAPP_DIST'),'desktop':os.environ.get('HERMES_DESKTOP_USER_DATA_DIR'),'overrides':{k:os.environ[k] for k in ['HERMES_PROFILE','HERMES_PROFILE_NAME','HERMES_CONFIG','HERMES_ENV'] if k in os.environ}}))
if '--version' in sys.argv: print('Hermes v0.23.1')
else: print(os.environ.get('WISP_TEST_OUTPUT','Opened the Webapp in your browser.'))
sys.exit(int(os.environ.get('WISP_TEST_EXIT','0')))
''')
        self.engine.chmod(0o700)
        self.hermes_home = self.root / 'private hermes'
        self.hermes_home.mkdir()
        self.config = self.root / 'config.json'
        self.config.write_text(json.dumps({'schema_version':1,'hermes':str(self.engine),
                                         'hermes_home':str(self.hermes_home),
                                         'desktop_data':str(self.root/'desktop'),
                                         'webapp_dist':None}))
        self.env = dict(os.environ, WISP_CONFIG=str(self.config), WISP_TEST_TRACE=str(self.trace))

    def run_cli(self, *args, **extra):
        return subprocess.run([sys.executable,'-B',str(ROOT/'launcher.py'),*args],env={**self.env,**extra},capture_output=True,text=True)

    def test_default_opens_native_webapp_with_private_home_and_no_shell(self):
        result=self.run_cli()
        self.assertEqual(result.returncode,0,result.stderr)
        trace=json.loads(self.trace.read_text())
        self.assertEqual(trace['args'],['webapp','--skip-build'])
        self.assertEqual(trace['home'],str(self.hermes_home))
        self.assertEqual(trace['desktop'],str(self.root/'desktop'))

    def test_status_does_not_start_or_build(self):
        result=self.run_cli('status')
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(json.loads(self.trace.read_text())['args'],['webapp','--status'])

    def test_inherited_profile_overrides_do_not_escape_private_home(self):
        result=self.run_cli(HERMES_PROFILE='other',HERMES_PROFILE_NAME='other',HERMES_CONFIG='/other/config',HERMES_ENV='/other/env',HERMES_WEBAPP_DIST='/other/dist')
        self.assertEqual(result.returncode,0,result.stderr)
        trace=json.loads(self.trace.read_text())
        self.assertEqual(trace['overrides'],{})
        self.assertIsNone(trace['dist'])

    def test_prepare_builds_without_opening_and_prebuilt_profile_never_builds(self):
        result=self.run_cli('prepare')
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(json.loads(self.trace.read_text())['args'],['webapp','--build-only'])
        self.trace.unlink()
        dist=self.root/'dist'; dist.mkdir(); (dist/'index.html').write_text('ready')
        config=json.loads(self.config.read_text()); config['webapp_dist']=str(dist)
        self.config.write_text(json.dumps(config))
        result=self.run_cli('prepare')
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(json.loads(self.trace.read_text())['args'],['--version'])

    def test_prepare_initializes_missing_runtime_once_without_opening(self):
        self.engine.write_text('#!'+sys.executable+'\n'+'''import os,sys,json
from pathlib import Path
home=Path(os.environ['HERMES_HOME']); ready=home/'runtime-ready'; log=home/'calls.json'
calls=json.loads(log.read_text()) if log.exists() else []; calls.append(sys.argv[1:]);log.write_text(json.dumps(calls))
if sys.argv[1:]==['pm','repair']:
 ready.write_text('ready'); print('Runtime prepared');sys.exit(0)
if not ready.exists():
 print('hermes: no dependency environment is committed for this install',file=sys.stderr);sys.exit(1)
print('Hermes v0.23.1')
''')
        result=self.run_cli('prepare')
        self.assertEqual(result.returncode,0,result.stderr)
        calls=json.loads((self.hermes_home/'calls.json').read_text())
        self.assertEqual(calls,[['--version'],['pm','repair'],['--version'],['webapp','--build-only']])

    def test_prepare_does_not_repair_an_unrelated_startup_failure(self):
        result=self.run_cli('prepare',WISP_TEST_OUTPUT='permission denied',WISP_TEST_EXIT='5')
        self.assertEqual(result.returncode,5)
        self.assertEqual(json.loads(self.trace.read_text())['args'],['--version'])

    def test_default_does_not_echo_one_use_credentials(self):
        result=self.run_cli(WISP_TEST_OUTPUT='Open http://127.0.0.1:18766/webapp/launch?ticket=super-secret#other-secret')
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertNotIn('super-secret',result.stdout+result.stderr)
        self.assertNotIn('other-secret',result.stdout+result.stderr)
        self.assertIn('--no-open',result.stdout)

    def test_explicit_terminal_link_is_forwarded_and_exit_code_retained(self):
        result=self.run_cli('--no-open',WISP_TEST_OUTPUT='http://127.0.0.1:18766/?ticket=local-only',WISP_TEST_EXIT='7')
        self.assertEqual(result.returncode,7)
        self.assertIn('ticket=local-only',result.stdout)
        self.assertEqual(json.loads(self.trace.read_text())['args'],['webapp','--skip-build','--no-open'])

    def test_missing_or_invalid_config_never_uses_global_hermes(self):
        for payload in [None,{'schema_version':1,'hermes':str(self.engine),'hermes_home':'relative'}]:
            if payload is None: self.config.unlink()
            else: self.config.write_text(json.dumps(payload))
            result=self.run_cli()
            self.assertNotEqual(result.returncode,0)
            self.assertFalse(self.trace.exists())

    def test_rejects_unrecognized_flags_without_calling_engine(self):
        result=self.run_cli('--yolo')
        self.assertNotEqual(result.returncode,0)
        self.assertFalse(self.trace.exists())

    def test_doctor_checks_engine_without_model_or_launch(self):
        result=self.run_cli('doctor')
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertIn('0.23.1',result.stdout)
        self.assertEqual(json.loads(self.trace.read_text())['args'],['--version'])

    def test_adopted_config_and_auth_are_unchanged(self):
        auth=self.hermes_home/'auth.json'; auth.write_text('PRIVATE_TEST_MARKER')
        yaml=self.hermes_home/'config.yaml'; yaml.write_text('user-owned-config')
        before={p:p.read_bytes() for p in [auth,yaml,self.config]}
        self.run_cli()
        self.assertEqual(before,{p:p.read_bytes() for p in before})


if __name__=='__main__': unittest.main()
