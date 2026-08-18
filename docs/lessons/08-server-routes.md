# 第 8 课：`server.js` API 路由

本课目标：理解后端怎么分辨不同请求。

## 先讲理论

路由就是：

```text
用户访问不同地址，后端执行不同代码。
```

## 对应源码

`src/server.js` 里主要有：

- `GET /api/state`
- `GET /api/sample-danmaku`
- `POST /api/danmaku`
- `POST /api/next`

## 小白版解释

```text
/api/state = 问现在状态
/api/danmaku = 交一条弹幕
/api/next = 让主播读下一条
```

## 小练习

在浏览器打开 `http://localhost:3000/api/state`，观察返回的 JSON。
