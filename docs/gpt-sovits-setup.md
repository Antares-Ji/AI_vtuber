# GPT-SoVITS 声库部署

当前跨机器部署请阅读 [希儿声库接入与切换](seele-voice-handoff.md)。本机现有实验声库实际为 v4，不能继续沿用旧版 v2 默认权重说明。

入口模板：`config/voices/seele.example.json`。将其复制到被忽略的 `runtime/voices/`，填入接手机器的服务路径、配套 GPT/SoVITS 权重、参考音频与准确转写，再运行 `scripts/configure-voice.js`。默认只检查，加 `--apply` 才写本机配置。

声库权重、参考音频和私有配置不随 GitHub 源码提供；使用和分享范围需与提供方确认。路径检查通过不等于合成质量或扬声器输出已验收。
