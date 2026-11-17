"""Preparation orchestration only; the actual vendor runtime needs Windows acceptance."""
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from wisp.test_powershell import PWSH

ROOT=Path(__file__).resolve().parent

@unittest.skipUnless(PWSH,'Portable PowerShell is required')
class WindowsEngineTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix="wisp engine 中文 '");self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.install=self.root/'Wisp'
        self.original=self.root/'original';self.original.mkdir()
        (self.original/'auth.json').write_text('private fixture')
        (self.original/'config.yaml').write_text('preserved settings')
        self.before={p:p.read_bytes() for p in self.original.iterdir()}
        self.vendor=self.root/'vendor.ps1'
        self.vendor.write_text('''param([string]$Stage,[string]$HermesHome,[string]$InstallDir,[string]$Commit,[string]$Channel,[switch]$NonInteractive,[switch]$SkipBrowser,[switch]$SkipComputerUse)
Add-Content -LiteralPath $env:WISP_TEST_STAGES -Value $Stage
if ($Stage -eq 'products') { Set-Content -LiteralPath $env:WISP_TEST_GLOBAL_CHANGE -Value 'unexpected PATH publication' }
if ($HermesHome -ne $env:WISP_TEST_EXPECTED_HOME) { Set-Content -LiteralPath $env:WISP_TEST_GLOBAL_CHANGE -Value 'unexpected home' }
if ($env:HERMES_PROFILE -or $env:HERMES_CONFIG) { Set-Content -LiteralPath $env:WISP_TEST_GLOBAL_CHANGE -Value 'unexpected inherited profile' }
if ($env:HERMES_RUNTIME_DIR) { Set-Content -LiteralPath $env:WISP_TEST_GLOBAL_CHANGE -Value 'unexpected inherited runtime store' }
if ($Stage -eq $env:WISP_TEST_FAIL_STAGE) { exit 73 }
if ($Stage -eq 'repository') {
    $dir=Join-Path $InstallDir 'hermes_cli'; [IO.Directory]::CreateDirectory($dir) | Out-Null
    [IO.File]::WriteAllText((Join-Path $dir '_launchers.py'), "from pathlib import Path; import sys; p=Path(sys.argv[1]); p.mkdir(parents=True,exist_ok=True); (p/'hermes.cmd').write_text('fixture launcher')")
}
exit 0
''')
        self.helper=self.root/'prepare.ps1'
        text=(ROOT/'prepare-windows-engine.ps1').read_text()
        text=text.replace('44bb5b021498c0bba95f77ac30b6c4676f3ffb7aa92ea48c731cd0940e941cdc',hashlib.sha256(self.vendor.read_bytes()).hexdigest())
        self.helper.write_text(text)
        self.calls=self.root/'stages.txt';self.changed=self.root/'global-change.txt'

    def run_prepare(self,**env):
        return subprocess.run([PWSH,'-NoLogo','-NoProfile','-File',str(self.helper),
            '-InstallRoot',str(self.install),'-BootstrapPython',sys.executable,'-InstallerFile',str(self.vendor)],
            env={**os.environ,'HERMES_HOME':str(self.original),'WISP_TEST_STAGES':str(self.calls),
                 'WISP_TEST_GLOBAL_CHANGE':str(self.changed),'WISP_TEST_EXPECTED_HOME':str(self.install/'hermes'),**env},
            capture_output=True,text=True,timeout=20)

    def test_prepares_owned_runtime_without_replacing_original_home_or_global_command(self):
        r=self.run_prepare();self.assertEqual(r.returncode,0,r.stderr)
        self.assertTrue((self.install/'hermes/bin/hermes.cmd').is_file())
        self.assertFalse((self.install/'hermes/auth.json').exists())
        self.assertFalse(self.changed.exists())
        self.assertEqual({p:p.read_bytes() for p in self.before},self.before)
        r=self.run_prepare();self.assertEqual(r.returncode,0,r.stderr)
        self.assertEqual({p:p.read_bytes() for p in self.before},self.before)

    def test_vendor_failure_stops_before_publishing_launcher(self):
        r=self.run_prepare(WISP_TEST_FAIL_STAGE='python-deps')
        self.assertNotEqual(r.returncode,0)
        self.assertFalse((self.install/'hermes/bin/hermes.cmd').exists())
        self.assertFalse(self.changed.exists())
        self.assertEqual({p:p.read_bytes() for p in self.before},self.before)

    def test_inherited_profile_overrides_cannot_reach_the_vendor_stages(self):
        r=self.run_prepare(HERMES_PROFILE='existing-profile',HERMES_CONFIG=str(self.original/'config.yaml'))
        self.assertEqual(r.returncode,0,r.stderr)
        self.assertFalse(self.changed.exists())

    def test_modified_vendor_installer_is_not_executed(self):
        self.vendor.write_text(self.vendor.read_text()+'\n# changed\n')
        r=self.run_prepare();self.assertNotEqual(r.returncode,0)
        self.assertFalse(self.calls.exists())
        self.assertFalse((self.install/'hermes').exists())

    def test_existing_runtime_store_cannot_reach_the_vendor_stages(self):
        r=self.run_prepare(HERMES_RUNTIME_DIR=str(self.original/'tools'))
        self.assertEqual(r.returncode,0,r.stderr)
        self.assertFalse(self.changed.exists())
        self.assertEqual({p:p.read_bytes() for p in self.before},self.before)

    def test_unowned_data_directory_is_preserved(self):
        data=self.install/'hermes';data.mkdir(parents=True)
        auth=data/'auth.json';auth.write_text('existing unrelated login')
        r=self.run_prepare();self.assertNotEqual(r.returncode,0)
        self.assertEqual(auth.read_text(),'existing unrelated login')
        self.assertFalse(self.calls.exists())

    def test_existing_wisp_config_is_not_repointed(self):
        self.install.mkdir();config=self.install/'config.json';config.write_text('existing Wisp')
        r=self.run_prepare();self.assertNotEqual(r.returncode,0)
        self.assertEqual(config.read_text(),'existing Wisp')
        self.assertFalse(self.calls.exists())

if __name__=='__main__':unittest.main()
