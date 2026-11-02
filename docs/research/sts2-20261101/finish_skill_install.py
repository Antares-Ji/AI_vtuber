"""Preserve the upstream support tree and repair cross-skill relative links."""
import hashlib,json,re,shutil,subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
source=ROOT/'runtime/research-skills-source'
home=Path('/mnt/c/Users/Antares.Ji/.codex')
bundle=home/'skill-resources/academic-research-skills'
if not bundle.exists():shutil.copytree(source,bundle,ignore=shutil.ignore_patterns('.git'))
names=['research-design','deep-research','academic-paper','research-presentations']
manifest={'repository':'https://github.com/kinqsradio/academic-research-skills','commit':subprocess.check_output(['git','-C',str(source),'rev-parse','HEAD'],text=True).strip(),'license':'MIT','support_bundle':str(bundle),'skills':[],'adaptation':'Only cross-directory Markdown links redirected to persistent upstream support bundle. No external scripts executed.'}
for name in names:
    dst=home/'skills'/name
    shutil.copy2(bundle/'LICENSE',dst/'LICENSE')
    for f in dst.rglob('*.md'):
        original=f.read_text(encoding='utf-8')
        rel=f.relative_to(dst)
        def replace(m):
            target=m.group(1)
            if not target.startswith('../'):return m.group(0)
            path,sep,anchor=target.partition('#')
            resolved=(bundle/'skills'/name/rel.parent/path).resolve()
            if resolved.exists():
                win='C:/Users/Antares.Ji/.codex/'+resolved.relative_to(home).as_posix()
                return ']('+win+(sep+anchor if sep else '')+')'
            return m.group(0)
        f.write_text(re.sub(r'\]\(([^)]+)\)',replace,original),encoding='utf-8')
    manifest['skills'].append({'name':name,'path':str(dst),'skill_sha256':hashlib.sha256((dst/'SKILL.md').read_bytes()).hexdigest()})
(Path(__file__).parent/'skills-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(manifest,ensure_ascii=False))
