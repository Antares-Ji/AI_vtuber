"""Release archives must stay inside their own repository and exclude local data."""
from pathlib import Path
import subprocess
import tempfile
import unittest

from package_release import source_files, passing_tests


class TestReportsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_counts_tests_across_suites(self):
        for i in range(2):
            (self.root / f'TEST-{i}.xml').write_text('<testsuite tests="3" failures="0" errors="0" skipped="0"/>')
        self.assertEqual(6, passing_tests(self.root))

    def test_missing_and_empty_reports_cannot_pass(self):
        with self.assertRaises(RuntimeError):
            passing_tests(self.root)
        (self.root / 'TEST-empty.xml').write_text('<testsuite tests="0" failures="0" errors="0"/>')
        with self.assertRaises(RuntimeError):
            passing_tests(self.root)

    def test_failed_errored_and_skipped_reports_block_packaging(self):
        for field in ['failures', 'errors', 'skipped']:
            values = {'tests': 2, 'failures': 0, 'errors': 0, 'skipped': 0, field: 1}
            attrs = ' '.join(f'{key}="{value}"' for key, value in values.items())
            (self.root / 'TEST-bad.xml').write_text(f'<testsuite {attrs}/>')
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                passing_tests(self.root)


class SourceFilesTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        (self.root / 'README.md').write_text('Example project\n')

    def test_keeps_hidden_workflow_and_excludes_ignored_builds(self):
        (self.root / '.github/workflows').mkdir(parents=True)
        (self.root / '.github/workflows/build.yml').write_text('name: Build\n')
        (self.root / '.gitignore').write_text('build/\n')
        (self.root / 'build').mkdir()
        (self.root / 'build/private.txt').write_text('local only')
        files = source_files(self.root)
        self.assertEqual(files, ['.github/workflows/build.yml', '.gitignore', 'README.md'])

    def test_rejects_parent_git_root(self):
        child = self.root / 'child'
        child.mkdir()
        (child / 'README.md').write_text('Nested project')
        with self.assertRaisesRegex(RuntimeError, 'own Git root'):
            source_files(child)

    def test_rejects_credentials_even_when_force_tracked(self):
        (self.root / '.gitignore').write_text('*.key\n.env*\n')
        for name in ['test.key', '.env.local', 'test.pem']:
            with self.subTest(name=name):
                path = self.root / name
                path.write_text('test fixture, not a credential')
                subprocess.run(['git', '-C', str(self.root), 'add', '-f', name], check=True)
                with self.assertRaisesRegex(RuntimeError, 'Credential file'):
                    source_files(self.root)
                subprocess.run(['git', '-C', str(self.root), 'rm', '-f', name], check=True, stdout=subprocess.DEVNULL)

    def test_rejects_runtime_files_even_when_not_ignored(self):
        (self.root / 'saves').mkdir()
        (self.root / 'saves/world.dat').write_text('private world')
        with self.assertRaisesRegex(RuntimeError, 'private content'):
            source_files(self.root)

    def test_rejects_symbolic_links(self):
        try:
            (self.root / 'linked.md').symlink_to(self.root / 'README.md')
        except OSError as error:
            self.skipTest(f'Symlinks unavailable: {error}')
        with self.assertRaisesRegex(RuntimeError, 'regular file'):
            source_files(self.root)


if __name__ == '__main__':
    unittest.main()
