# 希儿声库接入与切换：给接手 Codex 的部署说明

更新：2026-10-19。目标：对方安装 GPT-SoVITS 后，取得配套声库，配置一次，即可在主播页面选择该声音；不用重新训练，也不用把声音模型塞进聊天 LLM。

## 1. 已核对的版本与现有功能

- 本机现有希儿声库是 **v4** 配置，GPT 权重为 `希儿-e10.ckpt`，SoVITS 权重为 `seele_5s_test_e10_s1000_l32.pth`。不要因为口头称呼“第三版”而直接将它改为 v3；需要服务支持权重实际版本。
- 配套参考音频文件名为 `seele-reference-16k.wav`，参考文本必须由提供方给出逐字原文，不可猜测或填写新台词。
- 舞台 `public/index.html` 与调试舞台 `public/debug.html` 已有“系统机器声音 / 希儿 GPT-SoVITS”选择器，选择保存在浏览器本地；切换会取消原有语音输出。
- Minecraft 面板也有系统语音/GPT-SoVITS 选项。服务请求走 `/api/tts` → GPT-SoVITS `/tts`。
- 选择 GPT-SoVITS 后，失败会报错，不自动伪装成希儿而播放系统声音；仍可手动切回系统声音。

## 2. GitHub 提供什么

仓库提供配置模板、配置/启动工具、接入代码和本说明。**不提供训练权重、参考录音、私有配置或“已经取得商业使用权”的保证。**这是技术接入交接，不是素材授权证明。

实际声库由拥有相应分享权限的一方单独交付。私人声库放在 `runtime/` 或项目外目录；不要提交到 Git。原声库文件名与“希儿”标签仅用于辨认现有实验资产，不证明角色权利人或声音提供者授权。正式公开直播前需要另行确认素材允许用途；接入新获授权的原创声音时沿用同一套配置流程即可。

提供方应交付：

| 文件/信息 | 必需原因 |
|---|---|
| GPT `.ckpt` 与 SoVITS `.pth` 的配套权重 | 两部分缺一不可；不要随机选目录中第一个文件 |
| 权重版本、来源、SHA-256 | 确保下载完整与版本匹配，哈希不代表声音质量 |
| 干净参考音频及准确转写 | 控制目标音色/语调；不能只交权重 |
| 可选：不同情绪的参考音频和各自转写 | 开心、害羞、专注等表达；无素材就不编造情绪声库 |
| 使用与分享范围 | 区分内部测试、商业直播、二次分享权重等用途 |

完整 GPT-SoVITS 服务还需要该版本的预训练依赖、文本/音频编码器和必要声码器。下载源码或本工具的路径检查通过，不等于全部模型依赖齐全。按所使用发行包自己的安装说明补齐；不要混搭 v3/v4/v2Pro 权重。

## 3. 对方安装后的操作

以下命令在 **AI_vtuber 完整工程根目录**执行。先准备 Node 依赖、GPT-SoVITS 的 Python 环境、FFmpeg 和上述文件。

```powershell
New-Item -ItemType Directory -Force runtime/voices | Out-Null
Copy-Item config/voices/seele.example.json runtime/voices/seele.json
```

编辑 `runtime/voices/seele.json`：

- `serviceRoot`：对方 GPT-SoVITS 的安装根目录，含 `api_v2.py`。
- `python`：相对 `serviceRoot` 的 Python 路径，整合包一般为 `runtime/python.exe`，自建环境可填 `.venv/Scripts/python.exe`。
- `gptWeights` / `sovitsWeights`：实际配套权重路径，相对服务根目录或绝对路径；保留真实版本。
- `referenceAudio`：参考音频绝对路径，或者相对 **JSON 配置文件所在目录**的路径。
- `referenceText`：参考音频准确转写，必须替换示例占位符。
- `device`：`cuda`、`cuda:0` 或 `cpu`；CPU 配置会关闭半精度，速度需实测。
- `speed`：初始 1.0；只调整播放生成速度，不保证复制全部语调。
- `port`：默认 9880；自定义端口需使用下列单服务启动流程，旧全服务启动脚本仍检查 9880。

先检查，再应用：

```powershell
node scripts/configure-voice.js runtime/voices/seele.json
node scripts/configure-voice.js runtime/voices/seele.json --apply
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-gpt-sovits.ps1 -CheckOnly
```

第一条只检查路径，不改文件。第二条精确生成 `runtime/gpt-sovits/tts_infer.yaml` 并更新 `.env.local` 中声音相关字段，保留其他模型密钥和配置；旧文件备份在 `runtime/gpt-sovits/backups/`。换声库时清空上一声库的情绪参考，防止新旧音色混用。备份包含私有配置，也不能上传。

这一步**不会启动、停止或重启服务**。如果旧语音服务仍占用端口，先停止自己管理的旧服务；不要随意结束不明进程。然后启动：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-gpt-sovits.ps1
```

另开终端重新启动 Node 主服务，使其读入新配置：

```powershell
npm run start:server
```

已有主服务时先通过原终端停止，或使用项目的 `npm run restart:server`。不要重复启动第二个占用 3000 端口的服务。

## 4. 网页里怎么切换

1. 打开 `http://127.0.0.1:3000/`，开启主播声音。
2. 在语音来源下拉框选“希儿 GPT-SoVITS”。
3. 发送一句短中文，确认字幕、语音与嘴型；**必须试听，收到 HTTP 响应不代表扬声器实际出声。**
4. 切回“系统机器声音”，确认旧语音停止、新回复使用浏览器声音。
5. 再切回 GPT-SoVITS，确认仍可工作；这两个前端选项之间切换不需要重启服务。

**两类切换不要混淆：**网页可以直接切换系统声音和当前 GPT-SoVITS 声库；从“希儿权重”换成另一套训练权重，目前要用另一份 JSON 应用配置并重启两个服务，尚不是多声库网页热切换。UI 中现有“希儿”标签也需随新声库调整，不能把其他音色继续标成希儿。

## 5. 希儿的语调与情绪怎么接

权重、参考录音和参考文本共同影响合成效果。情绪文本提示本身不是可靠的“换语气按钮”，现有代码通过不同参考录音、语速及采样参数调节表达；不保证完全复刻某个角色的表演。

需要情绪素材时，在私有 JSON 里添加，例如：

```json
"emotions": {
  "happy": { "audio": "D:/private-voice-bank/happy.wav", "text": "对应这段开心录音的逐字原文" },
  "focused": { "audio": "D:/private-voice-bank/focused.wav", "text": "对应这段专注录音的逐字原文" }
}
```

这些只是字段示例，不是实际配套语料。没有某种情绪录音时回到默认参考音频。支持名称见 `src/tts/style.js`；调用方已经把人格/情绪风格传入语音链路。不能把语音风格适配描述为独立人格训练完成。

## 6. 接手验收与故障定位

```powershell
node tests/voice-bank-setup.js
node tests/frontend-realtime-behavior.js
node tests/frontend-realtime-cancellation-gaps.js
```

- **路径检查失败**：配置对方自己的路径；不要照搬原机器盘符。
- **API 启动失败/退回默认权重**：检查真实权重版本、编码器/声码器、启动日志及实际配置路径。本工具只校验存在性，不会证明权重内部兼容。
- **提示配置不完整**：确认应用配置后已重启 Node；参考音频及文本必须同时存在。
- **无声**：确认舞台声音已开、浏览器允许播放、输出设备正确；查看 `/api/tts` 是否返回 WAV，而不是错误或静音音频。
- **音色/读音不对**：先核对配套 GPT/SoVITS 权重和参考转写，再尝试调整情绪素材/速度；不要先重训。
- **显存不足**：将本地聊天模型、语音、视觉服务的显存合并计算；本机目前是 16 GB 显卡，不能假设语音服务与 32B 模型可同时全量放入显存。

最小人工验收：中性/开心/专注各一句（没有情绪素材则只验证中性）；播放中切回系统声音；再次切回声库；断开语音服务后明确显示失败；重启后恢复。结果记录声音版本、延迟和是否实听通过。

## 7. 本次交付边界

本次新增可迁移配置工具与启动配置读取，复用现有前端声音切换。不会自动把现有实验声库公开上传，不重新训练，不更改聊天模型，不接管正在运行的游戏。自动检查和本机文件检查不能代替对方机器上实际合成与听音验收。

后续由接手 Codex 按本文补齐依赖、核对私人声库、执行配置和验收，并记录具体失败；不要因为“下载完成”就标记整个语音链路已部署成功。
