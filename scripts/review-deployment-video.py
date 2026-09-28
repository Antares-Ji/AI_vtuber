"""Extract frames by independent recorder timestamps, never by nominal AVI FPS."""
import argparse,json
from pathlib import Path
import cv2,numpy as np

def main():
    p=argparse.ArgumentParser();p.add_argument('directory',type=Path);p.add_argument('--times',nargs='+',type=float,required=True);p.add_argument('--name',default='review');a=p.parse_args()
    if not (a.directory/'summary.json').exists():
        raise RuntimeError('Recording is still open or incomplete; finalize it before timestamp review')
    rows=[json.loads(line) for line in (a.directory/'timeline.jsonl').read_text().splitlines()]
    frames=[row for row in rows if row['event']=='frame']
    selected=[min(frames,key=lambda r:abs(r['capture_end_s']-t)) for t in a.times]
    video=cv2.VideoCapture(str(a.directory/'recording.avi'));cells=[]
    for row in selected:
        if not video.set(cv2.CAP_PROP_POS_FRAMES,row['index']):
            raise RuntimeError(f'Cannot seek to frame {row["index"]}')
        ok,frame=video.read()
        if not ok:raise RuntimeError(f'Cannot read frame {row["index"]}')
        if abs(video.get(cv2.CAP_PROP_POS_FRAMES) - (row['index']+1)) > 1:
            raise RuntimeError('Decoder frame position does not match timeline')
        cell=cv2.resize(frame,(480,326))
        cv2.rectangle(cell,(0,0),(250,25),(0,0,0),-1)
        cv2.putText(cell,f'T+{row["capture_end_s"]:.3f}s #{row["index"]}',(7,18),cv2.FONT_HERSHEY_SIMPLEX,.5,(255,255,255),1)
        cells.append(cell)
    video.release();columns=3;canvas=np.zeros((((len(cells)+columns-1)//columns)*326,columns*480,3),np.uint8)
    for index,cell in enumerate(cells):
        y,x=divmod(index,columns);canvas[y*326:(y+1)*326,x*480:(x+1)*480]=cell
    output=a.directory/(a.name+'.jpg');cv2.imwrite(str(output),canvas)
    (a.directory/(a.name+'.json')).write_text(json.dumps(selected,indent=2),encoding='utf8')
    print(output)

if __name__=='__main__':main()
