# 实体斗地主机｜手牌整理模块硬件方案

当前整机方案见[小型实体斗地主机](compact-doudizhu-machine-design.md)，包含洗发牌、斜槽实体理牌和音频校对。本页保留第一版设计。

手牌整理机是可拆卸的桌面模块，自带料仓、分牌、检测和控制。工作人员把已经发给 AI 的 17 张或 20 张手牌正面朝上叠放。整理机逐张送到固定交接台，顶置相机读牌，现有吸盘臂把牌存入单张牌架。开局后，同一机械臂从牌架取牌并放到公共出牌区。

## 硬件组成

| 部件 | 数量 | 设计与要求 |
| --- | --- | --- |
| 叠牌料仓 | 1 套 | 上装式，可调侧导轨和轻载浮动压板。容纳 20 张牌，限制歪斜，便于松开压板取出卡牌。按实际牌宽、长度、叠高和翘曲调整。 |
| 单张分离机构 | 1 套 | 底部橡胶滚轮、步进电机和驱动、上方弹性阻滞片、可调限缝。滚轮带走底牌，阻滞片约束上层牌。出口用短导轨和轻压出料滚轮送完尾端，确保牌能完整落在独立托台。阻滞片和滚轮可更换，盖板打开后可清理通道。 |
| 进出牌检测 | 2 组 | 对射光电门分别放在分离口附近和交接台入口，记录牌头、牌尾经过时间，结合送料超时检测空送和卡牌。 |
| 单张称重交接台 | 1 套 | 轻质托台、称重传感器和 HX711。托台与送料通道机械分离，牌尾完全离开滚轮且牌面稳定后读数。定位边固定牌的抓取姿态，顶部留出取牌空间。 |
| 翻盖、隔板和电控 | 1 套 | 微控制器、步进驱动、匹配电源、分路保护、开盖开关和急停联动。负责状态与传感反馈、送料超时、故障暂停和手动清障。开盖后整理机和机械臂进入停机状态。 |
| 顶置视觉 | 1 套，共用 | USB 相机、漫射光源、可调支架和标定板。交接台、牌架和公开出牌区均需在各自的识别区域内。通过机位或遮挡保持手牌画面私有。 |
| 单张牌架 | 1 套 | 上方敞口的独立浅槽，槽号固定，定位边抑制歪斜。先做 6 槽样机，全量目标为 20 槽，可拆成两块 10 槽结构。到达性和牌角可见性通过实体样板核对。 |
| 吸盘机械臂及公共出牌盘 | 各 1 套，共用 | 机械臂配软吸盘、气泵或真空发生器，可加真空开关作吸附反馈。摆牌区提供分隔位置供顶置相机核对，对外取牌安排在机械臂停稳之后。 |

分牌机构借鉴自动进纸器的分离滚轮和异常检测思路。扑克牌的厚度、涂层摩擦与翘曲需要用实物验证。称重可以复用 HX711 去皮和读数代码，步进控制可以复用 AccelStepper。 [Epson 分离滚轮说明](https://support2.epson.net/manuals/english/scanner/ds_32000/pdf/npd6159-01.pdf) · [HX711 示例](https://github.com/bogde/HX711/blob/master/examples/HX711_full_example/HX711_full_example.ino) · [AccelStepper](https://docs.arduino.cc/libraries/accelstepper/)

## 整理与出牌流程

1. **送料。** 上位机确认机械臂退出交接台、交接台为空且预留空槽后，给整理机下发单次送料命令。检测到完整通过或超时后停止滚轮。
2. **核对。** 牌完全脱离滚轮并静止后，去皮后的重量落在已标定单张区间，且相机能确认牌面，才返回可取。疑似双张、读不出、卡住或牌台仍有旧牌时暂停，清障后重新确认状态。
3. **入槽。** 吸盘臂从固定交接位取牌，放至下一个空槽。用相机确认牌已入槽、身份匹配、交接台为空后登记 `槽号 → 点数、花色`。随后才允许送下一张。
4. **理牌。** 上位机按点数整理手牌索引，软件中把相同点数归到一起，实体牌保留在原槽。取一对 9 时，系统把两个牌身份对应的槽号交给机械臂。首次确认缺张、重牌或总张数不符时，暂停开局。
5. **出牌。** 规则引擎决定动作后逐张取牌，落到公开出牌盘的分隔位。按需要复用交接台逐张验重，并在公开区复核整组牌面后提交回合和主播播报。

## 样机参数与验收

- 一期先用 6 槽、约 5–6 张牌跑通整理循环和至少一次对子出牌。20 槽样机通过纸板等比例样板检查最远槽、交接台和各公开落点的垂直接近空间。
- 如果选用约 63 × 88 mm 的样例牌，5 列 × 4 行、68 × 93 mm 槽距的估算排布约为 **340 × 372 mm**，外框另计。以实际牌和机械臂工作空间决定槽距与两块牌架的相对位置。
- 分牌机构先用 30 次送料记录首次单张成功数、卡牌数、双张发生数和漏检数。用实际空台、单张和双张样本确定重量阈值，同时测试电机振动、牌偏置、弯牌和插入双张。重量区间重叠就暂停人工确认，并评估隔振或更换检测方法。
- 检查待取期间不重复送料，异常后牌架库存与实际一致，开盖和急停能停止动作。将单张入槽耗时和 17 张、20 张整手整理耗时分开记录。

方案复用一台吸盘机械臂来入槽与出牌，机械臂的实物型号、分牌滚轮压力、称重信噪比、最大行程和实际节拍仍需样机测定。

## 概念图

[中文标注概念图 PNG](hand-card-sorter-concept.png)。图中光电门绘出一个代表位置，实际方案配置两组。料仓中的牌叠用于示意，样机按 20 张设计。

<details>
<summary>内置 ImageGen 生成提示词</summary>

Use case infographic-diagram. Create one wide landscape high-resolution product engineering concept board in simplified Chinese, usable on a defense presentation slide. Title exactly «实体斗地主机｜手牌整理与出牌». Light warm white background, restrained dark navy and teal labels, orange flow arrows, precise tangible isometric technical product rendering mixed with a compact side-view cutaway inset. Top main view: One modular tabletop prototype. Left is a clearly discrete detachable hand-card feeder with square open-top hopper and face-up stack, then an adjacent narrow clear-cover feed channel showing a rubber feed roller and opposing small separation pad, then a flat isolated one-card weighing handoff platform exposed from above, holding exactly one regular poker card. In center/back ONE modest four-axis desktop robot arm with a visible vacuum hose ending in ONE downward soft suction cup. In center/front one flat modular rack with a neat regular 5 columns by 4 rows of isolated full-card slots (some empty), each slot shallow and open from above, and cards never overlapping. Mount one overhead camera with diffuse lights on a stand behind the cell; camera aims down toward dock and rack. On right front a public play tray with two face-up nines laid separately. Clear controlled zone, no second robot, no people, no electronic tags, no product logos, no additional lettering, no invented specs. Clear orange arrows show movement from hopper through separator to dock, then from dock to rack and finally rack to public play tray, with the arm reaching reach over central zones. Add exactly eight large legible dark Chinese callouts with thin leader lines to the right parts, each on single line with one simple function phrase. Text verbatim: «① 叠牌料仓｜放入手牌», «② 分牌滚轮｜逐张送出», «③ 光电门｜检测到位», «④ 称重交接台｜核验单张», «⑤ 顶置相机｜识牌定位», «⑥ 吸盘机械臂｜入槽与出牌», «⑦ 单张牌架｜一槽一牌», «⑧ 公共出牌区｜放牌复核». Position optical gate at channel exit immediately upstream of weighing dock, before the card stops. Bottom left side-view cutaway inset with heading exactly «整理机剖面», depicts stack on the left, bottom rubber roller moving lowest card under opposing friction pad to the right, optical gate at exit, and a separate scale dock to its right. Use arrow to show straight horizontal path with no card inversion; dock isolated mechanically from the feed chute and fully outside the rollers. Bottom right small line of text exactly «概念示意 · 尺寸待实测». Prioritize component identity, arrow logic, callout legibility, simplified Chinese glyph accuracy, and generous negative space over ornamental detail.

</details>
