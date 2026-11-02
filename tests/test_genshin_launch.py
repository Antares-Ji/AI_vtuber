import importlib.util
from pathlib import Path
import types
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('genshin_launch', ROOT/'scripts/genshin/launch.py')
launch = importlib.util.module_from_spec(spec); spec.loader.exec_module(launch)


class LaunchTests(unittest.TestCase):
    def process(self, path):
        return types.SimpleNamespace(info={'name': Path(path).name}, exe=lambda: str(Path(path).resolve()))

    def test_empty_and_unrelated_processes(self):
        self.assertIsNone(launch.matching_process(Path('YuanShen.exe'), []))
        self.assertIsNone(launch.matching_process(Path('YuanShen.exe'), [self.process('SlayTheSpire2.exe')]))

    def test_existing_identity_and_conflicts(self):
        target = Path('YuanShen.exe'); process = self.process(target)
        self.assertIs(launch.matching_process(target, [process]), process)
        with self.assertRaisesRegex(RuntimeError, 'Multiple'):
            launch.matching_process(target, [process, self.process('GenshinImpact.exe')])
        with self.assertRaisesRegex(RuntimeError, 'Another'):
            launch.matching_process(target, [self.process('other/YuanShen.exe')])

    def test_unreadable_identity_is_not_treated_as_absence(self):
        process = self.process('YuanShen.exe')
        def denied(): raise PermissionError('denied')
        process.exe = denied
        with self.assertRaises(PermissionError):
            launch.matching_process(Path('YuanShen.exe'), [process])


if __name__ == '__main__': unittest.main()
