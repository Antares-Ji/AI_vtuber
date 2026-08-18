# 第 1 课：`npm start` 启动了什么

本课目标：理解为什么运行 `npm start` 后，浏览器能打开 `http://localhost:3000`。

## 关键链路

```text
npm start
    ↓
读取 package.json
    ↓
执行 node src/server.js
    ↓
服务器监听 localhost:3000
    ↓
浏览器访问网页
```

## 人话解释

`server.js` 是一个一直开着的程序。浏览器问它要网页，它就把 `public/index.html`、`stream.css`、`stream.js` 发给浏览器。

## 你要记住

```text
localhost = 你自己的电脑
3000 = 这个项目使用的门牌号
```
