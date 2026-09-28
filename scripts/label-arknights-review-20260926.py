"""GPT-reviewed sparse frame labels; not dense YOLO training annotations."""
import json, csv, hashlib
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'output/arknights-review-20260926'
rows=json.loads((OUT/'recordings.json').read_text(encoding='utf8'))
# One entry per recording, ordered exactly as the reviewed overview sheets.
observations=[
('formation,battle,battle','single_operator;leaks'),
('stage_map,stage_map,stage_map','navigation_only'),
('stage_map,selection,selection','selection_without_verified_landing'),
('operator_profile,formation,battle','multiple_attempts_possible'),
('loading,result,battle','result_visible;multiple_battles'),
('stage_map,selection,battle','landing_visible'),
('loading,battle,stage_map','landing_visible;result_not_sampled'),
('formation,selection,battle','landing_visible'),
('formation,battle,battle','multiple_attempts_possible;landing_visible'),
('battle,result,result','result_visible;leaks'),
('black,black,battle','black_frames;landing_visible'),
('result,battle,battle','result_visible;multiple_battles'),
('battle,formation,result','result_visible;multiple_attempts_possible'),
('battle,stage_map,stage_map','multiple_operators;result_not_sampled'),
('battle,result,result','result_visible;multiple_operators'),
('battle,paused_profile,paused','pause_stall;multiple_operators'),
('paused,paused,result','pause_stall;result_visible'),
('battle,result,result','result_visible;multiple_operators'),
('','incomplete_recording'),
('result,black,result','black_frames;result_visible;prior_audit_available'),
('formation,result,formation','result_visible;multiple_attempts_possible'),
('formation,skill_ready,skill_ready','skill_ready_not_activation'),
('skill_ready,skill_ready,stage_map','skill_ready_not_activation'),
('formation,skill_ready,skill_ready','skill_ready_not_activation'),
('skill_ready,result,result','result_visible;skill_activation_not_proven_by_samples'),
('formation,selection,selection','high_ground_selection_stall'),
('battle,battle,result','result_visible;two_stars_prior_review;multiple_operators'),
('formation,paused_selection,paused_selection','pause_stall;continuation'),
('battle,battle,result','result_visible;three_stars_prior_review;continuation'),
('paused,paused_selection,paused','pause_stall;continuation'),
('battle,battle,stage_map','result_not_sampled;program_incomplete_prior_review'),
('formation,formation,formation','short_recording'),
('loading,battle,battle','practice;multiple_operators;result_not_sampled'),
('battle,paused,paused','practice;pause_stall;stage_identity_unverified'),
('paused,paused_selection,paused_selection','practice;pause_stall;stage_identity_unverified'),
('paused_selection,paused_selection,paused_selection','practice;pause_stall;stage_identity_unverified'),
('paused_direction,paused_direction,paused_direction','practice;pause_stall;stage_identity_unverified'),
]
assert len(rows)==len(observations)
for i,(row,(phases,tags)) in enumerate(zip(rows,observations)):
    row['reviewer']='GPT / Codex'
    row['review_scope']='three timestamp-based samples, plus explicitly cited historical reports; not complete video review'
    row['status']='sampled_visual_review' if row['sampled_frames'] else 'incomplete_recording'
    row['tags']=tags.split(';')
    row['stage']='0-1' if i<27 or i in (31,32) else '0-7' if i<31 else None
    row['stage_source']='map/layout and visible titles in samples' if row['stage'] else 'needs_title_evidence'
    row['outcome']='result_visible_unassigned_battle' if 'result_visible' in row['tags'] else 'unknown'
    for frame,phase in zip(row['sampled_frames'],phases.split(',')):
        frame['phase']=phase
        frame['reviewer']='GPT / Codex'
        frame['training_eligible']=False
    row['training_eligible']=False
    row['training_exclusion']='Sparse semantic review only; no audited bounding boxes or battle-level split.'
settings_video=ROOT/'video/2026-09-10 00-51-41.mp4'
settings=dict(recording_id='settings-20260910',stage=None,status='sampled_visual_review',
    outcome='not_a_battle',tags=['settings_game','settings_sound','home','duplicate_copy_excluded'],
    video=str(settings_video),reviewer='GPT / Codex',training_eligible=False,
    duplicate_path=str(ROOT/'runtime/vision/video-runs/settings-20260910-003705/images/2026-09-10 00-51-41.mp4'),
    video_sha256=hashlib.sha256(settings_video.read_bytes()).hexdigest(),sampled_frames=[])
for percent,phase in [(15,'settings_game'),(60,'settings_sound'),(98,'home')]:
    p=OUT/f'settings-{percent}.jpg'
    settings['sampled_frames'].append(dict(path=str(p),frame_index=int(2831*percent/100),
        video_time_s=int(2831*percent/100)/30,phase=phase,sha256=hashlib.sha256(p.read_bytes()).hexdigest(),training_eligible=False))
rows.append(settings)
(OUT/'labels.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2),encoding='utf8')
with (OUT/'labels.csv').open('w',encoding='utf-8-sig',newline='') as f:
    writer=csv.writer(f);writer.writerow(['recording_id','stage','status','outcome','tags','video'])
    for r in rows:writer.writerow([r['recording_id'],r['stage'],r['status'],r['outcome'],';'.join(r['tags']),r['video']])
print(f'{len(rows)} recording labels written; no training labels promoted')
