#!/usr/bin/env python3
"""
inference/hf_server.py — Serve a fine-tuned HuggingFace model via Ollama-compatible API.

Runs on port 11436 alongside the GGUF server (port 11435).
The Proverbs CLI connects to it with: /backend http://localhost:11436

Usage:
    python inference/hf_server.py
    python inference/hf_server.py --model ~/.proverbs/checkpoints/finetuned-qwen --port 11436
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import AsyncGenerator

_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

import torch
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from transformers import AutoModelForCausalLM, AutoTokenizer, TextIteratorStreamer
from threading import Thread

# ── Defaults ─────────────────────────────────────────────────────────────────

DEFAULT_MODEL = str(Path.home() / ".proverbs" / "checkpoints" / "finetuned-qwen")
DEFAULT_PORT  = 11436
MODEL_NAME    = "finetuned-qwen"

# ── State ─────────────────────────────────────────────────────────────────────

_model     = None
_tokenizer = None
_device    = "cpu"
_dtype     = torch.float32

# ── App ───────────────────────────────────────────────────────────────────────

app = FastAPI(title="Proverbs HF Server")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── API models ────────────────────────────────────────────────────────────────

class ChatMessage(BaseModel):
    role: str
    content: str = ""


class ChatRequest(BaseModel):
    model: str = MODEL_NAME
    messages: list[ChatMessage]
    stream: bool = True
    temperature: float = 0.7
    top_p: float = 0.9
    max_tokens: int = 512


# ── Generation ────────────────────────────────────────────────────────────────

def build_prompt(messages: list[ChatMessage]) -> str:
    """Apply chat template."""
    raw = [{"role": m.role, "content": m.content} for m in messages]
    return _tokenizer.apply_chat_template(
        raw,
        tokenize=False,
        add_generation_prompt=True,
    )


def _do_generate(prompt: str, max_new: int, temp: float, top_p: float, streamer):
    ids = _tokenizer(prompt, return_tensors="pt").input_ids.to(_device)
    _model.generate(
        ids,
        streamer=streamer,
        max_new_tokens=max_new,
        temperature=max(temp, 1e-4),
        top_p=top_p,
        do_sample=(temp > 0.05),
        pad_token_id=_tokenizer.eos_token_id,
    )


async def stream_response(req: ChatRequest) -> AsyncGenerator[str, None]:
    prompt  = build_prompt(req.messages)
    created = int(time.time())

    streamer = TextIteratorStreamer(
        _tokenizer, skip_prompt=True, skip_special_tokens=True,
    )
    t = Thread(
        target=_do_generate,
        args=(prompt, req.max_tokens, req.temperature, req.top_p, streamer),
        daemon=True,
    )
    t.start()

    for chunk in streamer:
        if not chunk:
            continue
        line = json.dumps({
            "model":      MODEL_NAME,
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(created)),
            "message":    {"role": "assistant", "content": chunk},
            "done":       False,
        })
        yield line + "\n"

    yield json.dumps({
        "model":      MODEL_NAME,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(created)),
        "message":    {"role": "assistant", "content": ""},
        "done":       True,
        "done_reason": "stop",
    }) + "\n"


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/api/tags")
def list_models():
    return {
        "models": [{
            "name":        MODEL_NAME,
            "modified_at": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "size":        0,
            "details":     {"format": "hf", "family": "qwen2.5-coder"},
        }]
    }


@app.get("/v1/models")
def v1_models():
    return {"object": "list", "data": [{"id": MODEL_NAME, "object": "model"}]}


@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL_NAME, "device": _device}


@app.post("/api/chat")
async def api_chat(req: ChatRequest):
    if _model is None:
        raise HTTPException(503, "Model not loaded")
    if req.stream:
        return StreamingResponse(
            stream_response(req),
            media_type="application/x-ndjson",
        )
    prompt = build_prompt(req.messages)
    ids    = _tokenizer(prompt, return_tensors="pt").input_ids.to(_device)
    with torch.inference_mode():
        out = _model.generate(
            ids,
            max_new_tokens=req.max_tokens,
            temperature=max(req.temperature, 1e-4),
            top_p=req.top_p,
            do_sample=(req.temperature > 0.05),
            pad_token_id=_tokenizer.eos_token_id,
        )
    new_ids = out[0][ids.shape[1]:]
    text    = _tokenizer.decode(new_ids, skip_special_tokens=True)
    return {
        "model":      MODEL_NAME,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "message":    {"role": "assistant", "content": text},
        "done":       True,
    }


@app.post("/v1/chat/completions")
async def v1_chat(req: ChatRequest):
    if _model is None:
        raise HTTPException(503, "Model not loaded")
    # Reuse api_chat, then reformat as OpenAI
    resp = await api_chat(req)
    if isinstance(resp, StreamingResponse):
        return resp
    return {
        "id":      "chatcmpl-hf-" + str(int(time.time())),
        "object":  "chat.completion",
        "model":   MODEL_NAME,
        "choices": [{
            "index":         0,
            "message":       resp["message"],
            "finish_reason": "stop",
        }],
    }


# ── Startup ───────────────────────────────────────────────────────────────────

@app.on_event("startup")
async def load_model():
    global _model, _tokenizer, _device, _dtype

    args = _get_args()
    model_path = args.model

    if not Path(model_path).exists():
        print(f"[hf-server] Model not found at {model_path}")
        print("[hf-server] Run: python finetune/finetune_qwen.py")
        return

    print(f"[hf-server] Loading {model_path} ...")

    if torch.cuda.is_available():
        _device = "cuda"
        _dtype  = torch.bfloat16
    elif torch.backends.mps.is_available():
        _device = "mps"
        _dtype  = torch.float32
    else:
        _device = "cpu"
        _dtype  = torch.float32

    _tokenizer = AutoTokenizer.from_pretrained(
        model_path, trust_remote_code=True, use_fast=True,
    )
    if _tokenizer.pad_token is None:
        _tokenizer.pad_token = _tokenizer.eos_token

    _model = AutoModelForCausalLM.from_pretrained(
        model_path,
        torch_dtype=_dtype,
        trust_remote_code=True,
        device_map=None,
    ).to(_device).eval()

    print(f"[hf-server] Ready on {_device}  ({_dtype})")


# ── CLI entry ─────────────────────────────────────────────────────────────────

_parsed_args = None

def _get_args():
    global _parsed_args
    if _parsed_args is None:
        p = argparse.ArgumentParser()
        p.add_argument("--model", default=DEFAULT_MODEL)
        p.add_argument("--port",  type=int, default=DEFAULT_PORT)
        p.add_argument("--host",  default="127.0.0.1")
        _parsed_args, _ = p.parse_known_args()
    return _parsed_args


if __name__ == "__main__":
    args = _get_args()
    print(f"\n  Proverbs HF Inference Server")
    print(f"  Model : {args.model}")
    print(f"  Port  : {args.port}\n")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
