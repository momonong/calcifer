import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('wisp_core_install',Path(__file__).resolve().parents[1]/'install-core.py')
installer=importlib.util.module_from_spec(spec);spec.loader.exec_module(installer)


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        self.home=self.root/'home';self.home.mkdir()
        self.runtime=self.root/'runtime'
        for name,version in (('@opencode/sdk','2.1.4'),('bun','1.4.4')):
            path=self.runtime/'node_modules'/name;path.mkdir(parents=True)
            (path/'package.json').write_text(json.dumps({'version':version}))
        (self.runtime/'node_modules/@opencode/sdk/dist').mkdir()
        (self.runtime/'node_modules/@opencode/sdk/dist/index.js').write_text('export {};\n')
        (self.runtime/'node_modules/bun/bin').mkdir()
        binary=self.runtime/'node_modules/bun/bin/bun.exe'
        binary.write_text('#!/bin/sh\necho 1.4.4\n');binary.chmod(0o700)
        for name in ('auth.json','config.yaml'):(self.home/name).write_text('preserve-this-fixture')
    def tearDown(self):self.tmp.cleanup()
    def test_missing_explicit_profile_is_not_created_by_runtime_preparation(self):
        missing = self.root / 'mistyped-home'
        from unittest.mock import patch
        with patch.object(installer.subprocess, 'run', side_effect=AssertionError('npm must not start')):
            with self.assertRaisesRegex(ValueError, 'EXISTING_WISP_HOME_REQUIRED'):
                installer.prepare_runtime(missing)
        self.assertFalse(missing.exists())
    def test_install_and_managed_update_preserve_login_config_and_state(self):
        first=installer.install(self.home,self.runtime)
        self.assertFalse(first['activation_changed']);self.assertFalse(first['config_modified'])
        self.assertEqual(first['model_requests'],0)
        taskfile=self.home/'plugin-data/wisp-core/preserved.txt';taskfile.write_text('candidate evidence')
        second=installer.install(self.home,self.runtime)
        self.assertTrue(Path(second['backup']).is_dir())
        self.assertEqual(taskfile.read_text(),'candidate evidence')
        for name in ('auth.json','config.yaml'):self.assertEqual((self.home/name).read_text(),'preserve-this-fixture')
        self.assertTrue(Path(second['runtime']['worker']).is_file())
    def test_modified_or_foreign_plugin_is_never_overwritten(self):
        installer.install(self.home,self.runtime)
        plugin=self.home/'plugins/wisp-core'
        (plugin/'desktop/plugin.js').write_text('user modification')
        with self.assertRaisesRegex(ValueError,'MODIFIED'):installer.install(self.home,self.runtime)
        self.assertEqual((plugin/'desktop/plugin.js').read_text(),'user modification')
    def test_version_mismatch_or_symlink_is_refused(self):
        (self.runtime/'node_modules/@opencode/sdk/package.json').write_text('{"version":"next"}')
        with self.assertRaisesRegex(ValueError,'PINNED'):installer.install(self.home,self.runtime)
        link=self.root/'linked-home';link.symlink_to(self.home)
        with self.assertRaisesRegex(ValueError,'SYMLINK'):installer.install(link,self.runtime)


if __name__=='__main__':unittest.main()
