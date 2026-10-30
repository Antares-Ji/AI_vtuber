import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('preserve', Path(__file__).resolve().parents[1] / 'scripts/preserve-local-learning.py')
preserve = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preserve)


class PreservationTest(unittest.TestCase):
    def test_copy_and_active_sqlite_wal_without_overwriting_source(self):
        with tempfile.TemporaryDirectory() as folder:
            source, destination = Path(folder) / 'source', Path(folder) / 'snapshot'
            (source / 'data/sts2').mkdir(parents=True)
            knowledge = source / 'data/sts2/knowledge.json'
            knowledge.write_text('{"version": 1}')
            with sqlite3.connect(source / 'data/memory.db') as database:
                database.execute('PRAGMA journal_mode=WAL')
                database.execute('CREATE TABLE memories(content TEXT)')
                database.execute("INSERT INTO memories VALUES ('retained')")
                database.commit()
                report = preserve.preserve(source, destination)
                self.assertEqual(report['copied_files'], 2)
                with sqlite3.connect(destination / 'data/memory.db') as copied:
                    self.assertEqual(copied.execute('SELECT content FROM memories').fetchone()[0], 'retained')
                self.assertEqual(knowledge.read_bytes(), (destination / 'data/sts2/knowledge.json').read_bytes())
                self.assertTrue((destination / 'SNAPSHOT_COMPLETE').exists())
                with self.assertRaises(ValueError):
                    preserve.preserve(source, destination)

    def test_snapshot_cannot_recurse_into_source_material(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            with self.assertRaises(ValueError):
                preserve.preserve(root, root / 'data/sts2/snapshot')


if __name__ == '__main__':
    unittest.main()
