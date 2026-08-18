# GPT-SoVITS Local TTS

The local runtime is installed in `third_party/GPT-SoVITS` and uses the RTX 5070 through CUDA.

Before it can synthesize speech, place the official GPT-SoVITS v2 base weights here:

```text
third_party/GPT-SoVITS/GPT_SoVITS/pretrained_models/gsv-v2final-pretrained/
  s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt
  s2G2333k.pth
```

Use the upstream project's official model-download guidance. Do not substitute unverified community weight packs.

For a legal custom voice, prepare these two items:

```text
assets/tts/reference.wav   # 3-10 seconds, preferably 5-8 seconds, clean licensed speech
Reference text             # the exact words spoken in reference.wav
```

Then add these values to `.env`:

```env
TTS_PROVIDER=gpt-sovits
GPT_SOVITS_BASE_URL=http://127.0.0.1:9880
GPT_SOVITS_REF_AUDIO=E:/iwen_codex/codex_neurosama/assets/tts/reference.wav
GPT_SOVITS_PROMPT_TEXT=the exact reference transcript
GPT_SOVITS_PROMPT_LANG=zh
GPT_SOVITS_TEXT_LANG=zh
```

Run `powershell -ExecutionPolicy Bypass -File scripts/start-gpt-sovits.ps1` in the project root. Then restart the Node streamer server. The streamer will use `/api/tts`; if the service is unavailable it falls back to browser speech.
