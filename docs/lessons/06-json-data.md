# 第 6 课：JSON 和数据格式

本课目标：理解弹幕、回复、记忆为什么都长得像 `{}`。

## 先讲理论

JSON 是一种通用数据格式。前端、后端、配置文件都能读。

例子：

```json
{ "user": "星野", "text": "主播今天声音好可爱", "type": "chat" }
```

## 对应源码

- `data/sample-danmaku.json`：模拟弹幕。
- `data/sample-danmaku.json` 和 `data/training-memories.json`：JSON 样例与可读导出。
- `data/memory.db`：真正的长期记忆数据库，它不是 JSON。
- `src/server.js`：API 返回 JSON。

## 小白版解释

```text
JSON 就像程序之间传纸条时约定好的格式。
```

## 小练习

打开 `data/sample-danmaku.json`，新增一条自己的模拟弹幕，再点击网页里的“灌入样例”。
