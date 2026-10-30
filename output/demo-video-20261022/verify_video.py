import json
import subprocess
from pathlib import Path
from PIL import Image, ImageDraw
import imageio_ffmpeg
import requests

ROOT=Path(__file__).resolve().parent
FF=imageio_ffmpeg.get_ffmpeg_exe()
PROBE=r"D:\GPT-SoVITS-v2pro-20250604-nvidia50\runtime\ffprobe.exe"
MAIN=ROOT/'AI虚拟主播项目演示_4分钟.mp4'
SAMPLE=ROOT/'GPT-SoVITS实时语音样例_原片实录.mp4'

def probe(p):
    return json.loads(subprocess.check_output([PROBE,'-v','error','-show_format','-show_streams','-show_chapters','-of','json',str(p)]))

report={}
for label,p in [('main',MAIN),('sample',SAMPLE)]:
    info=probe(p); v=next(x for x in info['streams'] if x['codec_type']=='video'); a=next(x for x in info['streams'] if x['codec_type']=='audio')
    assert (v['width'],v['height'])==(1920,1080)
    expected=240 if label=='main' else 12.6
    assert abs(float(info['format']['duration'])-expected)<.08
    assert int(v['nb_frames'])==round(expected*30)
    p2=subprocess.run([FF,'-v','error','-xerror','-i',str(p),'-map','0:v:0','-map','0:a:0','-f','null','-'],capture_output=True,text=True)
    assert p2.returncode==0,p2.stderr
    report[label]={'path':str(p),'duration':info['format']['duration'],'frames':v['nb_frames'],'video':v['codec_name'],'resolution':[v['width'],v['height']],'audio':a['codec_name'],'sample_rate':a['sample_rate'],'bytes':p.stat().st_size,'full_decode':'passed','chapters':[x.get('tags',{}).get('title') for x in info.get('chapters',[])]}
    print(label,report[label],flush=True)

times=[2,17,48,64,85,110,121.5,132,161,201,229,235]
sheet=Image.new('RGB',(960*3,565*4),'#101820'); dr=ImageDraw.Draw(sheet)
for i,t in enumerate(times):
    dest=ROOT/f'final-{str(t).replace(".","_")}.jpg'
    subprocess.run([FF,'-y','-v','error','-ss',str(t),'-i',str(MAIN),'-frames:v','1',str(dest)],check=True)
    im=Image.open(dest); im.thumbnail((960,540),Image.Resampling.LANCZOS)
    sheet.paste(im,(i%3*960,i//3*565+25)); dr.text((i%3*960+10,i//3*565+5),f'{t:06.2f} sec',fill='white')
sheet.save(ROOT/'final-contact-sheet.jpg',quality=93)

checks=[]
for label,start,length in [('opening',0,10),('chat-narration',14,8),('original-gptsovits',58,15),('call-narration',75,6),('game-narration',116,6),('ending',232,8)]:
    wav=ROOT/f'qa-{label}.wav'
    subprocess.run([FF,'-y','-v','error','-ss',str(start),'-t',str(length),'-i',str(MAIN),'-vn','-ac','1','-ar','16000',str(wav)],check=True)
    r=requests.post('http://127.0.0.1:10095/transcribe',data=wav.read_bytes(),headers={'content-type':'audio/wav'},timeout=40)
    r.raise_for_status(); transcript=r.json()['text']
    assert len(transcript)>10, (label,transcript)
    checks.append({'range':[start,start+length],'type':label,'asr':transcript})
    print(checks[-1],flush=True)
report['audio_spot_checks']=checks
report['ai_narration_seconds']=round(sum(x['duration'] for x in json.loads((ROOT/'narration.json').read_text(encoding='utf-8'))),3)
report['ai_narration_ratio']=report['ai_narration_seconds']/240
(ROOT/'verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print('VERIFICATION COMPLETE',flush=True)
