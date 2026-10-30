import asyncio
import json
from pathlib import Path
import edge_tts

ROOT = Path(__file__).resolve().parent
LINES = [
    {"id": "intro", "at": 0.6, "text": "这是我制作的人工智能虚拟主播项目。接下来演示弹幕输入、语音通话，以及杀戮尖塔二的游戏互动。"},
    {"id": "chat", "at": 14.5, "text": "先输入文字弹幕。主播的回复，会同步显示在聊天区和角色字幕里。"},
    {"id": "call", "at": 75.3, "text": "接着开启语音通话，查看麦克风收音和识别状态。"},
    {"id": "game", "at": 116.2, "text": "最后，演示杀戮尖塔二的游戏画面与语音指令。"},
    {"id": "outro", "at": 232.2, "text": "以上是本次项目实录。弹幕输入、语音通话和游戏互动，在同一个工作台里完成演示。"},
]

async def main():
    for item in LINES:
        dest = ROOT / ("narration-" + item["id"] + ".mp3")
        if not dest.exists():
            await edge_tts.Communicate(item["text"], "zh-CN-YunxiNeural", rate="+12%", volume="-5%").save(str(dest))
        item["file"] = dest.name
        print(item["id"], dest.stat().st_size, flush=True)
    (ROOT / "narration.json").write_text(json.dumps(LINES, ensure_ascii=False, indent=2), encoding="utf-8")

asyncio.run(main())
