import os
import re
import tempfile
import time
import wave

from fastapi import FastAPI, HTTPException, Request
from funasr import AutoModel

MODEL = os.getenv("ASR_MODEL", "iic/SenseVoiceSmall")
VAD_MODEL = os.getenv("ASR_VAD_MODEL", "")
PUNC_MODEL = os.getenv("ASR_PUNC_MODEL", "")
DEVICE = os.getenv("ASR_DEVICE", "cuda:0")

app = FastAPI(title="Local Chinese ASR")
model = None
load_error = None


@app.on_event("startup")
def load_on_startup():
    get_model()


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
