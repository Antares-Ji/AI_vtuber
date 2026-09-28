"""Build a new teacher delivery archive from the original, without modifying it."""
import hashlib,json,shutil,sys,time,zipfile
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
BASE=ROOT/'output/AI_vtuber_training.zip'
TARGET=ROOT/'output/AI_vtuber_training_20260926_v2.zip'
PREFIX='updates/20260926/'

def digest(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda:f.read(4*1024*1024),b''):h.update(chunk)
    return h.hexdigest()

def collect():
    files=set()
    for directory in [ROOT/'runtime/vision/campaign-20260926',ROOT/'runtime/vision/profile-analysis-cache',ROOT/'output/arknights-review-20260926']:
        if directory.exists():files.update(p for p in directory.rglob('*') if p.is_file())
    for kind in ['stage-0-7','local-deployment','realtime-deployment','timing-recordings']:
        directory=ROOT/'runtime/vision'/kind
        if not directory.exists():continue
        for run in directory.iterdir():
            if not run.is_dir() or not run.name.isdigit():continue
            # Millisecond and nanosecond run ids share the same date prefix.
            if int(run.name[:10])<1790352000:continue
            closed=(run/'summary.json').exists()
            for p in run.rglob('*'):
                if p.is_file() and (p.suffix.lower()!='.avi' or closed):files.add(p)
    for pattern in ['local_stage_session.py','local-stage*.py','local-campaign*.py','campaign_analysis.py','campaign_stage.py','map_portals.py',
                    'local_battle_followup.py','current_deployment_geometry.py','local-result-watch.py','local-confirm-settlement.py',
                    'realtime-deployment.py','deployment-reference-check.py','battle_cost.py','battle_pause.py','battle_result.py','stage07_reference.py','local-pan-stage-map.py','local-dismiss-notices.py',
                    'arknights-native-worker.ps1','reload-arknights-controller.py','restore-arknights-layout.ps1','record-game-timing.py',
                    '*arknights*20260926.py','package-arknights-update.py','summarize-arknights-recordings.py']:
        files.update((ROOT/'scripts').glob(pattern))
    files.update((ROOT/'docs').glob('*20260926.md'))
    files.add(ROOT/'docs/arknights-control-memory.md')
    files.add(ROOT/'docs/arknights-opening-decision-flow.md')
    files.add(ROOT/'scripts/report-arknights-campaign.py')
    files.update((ROOT/'tests/vision').glob('test_local_session_evidence.py'))
    files.update((ROOT/'tests/vision').glob('test_current_deployment_geometry.py'))
    files.update((ROOT/'tests/vision').glob('test_local_battle_followup.py'))
    files.update((ROOT/'tests/vision').glob('test_battle_pause.py'))
    files.update((ROOT/'tests/vision').glob('test_battle_result.py'))
    files.update((ROOT/'tests/vision').glob('test_direction_crop.py'))
    files.update((ROOT/'tests/vision').glob('test_map_portals.py'))
    for reference_dir in ['data/vision/deployment-references','data/vision/operator-memory']:
        files.update(p for p in (ROOT/reference_dir).rglob('*') if p.is_file())
    for dependency in ['src/vision/windows-ocr.ps1','src/bot/win-control.ps1',
                       'runtime/vlm/training/deployment-tray-v1/fit/weights/best.pt']:
        files.add(ROOT/dependency)
    return sorted(p for p in files if p.is_file() and p.name not in ('token.txt','cancel','stop') and '__pycache__' not in p.parts)

def main():
    sys.stdout.reconfigure(encoding='utf8')
    if not BASE.exists():raise RuntimeError('Original archive missing')
    files=collect();snapshot=time.strftime('%Y-%m-%d %H:%M:%S %z')
    temp=TARGET.with_suffix('.partial.zip')
    shutil.copyfile(BASE,temp)
    manifest=[]
    with zipfile.ZipFile(temp,'a',compression=zipfile.ZIP_DEFLATED,compresslevel=1,allowZip64=True) as archive:
        for path in files:
            relative=path.relative_to(ROOT).as_posix();entry=PREFIX+relative
            # Snapshot bytes once, so size and hash exactly describe the archived file.
            if path.stat().st_size<32*1024*1024:
                data=path.read_bytes();archive.writestr(entry,data)
                sha=hashlib.sha256(data).hexdigest();size=len(data)
            else:
                before=path.stat();sha=digest(path);archive.write(path,entry);after=path.stat()
                if before.st_size!=after.st_size or before.st_mtime_ns!=after.st_mtime_ns:raise RuntimeError('Large file changed during packaging: '+relative)
                size=after.st_size
            manifest.append(dict(path=entry,bytes=size,sha256=sha))
        metadata=dict(snapshot=snapshot,base=BASE.name,base_preserved=True,new_weight_training_completed=False,
            original_archive_entries_preserved=True,new_files=manifest,
            notes=['Current campaign state is in output/arknights-review-20260926/campaign-state.json.',
                   'Raw local model outputs are proposals, not annotation truth.',
                   'Historical recording labels are sparse semantic review, not exhaustive frame boxes.',
                   'Included deployment-tray YOLO weights are existing reference weights, not retrained in this update.',
                   'Active recordings are omitted until finalized; screenshots and logs are included up to this snapshot.'])
        archive.writestr(PREFIX+'MANIFEST.json',json.dumps(metadata,ensure_ascii=False,indent=2).encode('utf8'))
        archive.writestr('README_UPDATE_20260926.txt',('新版增量目录：updates/20260926/\n快照时间：'+snapshot+'\n原包条目完整保留；本轮数据及代码位于增量目录。\n先看 GPT训练复盘.md、campaign-state.json 和 MANIFEST.json。\n本轮为本地千问/YOLO实战采样与控制优化，未完成新的权重训练。\n未核验预测不能直接作为监督训练真值。\n').encode('utf8'))
    with zipfile.ZipFile(temp) as archive:
        bad=archive.testzip()
        if bad:raise RuntimeError('Archive CRC check failed: '+bad)
        if len(archive.namelist())!=len(set(archive.namelist())):raise RuntimeError('Duplicate archive entry')
    temp.replace(TARGET)
    summary=dict(path=str(TARGET),snapshot=snapshot,bytes=TARGET.stat().st_size,new_files=len(manifest),sha256=digest(TARGET),crc_verified=True)
    TARGET.with_suffix('.manifest.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf8')
    print(json.dumps(summary,ensure_ascii=False),flush=True)

if __name__=='__main__':main()
