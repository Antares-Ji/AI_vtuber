# 第 5 课：`fetch` 和 API

本课目标：理解前端怎么把弹幕发给后端，以及状态栏为什么能显示后端数据。

## 先讲理论

API 可以理解成：

```text
前端和后端约好的说话窗口。
```

前端不能直接伸手改后端里的变量，它要发请求：

```text
前端：我有一条弹幕，帮我放进队列。
后端：好的，返回 ok。
```

## 对应源码

前端统一用 `api()` 函数请求后端：

```js
async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}
```

## 小白版解释

```text
fetch(path) = 去问后端要数据或提交数据
await = 等后端回答
response.json() = 把后端返回的 JSON 变成 JS 能用的对象
```

## 本项目里的三个主要 API

- `GET /api/state`：获取当前队列、情绪、LLM/TTS/Live2D 状态。
- `POST /api/danmaku`：提交一条弹幕。
- `POST /api/next`：让主播读下一条弹幕。

## 小练习

打开浏览器访问：

```text
http://localhost:3000/api/state
```

你会看到 JSON。页面状态栏里的 LLM、模型、TTS、形象，就是从这里来的。
