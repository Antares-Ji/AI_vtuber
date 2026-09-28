# Qwen3-VL-4B + YOLO 本地实验（2026-09-11）

> 最新状态：用户已确认管理员控制器成功点击；23:43完成十轮有监督导航，详见 [后续报告](vlm-ten-rounds-20260911.md)。下文早期阻塞与0/10统计为历史记录，已被后续进展更新。

## 实际完成

- RTX 5080 16GB；复用已有 CUDA PyTorch 2.11.0+cu128 与 Transformers 5.16.1，新建 runtime/vlm-env 安装 Ultralytics 8.4.147、PEFT 0.20.0。新环境通过 .pth 依赖 runtime/local-llm/.venv，迁移时需要重新安装相应依赖。
- 下载官方 Qwen/Qwen3-VL-4B-Instruct 完整权重（8,875,631,616 字节的张量），BF16、未量化。版本 ebb281ec70b05090aa6165b016eac8ec08e71b17。
- 下载官方 Ultralytics/YOLO11 的 yolo11n.pt，版本 8b8ac7d1fae7468f85dbf89670dd66f41f485aab。
- 联合离线推理：YOLO 候选作为上下文交给 VLM 核查。COCO 人物检测不等于游戏按钮检测，当前没有自动点击接口或生产服务集成。
- 在 public/annotations/home-reference-20260907.jpg 上，首次 VLM 回答耗时 9.65 秒；限制为简短结构化场景描述后为 2.32 秒。模型峰值分配显存约 8.55 GiB；不含其他进程占用。单次测量不能视为稳定延迟或帧率。
- YOLO 的一次训练验证日志为 10.7ms 推理，另有预处理和后处理。联合实验的首次 YOLO 调用含初始化约 1.8 秒，二者不可直接比较。
- 用 home-reviewed.json 中 25 个非 uncertain 候选框，对 YOLO 做了 3 epochs 的 UI 区域试训，生成 best.pt。
- 用同一来源截图的按钮裁剪，对完整 BF16 VLM 底座的文本注意力 LoRA 适配器做了 3 个优化步骤。仅训练适配器，不是全参数微调；loss 为 15.6532、14.1936、15.1221，对应不同裁剪，不能解释为准确率提升。

## 质量与未完成项

- 只有一张来源图；训练和验证使用相同来源，没有独立测试集。Ultralytics 的最终验证会在 train 图上运行，因此其 mAP（约 0.0473）仅作训练诊断，不能作为泛化评测。
- VLM 能给出 home 场景，但仍把角色名称或错误文字列为按钮。未达到可靠点击质量。训练适配器尚未做独立前后对比，也未部署。
- 十轮实机闭环：**0/10**。没有将离线推理次数或训练步数计为实机轮数。
- 最初游戏登录失效，后来观察到游戏已经进入主页。随后截图出现其他窗口遮挡，自动审批拒绝继续读取或保存可能含 ChatGPT 私密内容的画面。未绕过该阻止。
- 继续实机验证需要先让游戏无遮挡显示，并取得对游戏截图读取的明确许可。随后每轮需要独立记录动作前截图、模型输出、点击、动作后截图、成功判据、耗时与修复记录。

## 文件与复现

下载：`runtime/vlm-env/Scripts/python.exe scripts/setup-vlm-models.py`

完整底座推理：`runtime/vlm-env/Scripts/python.exe scripts/vlm-experiment.py infer`

YOLO 试训：`runtime/vlm-env/Scripts/python.exe scripts/vlm-experiment.py train-yolo --steps 3`

VLM LoRA 试训：`runtime/vlm-env/Scripts/python.exe scripts/vlm-experiment.py train-vlm --steps 3`

实验数据位于 runtime/vlm/：download-manifest.json 在各模型目录内；inference-initial.json、inference.json、yolo-training.json、vlm-training.json 和 environment-freeze.txt 保存结果与依赖。

YOLO 权重：runtime/vlm/training/yolo-pilot/weights/best.pt。

VLM 适配器：runtime/vlm/training/vlm-lora-pilot/。

所有新增 Python 脚本通过语法检查；两种训练及两次完整底座推理已实际运行成功。未修改已有游戏控制代码，未启动常驻自动点击任务。

官方来源：[Qwen 模型](https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct)、[YOLO11](https://docs.ultralytics.com/models/yolo11)。

## 用户明确许可后的实机续验（20:37—20:42）

截图许可已获得，游戏成功置于前台，画面无遮挡。新增 scripts/vlm-live-worker.py 常驻加载 BF16 完整底座及 YOLO11n，在 127.0.0.1:17642 提供本地实验截图分析；不直接执行输入。

第 1 轮目标为打开设置：VLM 正确返回 home，并定位齿轮归一化中心 (35,70)，转换为窗口像素 (56,74)，与目视位置一致。YOLO 为通用人物检测上下文，不承担设置按钮定位。

实际鼠标点击工具未报错，但设置没有打开；刷新稳定画面、确认窗口焦点后，以窗口相对坐标 (54,75) 重试一次仍无效，Escape 对照也没有可见反应。VLM 对点击后截图再次返回 home，明确判定设置页面未打开。根因尚未确认，不能直接归咎于权限或游戏反作弊。

耗时：动作前 YOLO 51.59ms、VLM 2304.45ms；动作后 YOLO 18.16ms、VLM 1788.78ms。均为本轮测量，非帧率保证。

新增 src/vision/vlm-action-check.js 校验视觉状态迁移与坐标有效性，并通过 tests/vision/test_vlm_action_check.js 的无变化、缺失证据、错误页面、非有限坐标及边界坐标测试。脚本 scripts/record-vlm-live-round.js 已将实际失败写入 runtime/vlm/live-20260911/rounds.json，未把工具调用成功当作操作成功。

**当前统计：尝试 1/10 轮，成功 0 轮，其余 9 轮未执行。** 等待一次用户手动点击齿轮的对照结果，以继续排查输入通道；不继续重复无效注入。模型和训练文件保持可用。
