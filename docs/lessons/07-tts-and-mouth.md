# 第 7 课：TTS 和嘴型

本课目标：理解文字怎么变成声音，嘴巴怎么跟着动。

## 先讲理论

TTS 是 Text To Speech，意思是文字转语音。

当前项目先用浏览器自带的 `SpeechSynthesis`，所以不用安装复杂语音模型。

## 对应源码

- `public/stream.js`：`speak(text)` 播放语音并控制嘴巴。
- `src/tts/provider.js`：后端 TTS provider 状态入口。

## 小白版解释

```text
AI 生成一段文字
浏览器把文字读出来
JS 在播放时反复切换嘴巴 class
CSS 让嘴巴变大变小
```

## 小练习

在 `public/stream.js` 里找到 `utterance.pitch`，以后可以试着微调音高。
