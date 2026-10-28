import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('dispatch', Path(__file__).with_name('dispatch.py'))
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)

class DispatchTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        d.ROOT = Path(self.tmp.name) / 'state'
        self.spec = dict(cwd=self.tmp.name, title='別件', prompt='原文 $(touch forbidden)\n二行目', reason='READMEで確認', engine='claude')

    def test_reservation_is_idempotent_and_detects_changed_request(self):
        self.assertTrue(d.prepare('id', self.spec)['created'])
        self.assertFalse(d.prepare('id', self.spec)['created'])
        with self.assertRaises(ValueError):
            d.prepare('id', dict(self.spec, cwd='/tmp'))

    def test_success_records_observed_session_and_never_relaunches(self):
        value = d.prepare('id', self.spec)
        row = dict(name=value['launchName'], cwd=self.tmp.name, id='12345678', sessionId='12345678-abcd', state='done')
        with patch.object(d, 'invoke', side_effect=[subprocess.CompletedProcess([], 0, 'backgrounded', ''), subprocess.CompletedProcess([], 0, json.dumps([row]), '')]) as run:
            self.assertEqual(d.launch('id')['sessionId'], '12345678-abcd')
            self.assertEqual(run.call_args_list[0].args[0][-1], self.spec['prompt'])
            with self.assertRaises(ValueError):
                d.launch('id')
            self.assertEqual(run.call_count, 2)

    def test_timeout_keeps_uncertain_reservation(self):
        d.prepare('id', self.spec)
        with patch.object(d, 'invoke', side_effect=subprocess.TimeoutExpired('claude', 45)):
            with self.assertRaises(subprocess.TimeoutExpired):
                d.launch('id')
        self.assertEqual(d.read('id')['state'], 'starting')
        with self.assertRaises(ValueError):
            d.launch('id')

    def test_untrusted_workspace_is_retained(self):
        d.prepare('id', self.spec)
        with patch.object(d, 'invoke', return_value=subprocess.CompletedProcess([], 1, '', 'Workspace not trusted')):
            with self.assertRaises(RuntimeError):
                d.launch('id')
        self.assertEqual(d.read('id')['state'], 'blocked')

    def test_wrong_cwd_cannot_be_recorded_as_started(self):
        value = d.prepare('id', self.spec)
        d.transition('id', ('prepared',), state='starting')
        with patch.object(d, 'invoke', return_value=subprocess.CompletedProcess([], 0, json.dumps([dict(name=value['launchName'], cwd='/', sessionId='wrong')]), '')):
            with self.assertRaises(RuntimeError):
                d.verify_claude(value)
        self.assertEqual(d.read('id')['state'], 'starting')

    def test_unset_config_directory_stays_unset(self):
        with patch.dict(d.os.environ, {}, clear=True):
            value = d.prepare('id', self.spec)
        self.assertIsNone(value['configDir'])
        with patch.object(d.subprocess, 'run') as run:
            d.invoke(['--help'], value)
            self.assertNotIn('CLAUDE_CONFIG_DIR', run.call_args.kwargs['env'])

    def test_codex_state_transition_preserves_prompt(self):
        d.prepare('id', dict(self.spec, engine='codex'))
        d.transition('id', ('prepared',), state='starting')
        receipt = d.transition('id', ('starting',), state='started', sessionId='thread-id', destination='codex://threads/thread-id')
        self.assertEqual(receipt['prompt'], self.spec['prompt'])
        with self.assertRaises(ValueError):
            d.transition('id', ('prepared',), state='starting')

if __name__ == '__main__':
    unittest.main()
