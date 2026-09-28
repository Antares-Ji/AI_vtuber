import os
import json
import threading
from contextlib import asynccontextmanager

import torch
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from transformers import AutoModelForMultimodalLM, AutoProcessor, BitsAndBytesConfig, TextIteratorStreamer, StoppingCriteria, StoppingCriteriaList

MODEL_PATH = os.environ.get("QWEN_MODEL_PATH", r"E:\Qwen3.5-4B")
MODEL_NAME = os.environ.get("QWEN_MODEL_NAME", "qwen3.5-4b")
processor = None
model = None


class DisconnectStoppingCriteria(StoppingCriteria):
    def __init__(self, event):
        self.event = event

    def __call__(self, input_ids, scores, **kwargs):
        return self.event.is_set()


class ChatRequest(BaseModel):
    model: str | None = None
    messages: list[dict]
    temperature: float = 0.7
    max_tokens: int = 160
    stream: bool = False


@asynccontextmanager
async def lifespan(_: FastAPI):
    global processor, model
    quantization = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.bfloat16,
        bnb_4bit_use_double_quant=True,
    )
    processor = AutoProcessor.from_pretrained(MODEL_PATH, trust_remote_code=True)
    model = AutoModelForMultimodalLM.from_pretrained(
        MODEL_PATH,
        trust_remote_code=True,
        torch_dtype=torch.bfloat16,
        quantization_config=quantization,
        device_map="auto",
        low_cpu_mem_usage=True,
    )
    model.eval()
    yield


app = FastAPI(title="AI Vtuber Qwen local service", lifespan=lifespan)


@app.get("/health")
def health():
    return {"ok": model is not None, "model": MODEL_NAME, "path": MODEL_PATH, "quantization": "nf4"}


def prepare_generation(request: ChatRequest):
    if model is None or processor is None:
        raise HTTPException(status_code=503, detail="model is loading")
    prompt = processor.apply_chat_template(
        request.messages,
        tokenize=False,
        add_generation_prompt=True,
        enable_thinking=False,
    )
    inputs = processor(text=prompt, return_tensors="pt").to(model.device)
    generation = {
        **inputs,
        "max_new_tokens": min(max(request.max_tokens, 1), 512),
        "do_sample": request.temperature > 0,
        "temperature": max(request.temperature, 0.01),
        "top_p": 0.9,
    }
    return inputs, generation


@app.post("/v1/chat/completions")
def chat(request: ChatRequest):
    inputs, generation = prepare_generation(request)
    if request.stream:
        stop_event = threading.Event()
        streamer = TextIteratorStreamer(processor.tokenizer, skip_prompt=True, skip_special_tokens=True, timeout=30.0)
        generation["streamer"] = streamer
        generation["stopping_criteria"] = StoppingCriteriaList([DisconnectStoppingCriteria(stop_event)])

        def run_generate():
            with torch.inference_mode():
                model.generate(**generation)

        threading.Thread(target=run_generate, daemon=True).start()

        def events():
            try:
                for token in streamer:
                    payload = {"id": "local-qwen", "object": "chat.completion.chunk", "model": MODEL_NAME, "choices": [{"index": 0, "delta": {"content": token}, "finish_reason": None}]}
                    yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
                yield "data: [DONE]\n\n"
            finally:
                stop_event.set()

        return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    with torch.inference_mode():
        output = model.generate(**generation)
    generated = output[0, inputs["input_ids"].shape[1]:]
    content = processor.decode(generated, skip_special_tokens=True).strip()
    return {"id": "local-qwen", "object": "chat.completion", "model": MODEL_NAME, "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}]}
