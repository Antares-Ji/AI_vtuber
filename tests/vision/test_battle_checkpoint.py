"""Offline crash/restart checkpoint checks. No game, GUI or model imports."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('battle_checkpoint', ROOT/'scripts/battle_checkpoint.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CheckpointTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name)/'checkpoint.json'
        self.plan = [dict(name='风笛', facing='right'), dict(name='琴柳', facing='up')]
        self.cp = module.BattleCheckpoint.create(self.path, self.plan, 'battle-one')
        self.addCleanup(lambda: self.cp.close())

    def load(self):
        self.cp.close()
        self.cp = module.BattleCheckpoint.load(self.path, self.plan, 'battle-one')
        return self.cp

    def test_inflight_restart_must_not_replay(self):
        self.cp.begin_deploy('风笛', 8, 'selected.png')
        cp = self.load()
        self.assertEqual(cp.reconcile(8, [], 'battle-one', 'current.png'), 'pending')
        with self.assertRaisesRegex(ValueError, 'Unresolved'):
            cp.begin_deploy('风笛', 8, 'current.png')
        self.assertEqual(self.load().state['sequence'], 1)

    def test_already_landed_reconciles_once(self):
        self.cp.begin_deploy('风笛', 8, 'selected.png')
        cp = self.load()
        self.assertEqual(cp.reconcile(7, ['风笛'], 'battle-one', 'landed.png'), 'confirmed')
        self.assertEqual(cp.reconcile(7, ['风笛'], 'battle-one', 'fresh.png'), 'confirmed')
        self.assertEqual(cp.state['deployed'], ['风笛'])
        with self.assertRaisesRegex(ValueError, 'next undeployed'):
            cp.begin_deploy('风笛', 7, 'fresh.png')
        cp.begin_deploy('琴柳', 7, 'next-selected.png')
        cp.confirm_deploy('琴柳', 6, 'next-landed.png')
        self.assertEqual(self.load().state['deployed'], ['风笛', '琴柳'])

    def test_counter_alone_cannot_guess_landed_unit(self):
        self.cp.begin_deploy('风笛', 8, 'selected.png')
        for remaining, names in [(None, ['风笛']), (7, []), (7, ['琴柳']), (6, ['风笛', '琴柳'])]:
            with self.assertRaises(ValueError):
                self.cp.reconcile(remaining, names, 'battle-one', 'current.png')
        self.assertIsNotNone(self.load().state['inflight'])

    def test_identity_plan_and_sequence_required(self):
        self.cp.close()
        with self.assertRaises(ValueError):
            module.BattleCheckpoint.load(self.path, self.plan, 'other-battle')
        with self.assertRaises(ValueError):
            module.BattleCheckpoint.load(self.path, list(reversed(self.plan)), 'battle-one')
        with self.assertRaises(ValueError):
            module.BattleCheckpoint.create(self.path, self.plan, 'battle-one')
        state = json.loads(self.path.read_text())
        state['sequence'] = 2
        self.path.write_text(json.dumps(state))
        with self.assertRaises(ValueError):
            self.load()

    def test_skill_attempt_survives_restart_and_never_repeats(self):
        self.cp.begin_deploy('风笛', 8, 'selected.png')
        self.cp.confirm_deploy('风笛', 7, 'landed.png')
        self.cp.begin_skill('风笛', 'ready.png')
        cp = self.load()
        self.assertFalse(cp.state['skills']['风笛']['verified'])
        with self.assertRaises(ValueError):
            cp.begin_skill('风笛', 'ready-again.png')
        self.assertEqual(cp.reconcile(7, ['风笛'], 'battle-one', 'current.png'), 'pending')
        cp.confirm_skill('风笛', 'panel-closed.png')
        with self.assertRaises(ValueError):
            self.load().begin_skill('风笛', 'ready-again.png')

    def test_blocked_focus_has_no_new_input_permission(self):
        self.cp.block('focus epoch changed', 'recovered.png')
        with self.assertRaisesRegex(ValueError, 'Unresolved'):
            self.load().begin_deploy('风笛', 8, 'current.png')
        with self.assertRaisesRegex(ValueError, 'Blocked'):
            self.cp.reconcile(8, [], 'battle-one', 'current.png')

    def test_single_active_runner_and_release(self):
        with self.assertRaisesRegex(ValueError, 'another active runner'):
            module.BattleCheckpoint.load(self.path, self.plan, 'battle-one')
        with self.assertRaisesRegex(ValueError, 'another active runner'):
            module.BattleCheckpoint.create(self.path, self.plan, 'battle-one')
        cp = self.load()
        cp.begin_deploy('风笛', 8, 'current.png')

    def test_process_crash_releases_lock_but_keeps_inflight(self):
        self.cp.close()
        code = """import importlib.util,json,os,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('cp',Path(sys.argv[1])/'scripts/battle_checkpoint.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
cp=module.BattleCheckpoint.load(sys.argv[2],json.loads(sys.argv[3]),'battle-one')
cp.begin_deploy('风笛',8,'before-crash.png')
os._exit(0)
"""
        subprocess.run([sys.executable, '-B', '-c', code, str(ROOT), str(self.path),
                        json.dumps(self.plan)], check=True)
        cp = self.load()
        self.assertEqual(cp.reconcile(8, [], 'battle-one', 'fresh.png'), 'pending')
        with self.assertRaisesRegex(ValueError, 'Unresolved'):
            cp.begin_deploy('风笛', 8, 'fresh.png')

    def test_unknown_evidence_does_not_confirm(self):
        self.cp.begin_deploy('风笛', 8, 'selected.png')
        with self.assertRaises(ValueError):
            self.cp.confirm_deploy('风笛', 7, '')
        self.assertIsNotNone(self.load().state['inflight'])


if __name__ == '__main__':
    unittest.main()
