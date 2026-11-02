"""Build and run the actual native matcher on saved frames; no game process/input."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[2]


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--limit', type=int, default=11)
    parser.add_argument('--map-directory', type=Path)
    parser.add_argument('--source', type=Path, default=ROOT/'runtime/genshin/bettergi-chabao-b186')
    args = parser.parse_args()
    if not 1 <= args.limit <= 200:
        parser.error('limit must be in [1, 200]')
    if args.map_directory is None:
        settings = json.loads((ROOT/'data/genshin.local.json').read_text(encoding='utf-8-sig'))
        args.map_directory = Path(settings['bettergiExecutable']).parent/'Assets/Map/Teyvat'
    dotnet = shutil.which('dotnet') or str(Path(os.environ.get('ProgramFiles', 'C:/Program Files'))/'dotnet/dotnet.exe')
    output = ROOT/'runtime/genshin/offline-projection-build'
    subprocess.run([dotnet, 'build', str(ROOT/'scripts/genshin/offline-projection/OfflineProjection.csproj'),
                    '--artifacts-path', str(output/'artifacts'), '-o', str(output/'publish'),
                    '-c', 'Release', '-v:minimal', '-p:BetterGISource='+str(args.source.resolve())], check=True, timeout=120)
    subprocess.run([dotnet, str(output/'publish/OfflineProjection.dll'), str(args.input.resolve()),
                    str(args.map_directory.resolve()), str(args.output.resolve()), str(args.limit), str(args.source.resolve())],
                   check=True, timeout=60+args.limit*35)
