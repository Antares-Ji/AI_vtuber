# 第 0 课：项目整体结构

本课目标：知道这个项目不是一个单文件程序，而是前端、后端、数据和主播大脑一起合作。

## 核心流程

```text
你输入一条弹幕
    ↓
网页把弹幕交给后端
    ↓
后端把弹幕交给“主播大脑”
    ↓
主播大脑根据人格、情绪、记忆生成回复
    ↓
网页显示回复并播放语音
```

## 文件分工

- `package.json`：项目启动配置。
- `src/server.js`：后端服务器。
- `src/brain.js`：主播大脑总入口。
- `public/index.html`：网页结构。
- `public/stream.css`：直播网页样式。
- `public/stream.js`：直播网页行为。
- `data/memory.db`：当前 SQLite 分层记忆数据库。
- `data/training-memories.json`：经确认训练记忆的可读导出，不是数据库本体。

一句话记忆：

```text
页面负责演出，服务器负责传话，大脑负责思考，SQLite 负责可靠保存，JSON 负责配置和可读导出。
```
