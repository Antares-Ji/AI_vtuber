# 第 12 课：记忆系统

本课目标：理解短期记忆、用户记忆、角色记忆的区别。

## 先讲理论

AI 主播的记忆不能全靠 LLM 临时猜，要由代码保存。

## 当前分层

- session memory：整场原始对话，普通聊天默认只到这里。
- candidate memory：会话结束后由 AI 提炼、等待你确认的 0 到 5 条候选。
- user memory：经确认的观众事实、偏好、共同经历和证据。
- relationship memory：熟悉度、信任、舒适度与边界压力。
- character memory：角色自己的反思；角色世界书仍放在独立角色包中。

## 对应源码

- `src/brain/memory.js`
- `data/memory.db`
- `data/training-memories.json`
- `public/studio.html`

## 小白版解释

```text
session_messages = 本场临时对话
memory_candidates = 等待人工确认的摘要
memories = 已确认长期记忆
user_relationships = 会随互动更新和衰减的关系参数
```

普通弹幕不会自动成为长期事实。只有你明确说“请记住”，或者在导演工作台批准会话候选后，内容才进入长期层。

## 小练习

1. 发“我最近在练 DT”，确认它只出现在本场会话。
2. 打开导演工作台，结束并提炼本场，再批准候选。
3. 再询问“你记得我最近练什么吗”，观察召回证据。
