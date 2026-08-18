# 第 4 课：`stream.js` 让按钮动起来

本课目标：理解按钮为什么能响应点击。

## JavaScript 做三件事

```text
1. 找到页面元素
2. 监听用户事件
3. 修改页面或请求后端
```

## 对应代码

```js
const nextBtn = document.querySelector("#nextBtn");
nextBtn.addEventListener("click", readNext);
```

人话：

```text
找到“读下一条”按钮。
当用户点击它时，执行 readNext。
```

一句话记忆：

```text
`stream.js` 是直播网页的遥控器。
```
