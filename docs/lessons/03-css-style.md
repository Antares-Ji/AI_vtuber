# 第 3 课：`stream.css` 页面样式

本课目标：理解 CSS 怎么把普通 HTML 变成现在这个界面。

## CSS 基本格式

```css
选择器 {
  属性: 值;
}
```

例子：

```css
.app {
  display: grid;
}
```

## 本项目里的作用

- `.app`：控制左右布局。
- `.stage`：控制主播舞台。
- `.avatar` / `.head` / `.eye` / `.mouth`：画出 CSS 假角色。
- `.mouth.talking`：说话时嘴巴变大。
- `.avatar.shy`：害羞时加粉色光效。

一句话记忆：

```text
HTML 摆零件，CSS 决定零件长什么样、放哪里、怎么动。
```
