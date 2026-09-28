"""Export observed roster evidence with explicit review and inference boundaries."""
import json,subprocess,sys,shutil
from pathlib import Path
import cv2,numpy as np
from operator_evidence import range_grid,selected_skill_box,recovery_kind
ROOT=Path(__file__).resolve().parents[1]
def main():
    sys.stdout.reconfigure(encoding='utf8');observed={}
    for file in sorted((ROOT/'runtime/vision/roster').glob('branches-*/profiles.json')):
        for row in json.loads(file.read_text(encoding='utf8')):observed[row['expected']]=row
    known=[('伊内丝','先锋','情报官'),('风笛','先锋','冲锋手'),('维什戴尔','狙击','投掷手'),('Mon3tr','医疗','链愈师'),
           ('新约能天使','特种','怪杰'),('圣聆初雪','术师','阵法术师'),('琴柳','先锋','执旗手'),('黍','重装','守护者'),
           ('遥','辅助','护佑者'),('酒神','辅助','巫役'),('予愿安洁莉娜','特种','巡空者'),('望','特种','陷阱师')]
    output=ROOT/'data/vision/operator-memory';output.mkdir(parents=True,exist_ok=True)
    rows=[];cells=[]
    for index,(name,profession,branch) in enumerate(known):
        row=observed[name];source=Path(row['skills_directory']);image=cv2.resize(cv2.imread(str(source/'after.png')),(1600,1024))
        folder=output/f'operator-{index+1:02}';folder.mkdir(exist_ok=True)
        shutil.copy2(source/'attack-range.png',folder/'attack-range.png')
        cv2.imwrite(str(folder/'profile.png'),image[:,:420])
        branch_image=cv2.resize(cv2.imread(str(Path(row['branch_directory'])/'after.png')),(1600,1024))
        cv2.imwrite(str(folder/'branch.png'),branch_image[:,:420])
        box=selected_skill_box(image);selected_text=None
        if box:
            x1,y1,x2,y2=box;skill=image[y1:y2,x1:x2];path=folder/'selected-skill.png';cv2.imwrite(str(path),skill)
            ocr=folder/'selected-skill-ocr.png';cv2.imwrite(str(ocr),cv2.resize(skill,None,fx=3,fy=3))
            done=subprocess.run(['powershell','-NoProfile','-ExecutionPolicy','Bypass','-File',str(ROOT/'src/vision/windows-ocr.ps1'),'-ImagePath',str(ocr)],capture_output=True,timeout=20,creationflags=subprocess.CREATE_NO_WINDOW)
            if done.returncode==0:
                parsed=json.loads(done.stdout.decode('utf-8-sig'));selected_text=parsed['text'];(folder/'selected-skill-ocr.json').write_text(json.dumps(parsed,ensure_ascii=False,indent=2),encoding='utf8')
        rg=range_grid(cv2.imread(str(folder/'attack-range.png')))
        item=dict(name=name,profession=profession,branch=branch,
            classification_source='Reviewed current game branch text and class icons; not raw Qwen roster predictions',
            name_verification='manual screenshot review: Shu/黍; Windows OCR abstained' if name=='黍' else 'profile OCR cross-check',
            detail_cost=row['ocr']['cost'],battle_cost_policy='Read current card affordability and live DP; talents/level rules may change costs',
            selected_skill_text=selected_text,selected_skill_clipped=bool(box and box[3]>=1024),
            recovery=recovery_kind(selected_text),range=rg,
            branch_text=row['ocr']['skills'],all_visible_skills=row['skills'],
            source=str(source.relative_to(ROOT)),reference_directory=str(folder.relative_to(ROOT)),
            deployment_verified=False,automatic_replay_allowed=False)
        rows.append(item)
        # Range sheet labels use slot numbers; names are mapped in JSON/report.
        cell=np.zeros((180,330,3),np.uint8)+245
        im=cv2.resize(cv2.imread(str(folder/'attack-range.png')),(230,162));cell[18:180,100:330]=im
        cv2.putText(cell,f'#{index+1}',(15,45),cv2.FONT_HERSHEY_SIMPLEX,.8,(20,20,20),2);cells.append(cell)
    canvas=np.concatenate([np.concatenate(cells[i:i+3],axis=1) for i in range(0,12,3)],axis=0);cv2.imwrite(str(output/'range-sheet.png'),canvas)
    report=dict(schema_version=1,date='2026-09-12',squad='高难对策',operators=rows,
        limitations=['Base range only; active skill range must be inspected separately','New classes are reference annotations, not a newly trained universal YOLO','Uncertain or clipped skill text must not drive autonomous actions'])
    (output/'current-squad.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
    print(json.dumps(dict(operators=len(rows),directory=str(output)),ensure_ascii=False))
if __name__=='__main__':main()
