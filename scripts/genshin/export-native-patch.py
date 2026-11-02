"""Run with WSL Python after editing the isolated pinned BetterGI worktree."""
from pathlib import Path
import subprocess
root=Path(__file__).resolve().parents[2]
source=root/'runtime/genshin/bettergi-custom'
commit=subprocess.check_output(['git','-C',str(source),'rev-parse','HEAD'],text=True).strip()
assert commit=='0af68c28f6b0e714d5304625ce644736d508022e', commit
subprocess.run(['git','-C',str(source),'diff','--check'],check=True)
patch=subprocess.check_output(['git','-C',str(source),'diff','--binary'])
assert b'PartyRecoveryScope.cs' in patch and b'new file mode' in patch
target=root/'scripts/genshin/patches/bettergi-0.66-party-recovery.patch'
target.parent.mkdir(parents=True,exist_ok=True)
target.write_bytes(patch)
print(f'Saved {len(patch)} bytes to {target}')
