"""Package the local standalone build, corresponding source and verification results.
Run both loader GameTests before this script. Uses Python standard library only.
"""
from pathlib import Path
import argparse
import hashlib
import json
import subprocess
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def source_files(root):
    root = root.resolve()
    top = subprocess.check_output(['git', '-C', str(root), 'rev-parse', '--show-toplevel'], text=True).strip()
    if Path(top).resolve() != root:
        raise RuntimeError('Source directory must be its own Git root; refusing a parent repository')
    names = subprocess.check_output(['git', '-C', str(root), 'ls-files', '--cached', '--others', '--exclude-standard', '-z']).decode('utf-8').split('\0')
    files = sorted(set(filter(None, names)))
    if not files:
        raise RuntimeError('No source files found')
    for name in files:
        relative = Path(name)
        path = root / relative
        if relative.is_absolute() or '..' in relative.parts or not path.resolve().is_relative_to(root):
            raise RuntimeError(f'Source path escapes repository: {name}')
        if any(part in {'.git', '.gradle', 'build', 'runs', 'dist', '__pycache__', 'config', 'saves', 'logs', 'crash-reports'} for part in relative.parts):
            raise RuntimeError(f'Generated or private content in source list: {name}')
        if relative.suffix.lower() in {'.key', '.pem', '.pyc'} or (relative.name.startswith('.env') and relative.name != '.env.example'):
            raise RuntimeError(f'Credential file in source list: {name}')
        if path.is_symlink() or any(p.is_symlink() for p in path.parents if p.is_relative_to(root)) or not path.is_file():
            raise RuntimeError(f'Source must be a regular file: {name}')
    return files


def passing_tests(directory):
    suites = [ET.parse(p).getroot() for p in directory.glob('TEST-*.xml')]
    count = sum(int(s.attrib['tests']) for s in suites)
    if not count or any(int(s.attrib['failures']) + int(s.attrib['errors']) + int(s.attrib.get('skipped', 0)) for s in suites):
        raise RuntimeError(f'Test reports must pass with no failures, errors or skipped tests: {directory}')
    return count


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, default=ROOT / 'dist')
    args = parser.parse_args()
    files = source_files(ROOT)
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    properties = dict(line.split('=', 1) for line in (ROOT / 'gradle.properties').read_text().splitlines() if '=' in line)
    version = properties['agent_version']
    report = {'project': 'MC Player Agent', 'version': version, 'minecraft': '1.21.1',
              'unit_tests': passing_tests(ROOT / 'harness/build/test-results/test'),
              'extension_tests': passing_tests(ROOT / 'examples/collect-return/build/test-results/test'),
              'unit_failures': 0, 'loaders': {},
              'limitations': ['Client console visual/interaction test pending', 'Client gameplay endurance pending', 'Live model integration not validated for this Alpha', 'External skill demonstrated in simulation; loader-specific extension installation not validated', 'GitHub-hosted CI must be checked on the uploaded commit'],
              'provenance': {'files_absent_from_original_download': 57, 'origin_files_present': 4}}
    jars = {}
    for loader in ['fabric', 'neoforge']:
        log = (ROOT / loader / 'runs/gametestserver/logs/latest.log').read_text(encoding='utf-8')
        if 'All 3 required tests passed' not in log:
            raise RuntimeError(f'{loader}: three passing native GameTests required')
        jar = ROOT / loader / 'build/libs' / f'mcplayeragent-{loader}-{version}.jar'
        with zipfile.ZipFile(jar) as archive:
            names = archive.namelist()
            classes = [n for n in names if n.endswith('.class')]
            if any('com/dwinovo/' in n or '/gametest/' in n or n.endswith('.key') for n in names):
                raise RuntimeError(f'{loader}: unexpected legacy/test/private content')
            if any(b'com/dwinovo/numen' in archive.read(n) for n in classes):
                raise RuntimeError(f'{loader}: legacy bytecode reference')
            for required in ['dev/mcplayeragent/harness/AgentHarness.class', 'dev/mcplayeragent/mission/MissionRun.class', 'dev/mcplayeragent/minecraft/MissionControlScreen.class', 'LICENSE', 'COPYING', 'NOTICE']:
                if required not in names:
                    raise RuntimeError(f'Missing {required}')
        jars[loader] = jar
        report['loaders'][loader] = {'gametests_passed': 3, 'classes': len(classes),
                                     'jar_sha256': hashlib.sha256(jar.read_bytes()).hexdigest()}
    source = output / f'mcplayeragent-{version}-source.zip'
    with zipfile.ZipFile(source, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name in files:
            archive.write(ROOT / name, 'mc-player-agent/' + name)
    reportfile = output / f'mcplayeragent-{version}-verification.json'
    reportfile.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    outputs = [source, reportfile]
    for loader, jar in jars.items():
        package = output / f'mcplayeragent-{version}-{loader}-1.21.1.zip'
        with zipfile.ZipFile(package, 'w', zipfile.ZIP_DEFLATED) as archive:
            archive.write(jar, 'mods/' + jar.name)
            for name in ['README.md', 'CHANGELOG.md', 'NOTICE', 'LICENSE', 'COPYING', 'provenance.json']:
                archive.write(ROOT / name, name)
            archive.write(source, source.name)
            archive.write(reportfile, reportfile.name)
            archive.writestr('安装说明.txt', f'MC Player Agent {version} / {loader} / Minecraft 1.21.1\n'
                             '将 mods 中的 JAR 放入对应实例。替换旧版本 JAR，不要同时安装多个版本。Fabric 还需 Fabric API。\n'
                             'F8 打开任务控制台，F9 急停。当前支持单人世界和本机局域网房主。\n'
                             '旧 Numen 模组请移出 mods 并保留备份，避免两个接管系统同时运行。\n'
                             '详细配置、来源与限制见 README。对应源码和许可证已随包提供。\n')
        with zipfile.ZipFile(package) as archive:
            if archive.testzip() is not None:
                raise RuntimeError('Corrupt release archive')
        outputs.append(package)
        print(package)
    checksums = ''.join(hashlib.sha256(p.read_bytes()).hexdigest() + '  ' + p.name + '\n' for p in outputs)
    (output / f'mcplayeragent-{version}-SHA256SUMS.txt').write_text(checksums, encoding='utf-8')
    print(f'{report["unit_tests"]} core tests; {report["extension_tests"]} extension tests; 3 native GameTests per loader. {len(files)} source files.')


if __name__ == '__main__':
    main()
