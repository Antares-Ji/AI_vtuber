# 术语表

## API

程序之间说话的接口。前端问后端“下一条弹幕怎么回”，用的就是 API。

## JSON

一种数据格式，长得像 JavaScript 对象，例如：

```json
{ "user": "星野", "text": "你好" }
```

## fetch

浏览器里用来请求后端 API 的函数。

## 前端

用户看得见、点得到的部分。当前项目主要是 `public/`。

## 后端

背后处理逻辑和数据的部分。当前项目主要是 `src/`。

## LLM

大语言模型，比如 DeepSeek、GPT、Claude。它负责生成更自然的回复。

## OpenAI-compatible

不是只能用 OpenAI，而是使用类似 OpenAI `/chat/completions` 的接口格式。DeepSeek 也支持这种用法。

## TTS

Text To Speech，文字转语音。当前项目先用浏览器自带 TTS。

## Live2D

2D 虚拟形象渲染技术。真实模型通常会有 `model3.json`。

## memory

记忆。当前项目分为短期对话、用户事实、角色设定。

## emotion

情绪状态。当前项目有 `neutral / happy / shy / annoyed / focused / excited`。

## fallback

备用方案。比如没有 API key 时，不调用 DeepSeek，而是用本地规则回复。

## WebSocket

一种长连接通信方式。以后接 B 站弹幕时会用到。
