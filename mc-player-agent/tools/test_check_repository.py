from pathlib import Path
import tempfile
import unittest

from check_repository import check_sources


class RepositoryChecksTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.files = []

    def add(self, name, text):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding='utf-8')
        self.files.append(name)

    def test_allows_pure_core_and_game_dependencies_in_their_own_layer(self):
        self.add('harness/src/main/java/Core.java', 'import com.google.gson.JsonObject;\n/*\nimport net.minecraft.client.Minecraft;\n*/\n')
        self.add('game/src/main/java/Server.java', 'import net.minecraft.server.level.ServerPlayer;\n')
        self.add('game/src/client/java/Client.java', 'import net.minecraft.client.Minecraft;\n')
        self.assertEqual([], check_sources(self.root, self.files))

    def test_rejects_core_game_imports_and_common_client_static_imports(self):
        self.add('harness/src/main/java/Core.java', '/* header */\n\nimport net.minecraft.world.item.Item;\n')
        self.add('game/src/main/java/Server.java', 'import static net.minecraft.client.Minecraft.getInstance;\n')
        errors = check_sources(self.root, self.files)
        self.assertEqual(2, len(errors))
        self.assertTrue(any('Core.java:3:' in error for error in errors))
        self.assertTrue(any('Minecraft.getInstance' in error for error in errors))

    def test_rejects_project_client_types_and_wildcard_imports_in_common(self):
        self.add('game/src/client/java/dev/mcplayeragent/minecraft/PlayerControl.java', 'package dev.mcplayeragent.minecraft;\n')
        self.add('game/src/main/java/Server.java', 'import dev.mcplayeragent.minecraft.PlayerControl;\nimport dev.mcplayeragent.minecraft.*;\n')
        self.assertEqual(2, len(check_sources(self.root, self.files)))

    def test_rejects_upstream_runtime_imports_in_a_loader(self):
        self.add('fabric/src/main/java/Entry.java', 'import com.dwinovo.numen.Player;\n')
        errors = check_sources(self.root, self.files)
        self.assertEqual(1, len(errors))
        self.assertIn('forbidden layer dependency', errors[0])

    def test_accepts_local_links_anchors_spaces_and_external_links(self):
        self.add('docs/a file.md', '# Example\n')
        self.add('README.md', '[File](docs/a%20file.md#example) [File](<docs/a file.md>)\n'
                 '[Directory](docs/) [Web](https://example.com/missing) [Heading](#local)\n'
                 '```md\n[Example](not-a-file.md)\n```\n`[Example](also-not-a-file.md)`\n')
        self.assertEqual([], check_sources(self.root, self.files))

    def test_rejects_missing_or_unpublished_local_link_targets(self):
        self.add('generated.md', 'Not in the source archive')
        self.files.remove('generated.md')
        self.add('README.md', '[Missing](missing.md)\n[Generated](generated.md)\n')
        errors = check_sources(self.root, self.files)
        self.assertEqual(2, len(errors))
        self.assertIn('README.md:1:', errors[0])
        self.assertIn('README.md:2:', errors[1])

    def test_rejects_links_outside_the_repository(self):
        self.add('README.md', '[Private](../private.md)\n')
        errors = check_sources(self.root, self.files)
        self.assertEqual(1, len(errors))
        self.assertIn('leaves repository', errors[0])

    def test_rejects_absolute_paths_even_when_target_exists_locally(self):
        self.add('target.md', '# Target\n')
        self.add('README.md', f'[Absolute]({(self.root / "target.md").as_posix()})\n'
                 '[Windows](C:/project/target.md) [File](file:///project/target.md)\n')
        errors = check_sources(self.root, self.files)
        self.assertEqual(3, len(errors))
        self.assertTrue(all('not portable' in error for error in errors))

    def test_reports_malformed_urls_without_aborting_other_checks(self):
        self.add('README.md', '[Malformed](https://[invalid)\n[Missing](missing.md)\n')
        errors = check_sources(self.root, self.files)
        self.assertEqual(2, len(errors))
        self.assertIn('invalid link URL', errors[0])
        self.assertIn('not included in source', errors[1])


if __name__ == '__main__':
    unittest.main()
