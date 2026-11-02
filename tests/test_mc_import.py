import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('mc_import', Path(__file__).resolve().parents[1] / 'scripts/check-mc-import.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ImportTest(unittest.TestCase):
    def fixture(self, root):
        (root / 'docs/integration').mkdir(parents=True)
        (root / 'mc-player-agent').mkdir()
        original = 'mc-player-agent/README.md'
        addition = 'mc-player-agent/extra.md'
        (root / original).write_bytes(b'original\n')
        (root / addition).write_bytes(b'integration\n')
        archive = root / 'original.zip'
        with zipfile.ZipFile(archive, 'w') as file:
            file.writestr(original, b'original\n')
        manifest = {'archive_path': 'original.zip', 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
                    'files': {original: hashlib.sha256(b'original\n').hexdigest()}, 'lf_sha256': {},
                    'integration_additions': {addition: {'lf_sha256': hashlib.sha256(b'integration\n').hexdigest()}}}
        self.save(root, manifest)
        return manifest, addition

    def save(self, root, manifest):
        (root / 'docs/integration/import-manifest.json').write_text(json.dumps(manifest), encoding='utf-8')

    def test_addition_is_verified_without_replacing_archive(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            _, addition = self.fixture(root)
            module.verify(root)
            (root / addition).write_text('modified', encoding='utf-8')
            with self.assertRaisesRegex(RuntimeError, 'addition changed'):
                module.verify(root)

    def test_addition_cannot_replace_original(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            manifest, addition = self.fixture(root)
            manifest['integration_additions'][next(iter(manifest['files']))] = manifest['integration_additions'][addition]
            self.save(root, manifest)
            with self.assertRaisesRegex(RuntimeError, 'replaces an original'):
                module.verify(root)

    def test_addition_cannot_escape_subtree(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            manifest, addition = self.fixture(root)
            manifest['integration_additions']['mc-player-agent/../outside'] = manifest['integration_additions'][addition]
            self.save(root, manifest)
            with self.assertRaisesRegex(RuntimeError, 'Invalid import path'):
                module.verify(root)


if __name__ == '__main__':
    unittest.main()
