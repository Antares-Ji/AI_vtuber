import os
import re
import tempfile
import time
import wave
import threading

from fastapi import FastAPI, HTTPException, Request, WebSocket
from funasr import AutoModel
from .streaming import FunAsrOnlineRecognizer
from .streaming_endpoint import serve_stream

MODEL = os.getenv("ASR_MODEL", "iic/SenseVoiceSmall")
VAD_MODEL = os.getenv("ASR_VAD_MODEL", "")
PUNC_MODEL = os.getenv("ASR_PUNC_MODEL", "")
DEVICE = os.getenv("ASR_DEVICE", "cuda:0")

app = FastAPI(title="Local Chinese ASR")
model = None
load_error = None
streaming_model = None
streaming_error = None
streaming_lock = threading.Lock()


class LockedStreamingModel:
    def generate(self, **options):
        with streaming_lock:
            return streaming_model.generate(**options)


@app.on_event("startup")
def load_on_startup():
    get_model()
    load_streaming_model()


def load_streaming_model():
    global streaming_model, streaming_error
    if os.getenv("ASR_STREAMING_ENABLED", "false").lower() != "true":
        return
    model_path = os.getenv("ASR_STREAMING_MODEL_PATH", "")
    # Require an existing complete model directory, never a remote model ID.
    if not os.path.isfile(os.path.join(model_path, "model.pt")) or not os.path.isfile(os.path.join(model_path, "config.yaml")):
        streaming_error = "local streaming model.pt and config.yaml are required"
        return
    try:
        streaming_model = AutoModel(model=os.path.abspath(model_path), device=DEVICE, disable_update=True)
    except Exception:
        streaming_error = "streaming model failed to load"


@app.websocket("/stream")
async def streaming(websocket: WebSocket):
    origin = websocket.headers.get("origin")
    if origin and origin not in {"http://localhost:3000", "http://127.0.0.1:3000"}:
        await websocket.close(code=1008)
        return
    if streaming_model is None:
        await websocket.close(code=1013)
        return
    await serve_stream(websocket, FunAsrOnlineRecognizer(LockedStreamingModel()))


def get_model():
    global model, load_error
    if model is not None:
        return model
    if load_error is not None:
        raise RuntimeError(load_error)
    try:
        options = {
            "model": MODEL,
            "device": DEVICE,
            "disable_update": True,
        }
        if VAD_MODEL:
            options["vad_model"] = VAD_MODEL
        if PUNC_MODEL:
            options["punc_model"] = PUNC_MODEL
        model = AutoModel(
            **options,
        )
        return model
    except Exception as error:
        load_error = str(error)
        raise


@app.get("/health")
def health():
    return {
        "ready": model is not None,
        "model": MODEL,
        "device": DEVICE,
        "error": load_error,
        "streaming": {"ready": streaming_model is not None, "error": streaming_error, "transport": "websocket-pcm16", "endpoint": "/stream"},
    }


@app.post("/transcribe")
async def transcribe(request: Request):
    audio = await request.body()
    if not audio:
        raise HTTPException(status_code=400, detail="audio body is required")

    started = time.perf_counter()
    temp_file = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as handle:
            handle.write(audio)
            temp_file = handle.name
        with wave.open(temp_file, "rb") as wav:
            if wav.getframerate() != 16000 or wav.getnchannels() != 1:
                raise HTTPException(status_code=400, detail="expected 16kHz mono wav")
        options = {"input": temp_file, "batch_size_s": 60}
        if "sensevoice" in MODEL.lower():
            options.update({"language": "zn", "use_itn": True})
        result = get_model().generate(**options)
        text = "".join(item.get("text", "") for item in result).strip()
        text = re.sub(r"<\|[^>]+\|>", "", text).strip()
        return {
            "text": text,
            "model": MODEL,
            "latencyMs": round((time.perf_counter() - started) * 1000),
        }
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    finally:
        if temp_file and os.path.exists(temp_file):
            os.remove(temp_file)
