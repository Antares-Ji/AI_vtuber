"""Reproducible four-minute edit of the user's recording; no source is modified."""
import json
import math
import subprocess
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import imageio_ffmpeg

ROOT = Path(__file__).resolve().parent
SOURCE = Path(r"C:\Users\Antares.Ji\Videos\2026-10-22 21-24-09.mp4")
FF = imageio_ffmpeg.get_ffmpeg_exe()
PROBE = r"D:\GPT-SoVITS-v2pro-20250604-nvidia50\runtime\ffprobe.exe"
FONT = "C:/Windows/Fonts/msyh.ttc"
BOLD = "C:/Windows/Fonts/msyhbd.ttc"
W, H = 1920, 1080
MINT = "#9ce0ca"
WHITE = "#eff6f4"
MUTED = "#91a8aa"
EARLY = (850, 80, 1740, 1160)
CALL = (1295, 110, 1230, 1000)
LATE = (1060, 155, 1740, 1160)
GAME = (1550, 180, 1340, 674)

def run(args, name):
    with (ROOT / (name + ".log")).open("w", encoding="utf-8") as log:
        p = subprocess.run([FF, "-y", "-hide_banner", "-nostdin", *args], stdout=log, stderr=subprocess.STDOUT)
    if p.returncode:
        raise RuntimeError(name + ": " + (ROOT / (name + ".log")).read_text(encoding="utf-8")[-2500:])

def text(draw, pos, label, size, fill=WHITE, bold=False):
    draw.text(pos, label, fill=fill, font=ImageFont.truetype(BOLD if bold else FONT, size))

def background():
    im = Image.new("RGB", (W, H))
    dr = ImageDraw.Draw(im)
    for y in range(H):
        a = y / H
        dr.line((0, y, W, y), fill=(int(10+5*a), int(18+12*a), int(25+10*a)))
    dr.line((64, 87, 1856, 87), fill="#274047", width=1)
    dr.ellipse((65, 44, 76, 55), fill=MINT)
    text(dr, (91, 31), "AI_VTUBER", 25, bold=True)
    text(dr, (1458, 35), "项目实录  /  2026.10.22", 19, MUTED)
    return im

def wrap_cn(draw, value, x, y, width=330, size=25, fill=MUTED, line=40):
    font = ImageFont.truetype(FONT, size)
    row = ""
    for ch in value:
        if ch == '\n':
            draw.text((x,y), row, font=font, fill=fill); y += line; row = ""; continue
        if draw.textlength(row + ch, font=font) > width:
            draw.text((x,y), row, font=font, fill=fill); y += line; row = ch
        else:
            row += ch
    if row:
        draw.text((x,y), row, font=font, fill=fill)
    return y + line

def panel_asset(key, chapter, title, note, badge="现场实录", sample=False):
    im = background(); dr = ImageDraw.Draw(im)
    text(dr, (64, 136), f"0{chapter}", 100, MINT, True)
    y = 276
    for row in title.split("|"):
        text(dr, (64, y), row, 43, WHITE, True); y += 63
    dr.line((65, y+20, 159, y+20), fill=MINT, width=4)
    wrap_cn(dr, note, 65, y+60, size=24)
    for i, label in enumerate(["弹幕输入", "语音通话", "游戏互动"], 1):
        yy = 730 + 56*(i-1)
        dr.ellipse((66, yy+12, 74, yy+20), fill=MINT if i == chapter else "#3a5258")
        text(dr, (94, yy), f"0{i}  {label}", 23, MINT if i == chapter else MUTED, i == chapter)
    dr.rounded_rectangle((64, 938, 397, 982), 12, fill="#19382f")
    text(dr, (80, 944), badge, 20, MINT)
    dr.rounded_rectangle((482, 114, 1859, 982), 18, fill="#10191e", outline="#30474c", width=2)
    text(dr, (64, 1033), "AI VTUBER  /  功能演示", 17, MUTED)
    text(dr, (1600, 1033), "现场操作 · 原速保留", 17, MUTED)
    p = ROOT / f"layout-{key}.png"; im.save(p)
    return p

def still_card(key, number, title, subtitle, preview=None, outro=False):
    im = background(); dr = ImageDraw.Draw(im)
    text(dr, (76, 174), number, 130 if len(number) < 4 else 36, MINT, True)
    lines = title.split("|")
    yy = 360
    for row in lines:
        text(dr, (80, yy), row, 70, bold=True); yy += 100
    wrap_cn(dr, subtitle, 84, yy+28, width=820, size=27, line=46)
    if preview:
        pic = Image.open(preview).convert("RGB")
        # A genuine frame, cropped to the application's own UI.
        crop = LATE if "235" in str(preview) else EARLY
        x,y,w,h = crop; pic = pic.crop((x,y,x+w,y+h))
        pic.thumbnail((815, 650), Image.Resampling.LANCZOS)
        box = (1010, 232, 1840, 897)
        dr.rounded_rectangle(box, 22, fill="#152329", outline="#365650", width=2)
        im.paste(pic, (1020+(810-pic.width)//2, 240+(645-pic.height)//2))
    else:
        for i, (a,b) in enumerate([("01", "弹幕输入"),("02", "语音通话"),("03", "游戏互动")]):
            yy = 294 + i * 168
            dr.rounded_rectangle((1125, yy, 1790, yy+125), 20, fill="#152b2e", outline="#345452")
            text(dr, (1160, yy+31), a, 39, MINT, True)
            text(dr, (1250, yy+35), b, 34, WHITE, True)
    text(dr, (84, 975), "弹幕输入  /  语音通话  /  杀戮尖塔 2", 24, MINT)
    p = ROOT / (key + ".png"); im.save(p); return p

ENC = ["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "19", "-b:v", "0", "-pix_fmt", "yuv420p", "-r", "30", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"]
segments = []

def card(key, seconds, *args, **kwargs):
    asset = still_card(key, *args, **kwargs)
    out = ROOT / f"seg-{len(segments):02d}-{key}.mp4"
    run(["-loop", "1", "-framerate", "30", "-i", str(asset), "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-vf", "fade=t=in:st=0:d=0.20,fade=t=out:st="+str(seconds-.2)+":d=0.20", "-t", str(seconds), *ENC, str(out)], key)
    segments.append({"file":out.name,"duration":seconds,"kind":"card","title":args[1]})
    print("Rendered", out.name, flush=True)

def footage(key, start, end, crop, chapter, title, note, badge="现场实录"):
    asset = panel_asset(key, chapter, title, note, badge)
    out = ROOT / f"seg-{len(segments):02d}-{key}.mp4"
    x,y,w,h = crop
    fit = min(1370/w, 862/h)
    ow,oh = int(w*fit)//2*2,int(h*fit)//2*2
    ox,oy = 486+(1370-ow)//2,118+(862-oh)//2
    graph = f"[0:v]crop={w}:{h}:{x}:{y},scale={ow}:{oh}:flags=lanczos,setsar=1[v];[1:v][v]overlay={ox}:{oy}:shortest=1,format=yuv420p[out]"
    run(["-ss", str(start), "-t", str(end-start), "-i", str(SOURCE), "-loop", "1", "-framerate", "30", "-i", str(asset), "-filter_complex", graph, "-map", "[out]", "-map", "0:a:0", "-af", f"volume=0.85,afade=t=in:st=0:d=0.025,afade=t=out:st={end-start-.025}:d=0.025,apad,atrim=0:{end-start}", "-t", str(end-start), *ENC, str(out)], key)
    segments.append({"file":out.name,"duration":end-start,"kind":"source","source_in":start,"source_out":end,"crop":crop,"title":title.replace('|','')})
    print("Rendered", out.name, flush=True)

def source_still(key, seconds, frame, crop, chapter, title, note):
    asset = panel_asset(key,chapter,title,note,"原片画面 · 定格展示")
    im=Image.open(asset); pic=Image.open(ROOT/f'detail-{frame}.png')
    x,y,w,h=crop; pic=pic.crop((x,y,x+w,y+h)); pic.thumbnail((1370,862),Image.Resampling.LANCZOS)
    im.paste(pic,(486+(1370-pic.width)//2,118+(862-pic.height)//2)); im.save(asset)
    out=ROOT/f"seg-{len(segments):02d}-{key}.mp4"
    run(["-loop","1","-framerate","30","-i",str(asset),"-f","lavfi","-i","anullsrc=r=48000:cl=stereo","-t",str(seconds),*ENC,str(out)],key)
    segments.append({"file":out.name,"duration":seconds,"kind":"source-still","source_frame":frame,"title":title.replace('|','')})

def timestamp(t, ass=False):
    if ass:
        c = round(t*100); return f"{c//360000}:{c//6000%60:02}:{c//100%60:02}.{c%100:02}"
    c = round(t*1000); return f"{c//3600000:02}:{c//60000%60:02}:{c//1000%60:02},{c%1000:03}"

def final_mix():
    assert sum(s["duration"] for s in segments) == 240
    cursor=0
    for s in segments: s["timeline_in"]=cursor; cursor+=s["duration"]; s["timeline_out"]=cursor
    (ROOT/"edit-manifest.json").write_text(json.dumps({"source":str(SOURCE),"duration":240,"segments":segments,"sample_source":[61.8,74.4]},ensure_ascii=False,indent=2),encoding="utf-8")
    (ROOT/"concat.txt").write_text("\n".join("file '"+s['file']+"'" for s in segments),encoding="utf-8")
    run(["-f","concat","-safe","0","-i",str(ROOT/"concat.txt"),"-c","copy",str(ROOT/"picture-edit.mp4")],"concat")
    lines=json.loads((ROOT/"narration.json").read_text(encoding="utf-8"))
    ass="""[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\nWrapStyle: 0\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\nStyle: Narr,Microsoft YaHei,28,&H00F6F6F0,&H000000FF,&H00101B1D,&HC0101B1D,0,0,0,0,100,100,0,0,3,8,0,2,80,80,66,1\nStyle: Tag,Microsoft YaHei,20,&H00CAE09C,&H000000FF,&H00101B1D,&H60101B1D,0,0,0,0,100,100,0,0,3,5,0,7,80,80,105,1\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n"""
    srt=[]
    inputs=["-i",str(ROOT/"picture-edit.mp4")]
    filters=["[0:a]aresample=48000[a0]"]
    for i,item in enumerate(lines,1):
        end=item['at']+item['duration']-.10
        ass+=f"Dialogue: 1,{timestamp(item['at'],True)},{timestamp(end,True)},Tag,,0,0,0,,AI 旁白\n"
        # Split at punctuation into comfortably readable subtitle chunks.
        parts=[p+'。' for p in item['text'].rstrip('。').split('。')]
        total=sum(len(p) for p in parts); at=item['at']
        for part in parts:
            dt=(end-item['at'])*len(part)/total
            ass+=f"Dialogue: 2,{timestamp(at,True)},{timestamp(at+dt,True)},Narr,,0,0,0,,{part}\n"
            srt.append(f"{len(srt)+1}\n{timestamp(at)} --> {timestamp(at+dt)}\n【AI旁白】{part}\n")
            at+=dt
        inputs += ["-i",str(ROOT/item['file'])]
        delay=round(item['at']*1000)
        filters.append(f"[{i}:a]loudnorm=I=-18:TP=-2:LRA=7,aresample=48000,aformat=channel_layouts=stereo,adelay={delay}|{delay}[a{i}]")
    filters.append(''.join(f'[a{i}]' for i in range(len(lines)+1))+f"amix=inputs={len(lines)+1}:duration=first:normalize=0,alimiter=limit=0.94:level=false,atrim=0:240[a]")
    (ROOT/"narration.ass").write_text(ass,encoding="utf-8-sig")
    (ROOT/"旁白字幕.srt").write_text('\n'.join(srt),encoding="utf-8-sig")
    meta=";FFMETADATA1\ntitle=AI虚拟主播项目演示｜弹幕·语音·杀戮尖塔2\ncomment=AI旁白只用于开场与衔接；演示段保留原片GPT-SoVITS原声。\n"
    for a,b,title in [(0,10,'项目介绍'),(10,75,'弹幕输入与GPT-SoVITS原声'),(75,116,'语音通话'),(116,232,'杀戮尖塔2画面与语音指令'),(232,240,'结束')]:
        meta+=f"[CHAPTER]\nTIMEBASE=1/1000\nSTART={a*1000}\nEND={b*1000}\ntitle={title}\n"
    (ROOT/"chapters.ffmeta").write_text(meta,encoding="utf-8")
    # Mix audio independently. Video color metadata changes across source/card
    # segments can reinitialize a shared graph and discard future delayed speech.
    run([*inputs,"-filter_complex",';'.join(filters),"-map","[a]","-c:a","pcm_s16le","-ar","48000","-t","240",str(ROOT/'final-mix.wav')],"audio-mix")
    inputs=["-i",str(ROOT/'picture-edit.mp4'),"-i",str(ROOT/'final-mix.wav'),"-i",str(ROOT/'chapters.ffmeta')]
    # Run from ROOT so the subtitles filename needs no Windows-drive escaping.
    filter_text="[0:v]subtitles=narration.ass[v]"
    (ROOT/"final-filter.txt").write_text(filter_text,encoding="utf-8")
    args=[FF,"-y","-hide_banner","-nostdin",*inputs,"-filter_complex_script","final-filter.txt","-map","[v]","-map","1:a:0","-map_metadata","2","-map_chapters","2","-t","240",*ENC,"-movflags","+faststart","AI虚拟主播项目演示_4分钟.mp4"]
    with (ROOT/"final-render.log").open('w',encoding='utf-8') as log:
        p=subprocess.run(args,cwd=ROOT,stdout=log,stderr=subprocess.STDOUT)
    if p.returncode: raise RuntimeError((ROOT/"final-render.log").read_text(encoding='utf-8')[-3000:])
    print("MAIN VIDEO COMPLETE",flush=True)

def sample():
    start,end=61.8,74.4
    # Reuse the same readable, close framing and preserve actual recording audio.
    footage("gptsovits-sample",start,end,EARLY,1,"GPT-SoVITS|实时语音样例","截取原片中的实际语音输出，保留角色字幕与嘴型。此段没有新增旁白。","GPT-SoVITS · 现场原声")
    (ROOT/segments[-1]['file']).replace(ROOT/"GPT-SoVITS实时语音样例_原片实录.mp4")
    run(["-ss",str(start),"-t",str(end-start),"-i",str(SOURCE),"-vn","-c:a","pcm_s16le","-ar","48000",str(ROOT/"GPT-SoVITS实时语音样例_原片原声.wav")],"sample-audio")

if __name__ == '__main__':
    card("intro",10,"PROJECT DEMO","AI 虚拟主播|项目功能实录","弹幕输入、语音通话与游戏互动。\n一段来自本地项目的实际录屏。",preview=ROOT/"detail-235.png")
    card("chapter-chat",4,"01","输入弹幕","从一条文字输入，看到聊天回复与角色字幕。")
    footage("chat-setup",10,36,EARLY,1,"输入弹幕","在同一个工作台里查看聊天区、主播舞台与游戏状态。")
    footage("chat-reply",43,78,EARLY,1,"文字输入|语音回复","发送文字后，查看回复、角色字幕和嘴型。后半段保留现场 GPT-SoVITS 原声。","GPT-SoVITS · 现场原声")
    card("chapter-call",4,"02","语音通话","开启通话，查看实时收音与语音识别状态。")
    footage("call-setup",90,115,EARLY,2,"开启|语音通话","选择麦克风与主播输出设备，再开启语音通话。")
    footage("call-live",121,133,CALL,2,"实时收音","保留通话开启状态、输入电平与聊天区域的现场画面。")
    card("chapter-game",4,"03","杀戮尖塔 2","游戏画面、语音指令与主播反馈同屏展示。")
    source_still("game-window",3,133,GAME,3,"杀戮尖塔 2|游戏画面","截取原片游戏画面作短暂定格，随后回到工作台实录。")
    footage("game-context",158,178,LATE,3,"游戏画面|与语音互动","游戏画面、主播舞台与聊天同屏。现场任务处于暂停状态。","语音通话 · 现场原声")
    footage("game-commands",178,204,LATE,3,"语音指令|与状态反馈","通过聊天记录与角色回复，查看指令识别及当前游戏状态。","GPT-SoVITS · 现场原声")
    footage("game-clarify",204,224,LATE,3,"对话澄清","保留主播对指令的澄清与回应，观察语音交互过程。","GPT-SoVITS · 现场原声")
    footage("game-interrupt",224,250,LATE,3,"暂停|与打断反馈","实际画面保留暂停状态，展示用户打断与主播的后续回复。","语音打断 · 现场原声")
    footage("game-final",250,267,LATE,3,"语音交互|继续回应","保留原片最后一段关于语音打断的回复。","GPT-SoVITS · 现场原声")
    card("outro",8,"AI_VTUBER","让交互发生|在同一个舞台","文字弹幕 → 语音通话 → 游戏中的交流",outro=True)
    final_mix()
    sample()
    print("ALL DELIVERABLES COMPLETE",flush=True)
