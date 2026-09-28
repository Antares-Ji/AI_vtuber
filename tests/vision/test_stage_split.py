"""Offline split checks: standard library only; never loads models or GPU runtimes."""
import hashlib
import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('stage_training', ROOT / 'scripts/train-stage-memory.py')
training = importlib.util.module_from_spec(spec)
spec.loader.exec_module(training)


class SplitTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = Path(self.tmp.name)
        self.frames = []
        for index, (session, split) in enumerate([('one', 'train'), ('two', 'train'), ('three', 'val')]):
            content = ('image-' + str(index)).encode()
            name = str(index) + '.png'
            (self.store / name).write_bytes(content)
            self.frames.append(dict(image=name, session=session, split=split, reviewed_by='test', sha256=hashlib.sha256(content).hexdigest()))

    def node_select(self, frames, ok=True):
        script = "const {selectFrames}=require('./scripts/benchmark-stage-latency');const input=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(JSON.stringify(selectFrames({frames:input.frames},{store:input.store})));"
        result = subprocess.run(['node', '-e', script], cwd=ROOT, input=json.dumps(dict(frames=frames, store=str(self.store))), capture_output=True, text=True)
        self.assertEqual(result.returncode == 0, ok, result.stderr)
        return json.loads(result.stdout) if ok else None

    def test_manifest_selection_for_both_models_and_benchmark(self):
        groups = training.partition_frames(self.frames, self.store)
        self.assertEqual([f['session'] for f in groups['train']], ['one', 'two'])
        self.assertEqual([f['session'] for f in groups['val']], ['three'])
        self.assertEqual(self.node_select(self.frames), groups['val'])
        self.assertEqual(training.split_report(self.frames)['train']['sessions'], ['one', 'two'])
        self.frames[1]['split'], self.frames[2]['split'] = 'val', 'train'
        self.assertEqual(self.node_select(self.frames), training.partition_frames(self.frames, self.store)['val'])

    def test_session_leak_rejected(self):
        self.frames[2]['session'] = 'one'
        with self.assertRaisesRegex(ValueError, 'Session leaks'):
            training.partition_frames(self.frames, self.store)
        self.node_select(self.frames, ok=False)

    def test_hash_leak_rejected_even_under_different_filename(self):
        (self.store/'2.png').write_bytes((self.store/'0.png').read_bytes())
        self.frames[2]['sha256'] = self.frames[0]['sha256']
        with self.assertRaisesRegex(ValueError, 'hash leaks'):
            training.partition_frames(self.frames, self.store)
        self.node_select(self.frames, ok=False)

    def test_changed_image_rejected(self):
        (self.store/'2.png').write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'hash differs'):
            training.partition_frames(self.frames, self.store)
        self.node_select(self.frames, ok=False)

    def test_unreviewed_excluded_and_empty_validation_rejected(self):
        self.frames[2]['reviewed_by'] = None
        with self.assertRaisesRegex(ValueError, 'Both reviewed'):
            training.partition_frames(self.frames, self.store)
        self.node_select(self.frames, ok=False)

    def test_real_manifest(self):
        frames = json.loads((training.STORE/'0-1.json').read_text(encoding='utf-8'))['frames']
        groups = training.partition_frames(frames)
        self.assertEqual({f['session'] for f in groups['train']}, {'attempt1', 'attempt2'})
        self.assertEqual({f['session'] for f in groups['val']}, {'attempt3'})
        self.store = training.STORE
        self.assertEqual(self.node_select(frames), groups['val'])

    def test_unassigned_sample_never_enters_training(self):
        self.frames.append(dict(image='does-not-exist.png', session='new', split='unassigned', reviewed_by='test'))
        groups = training.partition_frames(self.frames, self.store)
        self.assertEqual(sum(map(len, groups.values())), 3)
        self.assertEqual(len(self.node_select(self.frames)), 1)

    def test_runs_preserve_previous_outputs(self):
        old_root = training.ROOT
        training.ROOT = self.store
        try:
            first = training.create_run_directory()
            (first/'weights.pt').write_bytes(b'old-weights')
            second = training.create_run_directory()
            self.assertNotEqual(first, second)
            self.assertEqual((first/'weights.pt').read_bytes(), b'old-weights')
            self.assertTrue(second.is_dir())
        finally:
            training.ROOT = old_root


if __name__ == '__main__':
    unittest.main()
