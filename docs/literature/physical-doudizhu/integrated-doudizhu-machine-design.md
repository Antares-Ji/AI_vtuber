# 三合一实体斗地主机｜平移切牌、转鼓铺牌、机械臂直取

整机采用一台连体机身、一块底板和一条短牌路。后部内嵌双进牌槽洗牌芯，顶部加整叠横移切牌。AI 发牌支路接水平轴分度转鼓，转鼓的出口紧贴前部手牌盘。侧边关节臂直接从同一个遮光手牌盘吸牌，再转到公共落牌区。

## 采购参考与最小改造

| 参考 | 公布的能力 | 样机复用方式 |
| --- | --- | --- |
| [Noris 电动洗牌器 606154621](https://www.noris-spiele.de/noris_en/categories/accessories/card-shuffler/card-mixingmaschine-electric-606154621-en.html) | 左右两堆入料，电机向内拉牌，混合后落入前方接牌盘。见[厂商工作流程说明](https://www.noris-spiele.de/noris_en/categories/accessories/card-shuffler/)。 | 用于验证标准扑克牌的双向汇流。采购样机前核对所在地的供货和所用牌规格。 |
| [Brybelly 双副电动洗牌机在售页面](https://www.walmart.com/ip/190631670) | [厂商说明书](https://m.media-amazon.com/images/I/91DT7ZYXSlL.pdf)明确写有左右放牌、中央插接牌盘和两侧滚轮检查。 | 另一款可测的洗牌芯。原机由人把牌分到两侧，自动切分、自动发牌和所需的电控接入由本机实现。 |

原型可从上述市售结构获得滚轮、双槽和中间汇流参考。原装的两侧滚轮是否分别可驱动、接牌盘能否接入发牌轮，需要拿到实物检查。仅需低成本试验时，先保留现成滚轮的驱动；需要记录和控制交错顺序时，用两侧独立电机驱动同一类小滚轮。单次汇牌只是一次交错，洗牌质量由已知原始牌序的输出测试评估。

## 后部洗发牌｜一次跨槽搬半摞

1. **切牌。** 将整副 54 张背面朝上放进左槽。槽侧预留切入口。小滑台带薄的圆角弹性分牌舌、托板和轻压片，先从大约中层找缝，轻抬并托稳上半摞，再水平越过中央接牌位送入右槽；下半摞留在原槽。两边用固定限位把牌叠推齐。薄舌进入受阻时停机回撤，避免把牌边硬推变形。
2. **洗牌。** 切牌滑台回位后，两侧橡胶滚轮从各自槽底逐张向内送牌，牌背朝上汇入下方中央盘。定序控制时，确认上一张离开汇流口后，再允许下一张进入。样机以约半叠切分为目标，分牌舌的高度、形状和压片载荷由实际牌堆试验调整。
3. **发牌。** 中央接牌盘下方布置单张发牌轮；短导轨和分流门接左出口、右出口、机内 AI 通道，并用末三张的分支暂留底牌。前三方各 17 张。地主确认后，三张底牌公开并送往相应一方。真人牌全程保持背面朝上，AI 支路才启用窄视野读牌。

## 中部转鼓与前部私有手牌盘

AI 支路翻出牌面，CV 识别点数和花色，入口光电确认牌进入当前转鼓仓，记录 `牌身份 → 仓号 → 标定角`。20 仓名义间距 18°。输出轴编码器和锁销确认对位，固定推指把目标牌交给短同步带。整理器按点数顺序转到对应仓并逐张推出，同点数按花色排；也可切换为花色优先。输送带末端小型横移滚轮头将牌放入双排平行浅斜槽。AI 为农民用 17 槽，为地主最多用 20 槽。

双排浅斜槽约 20–30°，同排相邻牌平行错叠。靠护边的一侧露出每张牌完整角标，另一处留给小吸盘。以 63 mm 宽牌和约 25–28 mm 露边节距作布局假设，单排 10 槽约宽 288–315 mm，边框另计。每槽支撑台阶形成微小高度差，挡片固定邻牌，取牌侧的导向留出抬升空间。罩内斜上方相机对实际牌面和固定槽号复核，得到机械臂使用的槽位坐标。两侧低视线用遮光罩挡住，场内不回显直播手牌画面。 [周向卡仓参考](https://patents.google.com/patent/US20250186871A1/en)

## 机械臂从摊开的手牌直接取牌

关节臂装在同一底板的右侧，短臂跨过前部手牌盘。相机在排好牌后确认 `槽号 → 牌身份`，用槽位标定表提供吸附位置。全盘采用同一倾角，吸盘用固定倾角转接座和柔性波纹吸头贴合牌面；如果出牌盘要求水平释放，可在末端加小型俯仰转接或采用相同倾角的薄落牌盘。机械臂沿牌面法向先抬出，清除邻牌后移到公共盘。真空反馈和相机确认每次只带走目标牌。对子、顺子逐张吸放，整组到齐后提交回合。

公共相机和麦克风仍只负责核对真人回合。手牌相机同时服务槽位复核和直播。概念图使用局部开罩视角展示内部，实际运行保留上方安全空间和遮挡玩家视线的两侧挡板。机械臂运动区与真人放牌区隔开，启用急停和开盖联锁。

## 一台机身的空间分配与验收

- 双槽洗牌芯嵌在底板后部一侧。分度转鼓并排嵌在后部，短输送带把它和前部扇形手牌盘连起来。机械臂固定在手牌盘右侧，公共落牌盘与机身前沿共用结构。
- 先以约 540 × 380 mm 底板作比例排布，估算不含外伸接牌托和整臂工作范围。按真实吸盘、洗牌芯和整排展开尺寸复测。总装图未给出生产尺寸。
- 优先做三个短试验。横移半摞时检查第一张与最后一张是否留错仓；用 6 仓、6 槽验证从乱序变为实体有序；连续从相邻斜槽吸 5 张，记录漏吸、带邻牌和整组耗时。三项通过后再扩到 54 张洗发牌与 20 张手牌。

## 整机概念图

[三合一整机概念图｜转鼓修正版](integrated-doudizhu-machine-concept-v2.png)由内置 ImageGen 修订。整机图采用下方局部剖视的结构，单张仓沿同一个端面周向排列，牌沿转轴方向从固定工位推出，接到短输送带。正式运行时保留手牌区的遮光挡板。图中公开牌用来示意落点。

[同一台机身的转鼓局部剖视](integrated-doudizhu-machine-rotor-detail.png)显示周向单张仓、固定出牌口、输送带和吸盘直取。图中的仓位刻字和牌面方向用于展示，正式排布按 20 个唯一仓号、18° 步距、牌沿转轴方向推出、入斜槽时牌面朝上设计。

<details>
<summary>整机概念图生成提示词</summary>

修订采用原整机图为编辑目标、局部剖视为正确转鼓参考。

EDIT IMAGE 1 ONLY. Image 1 is the full-machine edit target; Image 2 is solely the correct rotary drum reference. Produce an updated full-machine concept board with exactly the overall layout, framing, title and all six Chinese labels from Image 1. Correct ONLY the rear-center rotary storage drum marked ③, plus the tiny belt inlet connection immediately beside it. Completely remove the old row of coaxial parallel circular disks from Image 1. Replace it with the SAME one cylindrical RADIAL card carousel shown in Image 2. IMPORTANT VISUAL MATCH: present its near CIRCULAR END FACE visibly to the camera in 3/4 perspective, the end face is a single silver wheel with a hub and twenty spoke-like radial thin slots around the ONE circumference. Behind it a second circular end plate, and long thin longitudinal compartment dividers run continuously between the two ends. Each card is a flat rectangular radial plane, long edge parallel to the shaft, one card per slot. At the fixed 3 o'clock station a single card lies horizontal and slides AXIALLY out of that open end through one pinch roller pair onto the existing short belt ④ down into the hand tray. Put a tiny fixed CV camera near the entrance, as in reference. Mechanically connect the drum end-face outlet to the same belt rather than implying cards drop from the curved side. Show one hub and short readable spoke divisions, omit tiny warehouse number glyphs if needed to avoid errors. Keep the drum on the original footprint between the shuffler and mechanical arm and keep the rest of Image 1 unchanged: left twin-hopper shuffler and orange arrows, one continuous base, transparent guard, front fan-style hand holder, arm with blue hose lifting one card directly from the exposed hand, public tray, photographer angle, title and all Chinese labels. Preserve single-machine architecture. Move only callout ③ leader endpoint if needed to touch the new circular hub. High quality mechanically coherent industrial cutaway. Do not produce the close-up second image or a split comparison. Output just the corrected complete overall machine.

Create a real industrial product design concept rendering, widescreen 16:9, of ONE unified AI Dou Dizhu tabletop appliance, one continuous matte aluminum base and one low case spanning everything. Show a large three-quarter axonometric cutaway of the single connected machine taking most of the image. NOT three separate machines. Bright neutral studio, accurate beautiful hardware, modest compact dimensions, open transparent guards on mechanical zones with local removable dark privacy side panels around the cards. Use actual mechanisms with the card flow visible, color-coded orange then teal then blue. Rear left, a small commercially inspired dual-hopper playing card shuffler embedded flush in the base, two adjacent shallow card stacks, two small rubber feeder rollers feeding from both sides towards a SINGLE central lower catch tray. Across the top of the pair of wells, a tiny single horizontal slide and blue thin separator tongue lifts and translates the upper half of one stack sideways into the neighboring empty well. Indicate this bulk movement with one orange arrow. Rear center of SAME base, a horizontally mounted rotating CYLINDRICAL MAGAZINE with many narrow radial individual card slots like a revolver cylinder, one axis, shown with transparent end cutaway, one encoder/motor and one short axial card pusher near 3 o'clock; a tiny CV camera over its incoming card. The drum is tucked directly behind the front hand tray; one short synchronous belt connects its single outlet to the front fan tray, show this connection physically with a visible card on the belt. Front/center, one private accessible fan-shaped slanted hand tray with TWO close, lightly shingled rows, real cards FACE UP and individually accessible, every card has an adequately wide margin exposed so a small cup can land. Show about 17 ordered cards, index corners visible from a small inside camera above, matte privacy sides, detached front training rendering angle makes the private face view clear. Crucial: On the right front edge of the SAME BASE show ONE real small articulated shoulder-and-elbow joint desktop robot with flexible blue vacuum hose ending in one little down-facing rubber suction cup. The cup is IN the private hand tray touching and lifting ONE face-up card directly from between the other face-up cards, and a blue arc shows the move from the hand tray to a shallow attached public play area on the front-right edge, containing 3 individually visible face-up cards. There is no fixed robot pickup station, no stack feeding the arm, no gantry or second robot. Two very short face-down dealing chutes exit opposite left and right sides of the shared base. Headline exactly «三合一实体斗地主机». Exactly six legible Chinese callouts with leader lines «① 平移切牌», «② 双槽向中间洗牌», «③ CV 分度转鼓», «④ 短履带排牌», «⑤ 遮光斜槽｜摊开手牌», «⑥ 机械臂直接吸牌». Small side cutaway inset only if useful, but main view must clearly show all six and keep one coherent one-piece design. No extra blocks, detached stations, tall elevator, weight scale, display screen, logos, abstract flowchart, irrelevant writing, dimension claims or hands. Preserve straightforward realistic relative scale and a source-to-destination physical route.

</details>

<details>
<summary>转鼓局部概念图生成提示词</summary>

Create a standalone product-design close-up cutaway concept rendering of the middle region of the reference SAME one-piece aluminum automated Dou Dizhu machine. This is a zoom of the integrated product, not another standalone machine. A wide studio 3/4 view and no adjacent big modules. Main important correction: the storage magazine is like a large revolver drum mounted on a horizontal axle, with TWO circular end plates and TWENTY wedge-shaped thin RADIAL card bays around the ONE circumference, visible from the end face with radial divisions exactly like spokes, NOT multiple parallel disks or a spool with separate rings along the axle. Each card's long dimension extends along the horizontal axle, one card per slot. At approximately 3 o'clock one card lies horizontally and slides out through the front end of the selected radial bay, roughly parallel to the shaft, onto a short narrow belt. Show a small pusher, end axle encoder, rubber pinch wheels, a fixed CV camera at the entrance, and the short belt physically leading into the two shallow face-up rows of ordered cards, exposed index corners, dark privacy sides. Include the existing jointed robot wrist entering from the right, a single flexible suction tube and suction cup hovering over one accessible face-up card in the slanted rack. Chinese headline exactly «转鼓识牌与实体铺牌｜整机局部剖视». Make five concise Chinese callouts with direct leaders «① CV 识别进牌», «② 周向单张仓», «③ 固定位置推出», «④ 短带送入斜槽», «⑤ 吸盘直取手牌». Neutral background, brushed aluminum, teal card flow arrows on only the transport path, precise plausible engineering product concept. No detached standalone products, no opacity blocking the end-face radial slots, no axis confusion, no slogans.

</details>
