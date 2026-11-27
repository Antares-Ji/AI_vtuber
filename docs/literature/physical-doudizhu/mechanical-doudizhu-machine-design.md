# 实体斗地主机｜三仓洗牌、斜槽理牌与机械臂出牌

当前方案见[三合一实体斗地主机](integrated-doudizhu-machine-design.md)。新版采用双槽洗牌芯、整叠横移切牌，以及机械臂从摊开的手牌里直接取牌。

这版把洗牌、手牌排序和机械臂出牌做成三个可单独调试的模块。开放铝型材底座上保留透明防护盖，观众可以看到洗牌的牌路、滚轮和升降仓。手牌斜槽使用局部遮光罩，两个真人座位的视线被挡住，罩内镜头提供直播画面。

## 模块一｜三仓自动机械洗发牌

自左至右是左分牌仓、中央升降仓、右分牌仓。中央仓有可逆取牌滚轮、步进驱动升降轴、导轨和限位。左右仓各有独立取牌滚轮、阻滞片和过牌传感器。导向滑道和止挡让每张牌落进目标仓。牌面一直朝下，牌路只记录张数和位置状态。

| 机械阶段 | 实际动作 | 执行件 |
| --- | --- | --- |
| A 切分 | 整副牌一次放入中央仓。中央仓升到切分位，先把前段牌逐张拨到左仓，再将剩余牌拨到右仓。 | 中央可逆滚轮、左右导向滑道、计数光电门、中央升降轴 |
| B 随机交错 | 中央仓降到接牌位。控制器根据左右仓余量选择其中一侧。对应滚轮实际送出一张，落回中央。确认上一张完全通过后，才允许任一侧送下一张。 | 左右独立的滚轮和电机、阻滞片、汇流导槽、中央落牌托板 |
| C 整叠回升 | 中央接满 54 张后，把整摞抬回切分位。按设定轮次再次切分和交错；末轮转发牌档。 | 丝杆升降台、导轨、上下限位、出牌切换闸门 |
| D 自动发牌 | 中央仓的单张出口接舵机分流闸，依次给左真人、右真人和 AI。前 51 张每方 17 张，最后 3 张留在独立底牌仓，确定地主后亮牌并转送。 | 取牌轮、三路分流闸、底牌旁路、各出口光电门 |

控制器可用 Gilbert–Shannon–Reeds 交错洗牌模型作基准。每轮切分点从二项分布选取。若左、右仓余量为 L、R，下一张从左仓取出的概率为 L/(L+R)。传感确认过去一张后才扣减余量。具体洗牌轮数根据节拍、卡牌率和带标记测试牌的输出序列验证。理论模型与真机的滚轮摩擦、双张处理和计数可靠性分别验证。 [Bayer 与 Diaconis 的交错洗牌论文](https://www2.stat.duke.edu/~scs/Courses/Stat376/Papers/ConvergeRates/Shuffling/BayerDiaconis1992.pdf)

三个仓统一采用底部送出、顶部接收。以从底到顶为读序，先送出的牌落到接收仓底部，后送出的叠在上方，保留左右分组内部顺序。这样物理牌序可以逐轮与控制器的分流记录核对。监测到疑似双张、过牌超时或仓计数不守恒时停止送料，清障后重新核对各仓，必要时收齐整副重启洗牌。

```text
切分位  左仓 ← 中央整叠 → 右仓
接牌位  左仓滚轮 → 中央合叠 ← 右仓滚轮
回洗位             中央整叠 ↑ 回到切分位
末  轮             中央整叠 → 左 / 右 / AI / 底牌
```

结构依据是公开专利 US7971881B2。图 4 展示整体和爆炸图，图 5 切换中央仓高度实现交错或切分，图 6 展示升降机构。US6651981B2 另有三仓切分、交错和接发牌机构的实例。本方案使用这些已公开结构作为参考，丝杆、护罩和排序支路按样机自行设计。 [US7971881B2 结构图](https://patents.google.com/patent/US7971881B2/en) · [US6651981B2 洗牌与发牌机构](https://patents.google.com/patent/US6651981B2/en)

## 模块二｜横轴分度转鼓与实体理牌

中段采用横轴圆柱转鼓，端面呈放射状的 20 个独立薄槽，一槽一牌。普通牌的长边平行转轴，牌沿长边进出。选用闭环步进电机带同步带减速驱动转鼓，配转鼓轴编码器、零位传感器、工位锁销、两端挡片和单张推指。固定通道布置在转鼓端面约三点钟的位置，目标槽对准时牌面自然水平，可直接交给同高的夹送轮和输送带。转鼓轴与夹送方向平行。

1. **识别并绑定仓位。** 私有 CV 相机拍固定进牌窗，读取点数、花色。零位传感器和输出轴编码器确定正在对准的空仓。推送入仓后，光电确认牌尾完全进入再登记 `牌身份 → 仓号、标定角度`。低置信度、同一实体身份重复、入仓未完成时暂停。离开工位的牌由槽内弹性压片和两端止挡约束。
2. **排序并算转角。** 以 0–19 编号，20 仓的名义步距为 18°。将第 `i` 仓的工位对准角定义为 `i × 18°`，装配后实测并存储每仓校正值。按斗地主点数排序，同点数按固定花色顺序，另可切换花色优先。若当前为 7 号仓、目标为 2 号仓，名义最短转角为 −90°。实际控制用归一到 `[−180°, 180°)` 的目标角减当前角，慢速同向靠准并锁定。编码器负责角度，工位传感器负责确认槽口对齐。
3. **轴向送出。** 锁销到位、出牌通道空闲后，后端固定推指沿轴向推动这一张，出口压轮接住并送上短同步带。通道光电确认牌头与牌尾通过，压轮和推指都退出后才允许转鼓转到下一仓。位置未确认、牌尾卡住或吸盘位被占用时保持原仓状态并暂停。
4. **实体排序与出牌共用输送带。** 整理时，按目标顺序逐仓送牌到输送带，分流门和横移滚轮车把牌顺序送入罩内双排斜槽。开局后，滚轮车按出牌计划反向退牌，经共用输送带送到机械臂的固定水平取牌区。输送带另留转鼓直送取牌区的支路，供调试及单张直送模式使用。正式直播选择斜槽模式，整手牌实体排好并由罩内机位拍摄。

同步带减速适合需要双向选仓的样机，输出轴编码器和锁销分别负责角度反馈与推牌时定位。若后续改齿轮或蜗轮蜗杆，需要实测换向回差、速度及温升。公开资料提供了周向卡仓、旋转定位和出口闩锁的机械实例。 [转盘式卡仓 US20250186871A1](https://patents.google.com/patent/US20250186871A1/en) · [环形仓扑克牌分拣 WO2008006023A2](https://patents.google.com/patent/WO2008006023A2/en)

## 模块三｜关节机械臂用真空吸盘出牌

样机采用可见的桌面四轴关节臂，配一只向下的软吸盘、气泵、软管、控制阀和真空反馈。以 Dobot Magician 的吸盘末端作为硬件参考。出牌时，滚轮车对准指定斜槽，反向退牌到公用传输道，短翻板把牌转回水平并送到固定取牌台。机械臂垂直吸取，抬起后转到公共出牌盘，再释放。连续出多张时沿用同一个取牌位和已标定放牌位，或配合公共盘分度形成牌组。机械臂抬离取牌区后，滚轮可并行准备下一张。整组落牌且公共相机核对后才提交当前回合。 [Dobot Magician 吸盘手册](https://download.dobot.cc/product-manual/dobot-magician/pdf/V1.7.0/en/Dobot-Magician-User-Guide-V1.7.0.pdf)

外部相机和左右麦克风仍用于真人回合。OpenCV 输出点数、花色和张数，SenseVoice 把“对九”“三带一”等语音转成核对条件。两路互相冲突时保持牌局状态并请求确认。罩内直播镜头独立拍有序手牌。 [SenseVoice](https://github.com/QwenAudio/SenseVoice)

## 工装与验证顺序

- **洗牌台架** 先做透明三仓和中央升降台，完成切分、随机交错、整叠回升，随后验证连续整副循环、左右与 AI 发牌、底牌分支及双张检测。一轮需要 54 次切分送料和 54 次交错送料，整副节拍以实测单张通过时间和升降时间估算。滚轮轴、升降丝杆和齿轮加透明防护。开盖开关联动停机。
- **手牌排序台架** 先做 6 仓转鼓和 6 槽牌架。验证零位复归、跨零位转动、反向回差、半装载转动时卡牌不窜位，以及逐仓推出与输送带交接。通过后扩成 20 仓和双排 20 槽，使用同一副标记牌反复测排序与连续出牌。
- **联调** 让机械臂连续吸放同一组 5 张，测单张与整组节拍、双张漏检、卡牌恢复和观众视角。最后测试最长牌组和两个真人座位的手牌遮挡。当前是机械设计与剖视概念，外框尺寸由实际行程、工作半径和清障空间确定。

## 图纸

- [新版转鼓排序与输送图](rotary-card-sorter-schematic.png)展示转鼓端面分度、沿轴向推送以及理牌与出牌的共用输送路径。
- [初版整机结构概念图](mechanical-doudizhu-machine-concept.png)和[初版分步剖面图](mechanical-doudizhu-machine-schematic.png)仍可用于查看三仓洗牌和机械臂布局。中段机械结构以新版转鼓图为准。左、右仓上方的两叠牌是洗牌缓存，两侧下方托盘是对外发牌口。实际固定取牌台一次只接受一张，公共出牌正面朝上。

<details>
<summary>内置 ImageGen 生成提示词</summary>

Wide 16:9 industrial engineering illustration on white, Chinese title «实体斗地主机机械剖视». Precisely illustrate three OPEN aluminum frame stations with exposed components and some transparent guards, left to right. LEFT: mechanical riffle card shuffler with three separate card hoppers, center on clearly visible lead-screw lifting platform, independently motorized black rubber rollers in left and right feeder hoppers. Label ① «三仓洗牌». Under it show three simple small section diagrams: «A 切分» arrows center to both sides; «B 随机交错» arrows from left and right back into lowered center; «C 整叠回升» upward arrow on center lift. Include two outgoing side trays marked ② «左右发牌». CENTER: private hand sorting module, separate compact vertical elevator full of thin single-card slots, camera on single-card feed tunnel, a long timing belt and movable carriage with pinch rollers feeding cards into two slanted, shingled rows with corners visible. Callouts ③ «识牌与暂存» and ④ «滚轮车入斜槽». RIGHT: one actual desktop jointed robotic arm, circular rotating base, two elbow links, wrist, air tube, visible rubber vacuum suction cup holding one horizontal card. It picks from a small fixed card pad marked ⑤ «固定取牌台» and lays cards on adjacent public tray; callout ⑥ «吸盘机械臂». Proportionally realistic engineering illustration, exposed gears rollers and leadscrews, use limited orange for shuffling and blue for sorting and arm. Legible Chinese typography, clear arrows, no opaque exterior covering the mechanical structures, no second arm, no weighing. Avoid decorative text.

</details>
