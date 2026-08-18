# 第 13 课：LLM API 和 DeepSeek

本课目标：理解项目怎么接外部大模型。

## 先讲理论

LLM API 就是：

```text
我们把人设、情绪、记忆、弹幕发给模型
模型返回一句更自然的回复
```

## 对应源码

- `src/brain/llm.js`
- `.env.example`

## DeepSeek 配置

```powershell
$env:OPENAI_BASE_URL="https://api.deepseek.com"
$env:OPENAI_MODEL="deepseek-chat"
$env:OPENAI_API_KEY="你的 key"
npm start
```

## 小白版解释

```text
OPENAI_BASE_URL = 服务地址
OPENAI_MODEL = 用哪个模型
OPENAI_API_KEY = 你的通行证
```

## 小练习

不填 key 启动项目，看页面 LLM 显示 fallback。以后填 key 后再观察变化。
