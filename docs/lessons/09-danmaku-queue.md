# 第 9 课：弹幕队列

本课目标：理解为什么弹幕要排队、排序、去重。

## 先讲理论

直播弹幕会很多，主播不能每条都立刻读。

所以需要：

- 排队：先存起来。
- 排序：礼物、SC、问题优先。
- 去重：短时间重复内容不塞满队列。

## 对应源码

- `src/server.js`：`queue` 和 `seenDanmaku`。
- `src/brain.js`：`scoreDanmaku()` 和 `pickDanmaku()`。

## 小白版解释

```text
queue 像排队窗口。
scoreDanmaku 像给每条弹幕打分。
pickDanmaku 选分数最高的一条。
```

## 小练习

连续发送两次完全一样的弹幕，观察第二条不会立刻重复进入队列。
