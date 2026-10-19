import os
import json
import asyncio
import base64
import io
import traceback
from contextlib import nullcontext
from contextlib import asynccontextmanager

import torch
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from transformers import AutoModelForMultimodalLM, AutoProcessor, BitsAndBytesConfig, TextIteratorStreamer, StoppingCriteria, StoppingCriteriaList
from .performance_diagnostics import RequestDiagnostic
from .generation_gate import CancellableGenerationGate, ClientDisconnected, GenerationTimeout, QueueFull, QueueTimeout

MODEL_PATH = os.environ.get("QWEN_MODEL_PATH", r"E:\Qwen3.5-4B")
MODEL_NAME = os.environ.get("QWEN_MODEL_NAME", "qwen3.5-4b")
ADAPTER_PATH = os.environ.get("QWEN_ADAPTER_PATH", "").strip()
processor = None
model = None
generation_gate = CancellableGenerationGate(max_waiters=4)
GENERATION_QUEUE_TIMEOUT_SECONDS = float(os.environ.get("QWEN_GENERATION_QUEUE_TIMEOUT_SECONDS", "3"))
GENERATION_RUN_TIMEOUT_SECONDS = float(os.environ.get("QWEN_GENERATION_RUN_TIMEOUT_SECONDS", "45"))


class DisconnectStoppingCriteria(StoppingCriteria):
    def __init__(self, event):
        self.event = event

    def __call__(self, input_ids, scores, **kwargs):
        return self.event.is_set()


class ChatRequest(BaseModel):
    model: str | None = None
    task: str | None = None
    messages: list[dict]
    temperature: float = 0.7
    max_tokens: int = 160
    stream: bool = False
    image_base64: str | None = None


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
    if ADAPTER_PATH:
        # Keep the base checkpoint immutable; load the trained PEFT adapter as
        # an optional inference overlay selected explicitly by environment.
        from peft import PeftModel
        model = PeftModel.from_pretrained(model, ADAPTER_PATH, is_trainable=False)
    model.eval()
    yield
    await generation_gate.drain(cancel=True)


app = FastAPI(title="AI Vtuber Qwen local service", lifespan=lifespan)


def gpu_memory_snapshot():
    """Read allocator counters without initializing CUDA or synchronizing work.

    These are this process's PyTorch counters, not total Windows/WDDM usage.
    Peaks are lifetime peaks; health polling must never reset them.
    """
    try:
        initialized = torch.cuda.is_initialized()
        if not initialized:
            return {"initialized": False, "devices": []}
        devices = []
        for index in range(torch.cuda.device_count()):
            devices.append({
                "device": index,
                "allocated_bytes": torch.cuda.memory_allocated(index),
                "reserved_bytes": torch.cuda.memory_reserved(index),
                "max_allocated_bytes": torch.cuda.max_memory_allocated(index),
                "max_reserved_bytes": torch.cuda.max_memory_reserved(index),
            })
        return {"initialized": True, "devices": devices}
    except Exception as error:
        # No exception text: health must neither expose data nor fail because
        # a diagnostic read failed during device teardown.
        return {"initialized": None, "devices": [], "error_type": type(error).__name__}


def clear_worker_tracebacks(error):
    """Drop tensors held by finished model frames while preserving the error.

    Executor futures can retain exceptions after a client disconnects. Clear
    finished traceback locals only after generate has unwound; never free the
    gate or touch a still-running CUDA worker. Keep stack locations and chains.
    """
    pending, seen = [error], set()
    while pending:
        current = pending.pop()
        if id(current) in seen:
            continue
        seen.add(id(current))
        traceback.clear_frames(current.__traceback__)
        pending.extend(value for value in (current.__cause__, current.__context__) if value is not None)


@app.get("/health")
async def health():
    generation = generation_gate.snapshot()
    return {
        "ok": model is not None,
        "model": MODEL_NAME,
        "path": MODEL_PATH,
        "quantization": "nf4",
        "adapter": ADAPTER_PATH or None,
        "adapter_loaded": bool(model is not None and ADAPTER_PATH),
        "adapter_scope": "minecraft-survival" if model is not None and ADAPTER_PATH else "none",
        "generation": generation,
        "generation_busy": generation["active"],
        "gpu_memory": gpu_memory_snapshot(),
    }


def prepare_generation(request: ChatRequest):
    if model is None or processor is None:
        raise HTTPException(status_code=503, detail="model is loading")
    prompt = processor.apply_chat_template(
        request.messages,
        tokenize=False,
        add_generation_prompt=True,
        enable_thinking=False,
    )
    if request.image_base64:
        from PIL import Image
        if len(request.image_base64) > 4_000_000:
            raise HTTPException(status_code=413, detail="image too large")
        image = Image.open(io.BytesIO(base64.b64decode(request.image_base64, validate=True))).convert("RGB")
        image.thumbnail((640, 384))
        messages = [dict(message) for message in request.messages]
        if not messages or messages[-1].get("role") != "user" or not isinstance(messages[-1].get("content"), str):
            raise HTTPException(status_code=400, detail="image requires a final user text message")
        messages[-1]["content"] = [{"type": "image"}, {"type": "text", "text": messages[-1]["content"]}]
        prompt = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True, enable_thinking=False)
        inputs = processor(text=prompt, images=[image], return_tensors="pt").to(model.device)
    else:
        inputs = processor(text=prompt, return_tensors="pt").to(model.device)
    generation = {
        **inputs,
        "max_new_tokens": min(max(request.max_tokens, 1), 512),
        "do_sample": request.temperature > 0,
        "temperature": max(request.temperature, 0.01),
        "top_p": 0.9,
    }
    return inputs, generation


def map_generation_error(error):
    if isinstance(error, (QueueFull, QueueTimeout)):
        raise HTTPException(status_code=503, detail="model generation queue is full or its 3 second wait expired") from error
    if isinstance(error, GenerationTimeout):
        raise HTTPException(status_code=504, detail="model generation exceeded its deadline") from error
    if isinstance(error, ClientDisconnected):
        raise HTTPException(status_code=499, detail="client disconnected") from error
    raise error


@app.post("/v1/chat/completions")
async def chat(request: ChatRequest, http_request: Request):
    if model is None or processor is None:
        raise HTTPException(status_code=503, detail="model is loading")
    diagnostic = RequestDiagnostic(request.task, http_request.headers.get("x-request-id"))
    use_adapter = bool(ADAPTER_PATH and request.task == "minecraft-survival")

    def adapter_context():
        if ADAPTER_PATH and not use_adapter:
            return model.disable_adapter()
        return nullcontext()

    metadata = {
        "request_id": diagnostic.request_id,
        "task": request.task,
        "used_adapter": use_adapter,
        "adapter_path": ADAPTER_PATH if use_adapter else None,
    }
    if request.stream:
        streamer = TextIteratorStreamer(processor.tokenizer, skip_prompt=True, skip_special_tokens=True, timeout=60.0)
        worker_started = asyncio.Event()
        loop = asyncio.get_running_loop()
        disconnected = False

        def run_generate(stop_event):
            loop.call_soon_threadsafe(worker_started.set)
            inputs = generation = None
            try:
                # Preparation and adapter switching are serialized with generate.
                inputs, generation = diagnostic.measure("prepare", lambda: prepare_generation(request))
                diagnostic.input_tokens(inputs)
                generation["streamer"] = streamer
                generation["stopping_criteria"] = StoppingCriteriaList([DisconnectStoppingCriteria(stop_event)])
                with adapter_context(), torch.inference_mode():
                    diagnostic.measure("generate", lambda: model.generate(**generation))
            except BaseException as error:
                clear_worker_tracebacks(error)
                streamer.end()
                raise
            finally:
                inputs = generation = None

        async def disconnect_check():
            return disconnected

        worker_task = asyncio.create_task(generation_gate.execute(
            run_generate, is_disconnected=disconnect_check,
            queue_timeout=GENERATION_QUEUE_TIMEOUT_SECONDS,
            run_timeout=GENERATION_RUN_TIMEOUT_SECONDS, diagnostic=diagnostic,
        ))
        try:
            # Do not send 200 headers until queue admission succeeds, so queue
            # errors keep an HTTP 503/504 status for streaming clients too.
            admission_deadline = loop.time() + GENERATION_QUEUE_TIMEOUT_SECONDS + 0.25
            while not worker_started.is_set() and not worker_task.done():
                if await http_request.is_disconnected():
                    disconnected = True
                    raise ClientDisconnected("Client disconnected before stream admission")
                remaining = admission_deadline - loop.time()
                if remaining <= 0:
                    raise QueueTimeout("Generation worker did not enter before admission deadline")
                await asyncio.sleep(min(0.01, remaining))
            if worker_task.done() and not worker_started.is_set():
                await worker_task
            if not worker_started.is_set():
                raise QueueTimeout("Generation worker did not enter before admission deadline")
        except BaseException as error:
            # Admission can be cancelled by ASGI while the worker is queued.
            # Propagate that cancellation through the gate so an orphan cannot
            # acquire the GPU slot after the response has gone away.
            disconnected = True
            if not worker_task.done():
                worker_task.cancel()
            await asyncio.gather(worker_task, return_exceptions=True)
            if isinstance(error, (QueueFull, QueueTimeout, GenerationTimeout, ClientDisconnected)):
                map_generation_error(error)
            raise

        async def stream_events():
            nonlocal disconnected
            try:
                iterator = iter(streamer)
                sentinel = object()
                while True:
                    # TextIteratorStreamer is blocking; race token retrieval
                    # against gate completion so a timed-out generation cannot
                    # leave the HTTP stream waiting for the streamer's timeout.
                    token_task = asyncio.create_task(asyncio.to_thread(lambda: next(iterator, sentinel)))
                    done, _ = await asyncio.wait({token_task, worker_task}, return_when=asyncio.FIRST_COMPLETED)
                    if worker_task in done and worker_task.exception() is not None:
                        token_task.cancel()
                        await asyncio.gather(token_task, return_exceptions=True)
                        await worker_task
                    token = await token_task
                    if token is sentinel:
                        break
                    payload = {"id": "local-qwen", "object": "chat.completion.chunk", "model": MODEL_NAME, "metadata": metadata, "choices": [{"index": 0, "delta": {"content": token}, "finish_reason": None}]}
                    yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
                await worker_task
                yield "data: [DONE]\n\n"
            except (QueueFull, QueueTimeout, GenerationTimeout, ClientDisconnected) as error:
                # Once the stream has started, HTTP status is committed; end it
                # cleanly and let the generation gate retain the GPU slot until
                # the native worker actually exits.
                yield f"data: {json.dumps({'error': str(error), 'metadata': metadata}, ensure_ascii=False)}\n\n"
                yield "data: [DONE]\n\n"
            except asyncio.CancelledError:
                disconnected = True
                raise
            except BaseException as error:
                if worker_started.is_set():
                    yield f"data: {json.dumps({'error': str(error), 'metadata': metadata}, ensure_ascii=False)}\n\n"
                    yield "data: [DONE]\n\n"
                else:
                    raise
            finally:
                if not worker_task.done():
                    disconnected = True
                    worker_task.cancel()

        return StreamingResponse(stream_events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    def run_generate(stop_event):
        inputs = generation = output = generated = None
        try:
            inputs, generation = diagnostic.measure("prepare", lambda: prepare_generation(request))
            diagnostic.input_tokens(inputs)
            generation["stopping_criteria"] = StoppingCriteriaList([DisconnectStoppingCriteria(stop_event)])
            with adapter_context(), torch.inference_mode():
                output = diagnostic.measure("generate", lambda: model.generate(**generation))
            generated = output[0, inputs["input_ids"].shape[1]:]
            return processor.decode(generated, skip_special_tokens=True).strip()
        except BaseException as error:
            clear_worker_tracebacks(error)
            raise
        finally:
            inputs = generation = output = generated = None

    try:
        content = await generation_gate.execute(
            run_generate, is_disconnected=http_request.is_disconnected,
            queue_timeout=GENERATION_QUEUE_TIMEOUT_SECONDS,
            run_timeout=GENERATION_RUN_TIMEOUT_SECONDS, diagnostic=diagnostic,
        )
    except (QueueFull, QueueTimeout, GenerationTimeout, ClientDisconnected) as error:
        map_generation_error(error)
    return {"id": "local-qwen", "object": "chat.completion", "model": MODEL_NAME, "metadata": metadata, "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}]}
