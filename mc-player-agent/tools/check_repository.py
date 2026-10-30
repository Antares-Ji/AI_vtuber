"""Check explicit Java imports and inline local Markdown links; standard library only."""
import re
import subprocess
from urllib.parse import unquote, urlsplit

from package_release import ROOT, source_files


def check_sources(root, files):
    root = root.resolve()
    names = set(files)
    clients = {name.removeprefix('game/src/client/java/').removesuffix('.java').replace('/', '.')
               for name in names if name.startswith('game/src/client/java/') and name.endswith('.java')}
    errors = []
    for name in sorted(names):
        path = root / name
        if path.suffix == '.java':
            text = path.read_text(encoding='utf-8')
            # Preserve line numbers while ignoring commented-out import examples.
            text = re.sub(r'/\*.*?\*/|//[^\n]*', lambda match: '\n' * match[0].count('\n'), text, flags=re.S)
            for match in re.finditer(r'(?m)^[ \t]*import\s+(?:static\s+)?([\w.*]+)\s*;', text):
                target = match[1]
                core = name.startswith('harness/src/')
                common = name.startswith('game/src/main/')
                forbidden = target.startswith('com.dwinovo.numen.')
                if core:
                    forbidden |= target.startswith(('net.minecraft.', 'com.mojang.', 'net.fabricmc.',
                                                    'net.neoforged.', 'org.spongepowered.',
                                                    'dev.mcplayeragent.minecraft.', 'dev.mcplayeragent.fabric.',
                                                    'dev.mcplayeragent.neoforge.'))
                if common:
                    forbidden |= target.startswith(('net.minecraft.client.', 'net.fabricmc.', 'net.neoforged.'))
                if core or common:
                    forbidden |= any(target == client or target.startswith(client + '.')
                                     or target.endswith('.*') and client.startswith(target[:-1]) for client in clients)
                if forbidden:
                    line = text.count('\n', 0, match.start()) + 1
                    errors.append(f'{name}:{line}: forbidden layer dependency: {target}')
        elif path.suffix == '.md':
            fence = ''
            for number, line in enumerate(path.read_text(encoding='utf-8').splitlines(), 1):
                marker = re.match(r'^\s*(`{3,}|~{3,})', line)
                if marker:
                    if not fence:
                        fence = marker[1]
                    elif marker[1][0] == fence[0] and len(marker[1]) >= len(fence):
                        fence = ''
                    continue
                if fence:
                    continue
                line = re.sub(r'`+[^`]*`+', '', line)
                for match in re.finditer(r'\[[^\]\n]*\]\((<[^>\n]+>|[^)\s]+)(?:\s+"[^"]*")?\)', line):
                    raw = match[1].strip('<>')
                    if re.match(r'(?i)^(?:[a-z]:[/\\]|file:)', raw):
                        errors.append(f'{name}:{number}: absolute local link is not portable')
                        continue
                    try:
                        link = urlsplit(raw)
                    except ValueError:
                        errors.append(f'{name}:{number}: invalid link URL')
                        continue
                    if link.scheme or link.netloc or not link.path:
                        continue
                    if unquote(link.path).startswith(('/', '\\')):
                        errors.append(f'{name}:{number}: absolute local link is not portable')
                        continue
                    target = (path.parent / unquote(link.path)).resolve()
                    if not target.is_relative_to(root):
                        errors.append(f'{name}:{number}: local link leaves repository: {match[1]}')
                        continue
                    relative = target.relative_to(root).as_posix()
                    if relative not in names and relative != '.' and not any(n.startswith(relative + '/') for n in names):
                        errors.append(f'{name}:{number}: local link not included in source: {match[1]}')
    return errors


def main():
    try:
        files = source_files(ROOT)
        errors = check_sources(ROOT, files)
    except (OSError, RuntimeError, UnicodeError, subprocess.CalledProcessError) as error:
        print(f'Repository check could not complete: {error}')
        return 1
    if errors:
        print('\n'.join(errors))
        print(f'Repository checks failed: {len(errors)} issue(s).')
        return 1
    print(f'Repository checks passed: {len(files)} source files; explicit Java imports and local Markdown links.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
