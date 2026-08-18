# 第 10 课：主播大脑为什么要拆模块

本课目标：理解为什么 `brain.js` 不应该永远写成一个大文件。

## 先讲理论

小项目可以一个文件写完。项目变大后，一个文件会越来越难读。

所以我们把“不同职责”拆开：

```text
persona = 人设
emotion = 情绪
memory = 记忆
llm = 外部大模型
reply = 组织回复
```

## 现在的源码结构

- `src/brain.js`：主播大脑总入口。
- `src/brain/persona.js`：人设和边界。
- `src/brain/emotion.js`：情绪分数和衰减。
- `src/brain/memory.js`：短期记忆、用户记忆、角色记忆。
- `src/brain/llm.js`：DeepSeek/OpenAI-compatible 调用。
- `src/brain/reply.js`：上下文和本地回复。

## 小白版解释

以前：

```text
一个大脑文件里什么都管。
```

现在：

```text
brain.js 像班长，只负责协调。
每个小模块像组员，只负责一件事。
```

## 小练习

打开 `src/brain.js`，看它顶部的 `require(...)`。

你会看到它从不同文件导入功能，这就是模块化。
