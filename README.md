# llama.cpp Snapdragon NPU Chat Example

A minimal Windows on Snapdragon example that serves a browser chat UI from
`llama-server.exe` and targets the Qualcomm Hexagon NPU through the llama.cpp
Snapdragon backend.

This repository does not vendor llama.cpp, Qualcomm SDKs, model files, or build
artifacts. It contains the small frontend and launcher script used to test a
local llama.cpp Snapdragon package.

For a deeper walkthrough of what is running and how llama.cpp reaches the NPU,
see [ARCHITECTURE.md](ARCHITECTURE.md).

## What This Runs

The tested setup used:

- Machine: Snapdragon X Elite Windows PC
- Runtime: `llama-server.exe` from a Snapdragon-enabled llama.cpp build
- Backend target: `HTP0`, the Qualcomm Hexagon NPU device
- Demo model: `qwen2.5-0.5b-instruct-q4_0.gguf`
- API: OpenAI-compatible `POST /v1/chat/completions`
- Streaming: Server-sent events read by the browser with `fetch()`

The Qwen2.5 0.5B model is still small enough for quick Snapdragon NPU testing,
but it gives better answers than the original tiny SmolLM2 135M smoke-test
model.

## Architecture

```text
Browser chat UI
  -> /v1/chat/completions with stream: true
  -> llama-server.exe
  -> llama.cpp model runtime
  -> ggml compute graph
  -> ggml Hexagon backend
  -> Qualcomm HTP / Hexagon NPU device HTP0
```

The frontend does not run inference. It only sends chat messages to
`llama-server.exe` and renders streamed token chunks as they arrive.

The NPU path is selected by the server launch arguments:

```powershell
--device HTP0 -ngl 99
```

`--device HTP0` selects the Hexagon device exposed by the Snapdragon backend.
`-ngl 99` asks llama.cpp to offload model layers to the selected accelerator
backend where possible.

## Repository Layout

```text
.
|-- npu-chat/
|   |-- index.html
|   |-- styles.css
|   `-- app.js
|-- start-npu-chat.ps1
|-- .gitignore
`-- README.md
```

Expected local runtime folders, not committed:

```text
.
|-- gguf/
|   `-- qwen2.5-0.5b-instruct-q4_0.gguf
`-- pkg-snapdragon/
    |-- bin/
    |   `-- llama-server.exe
    `-- lib/
        |-- libggml-htp-v73.so
        `-- libggml-htp.cat
```

## Prerequisites

Follow the upstream llama.cpp Snapdragon backend documentation first:

- `docs/backend/snapdragon/README.md`
- `docs/backend/snapdragon/windows.md`

At a high level, you need:

- Windows on Snapdragon, such as Snapdragon X Elite
- Native ARM64 PowerShell session
- LLVM/Clang
- Qualcomm OpenCL SDK
- Qualcomm Hexagon SDK
- Qualcomm NPU driver visible in Device Manager
- Windows test-signing enabled for the HTP catalog flow
- A Snapdragon-enabled llama.cpp install at `pkg-snapdragon`
- A GGUF model in `gguf`

The tested llama.cpp package contained:

```text
pkg-snapdragon\bin\llama-server.exe
pkg-snapdragon\bin\ggml-hexagon.dll
pkg-snapdragon\lib\libggml-htp-v73.so
pkg-snapdragon\lib\libggml-htp.cat
```

## Quick Start

Clone this repository:

```powershell
git clone https://github.com/shivaylamba/llama.cpp-snapdragon-npu-example.git
cd llama.cpp-snapdragon-npu-example
```

Copy or create these folders from your Snapdragon llama.cpp build:

```text
pkg-snapdragon\
gguf\
```

Put a compatible GGUF model in `gguf`. The default script expects:

```text
gguf\qwen2.5-0.5b-instruct-q4_0.gguf
```

Start the local server and chat UI:

```powershell
.\start-npu-chat.ps1
```

Open:

```text
http://127.0.0.1:8080/
```

To use a different model:

```powershell
.\start-npu-chat.ps1 -Model "YourModel-Q4_0.gguf"
```

To use a different port:

```powershell
.\start-npu-chat.ps1 -Port 8081
```

## What The Launcher Does

`start-npu-chat.ps1`:

1. Finds `pkg-snapdragon\bin\llama-server.exe`.
2. Finds the model under `gguf`.
3. Sets `PATH` so llama.cpp DLLs can load.
4. Sets `ADSP_LIBRARY_PATH` so the Hexagon runtime can find HTP libraries.
5. Starts `llama-server.exe` with:

```powershell
--device HTP0
-ngl 99
--path npu-chat
--host 127.0.0.1
--port 8080
```

6. Writes logs to:

```text
logs\npu-chat-server.out.log
logs\npu-chat-server.err.log
```

## How To Prove The NPU Is Being Used

First confirm Windows sees the NPU:

```powershell
Get-PnpDevice -Class ComputeAccelerator
```

You should see a Qualcomm Hexagon NPU device in an `OK` state.

Then start this app and inspect the server log:

```powershell
Select-String .\logs\npu-chat-server.err.log -Pattern "HTP0|Hexagon|prompt eval|eval time"
```

Useful signs:

```text
HTP0 : Hexagon
prompt eval time = ...
eval time = ...
```

For a lower-level backend test, run:

```powershell
.\pkg-snapdragon\bin\test-backend-ops.exe -b HTP0 -o MUL_MAT
```

That test exercises the Hexagon backend directly. If it fails, the chat UI may
still load, but the NPU path is not healthy.

## Frontend Behavior

The browser sends:

```json
{
  "model": "snapdragon-npu",
  "messages": [],
  "stream": true,
  "temperature": 0.7,
  "max_tokens": 256,
  "cache_prompt": false
}
```

The response is streamed as server-sent event chunks from
`/v1/chat/completions`. The UI appends each `delta.content` fragment to the
assistant message as it arrives.

If a stream ends without text, the UI retries once with a non-stream request.
This handles cases where a tiny model emits an immediate stop token.

## Model Notes

The default model is still small on purpose:

```text
qwen2.5-0.5b-instruct-q4_0.gguf
```

It is useful for:

- fast startup
- low memory pressure
- validating the HTP/NPU path
- testing browser streaming

It is much better than a 135M smoke-test model, but it is still not ideal for:

- math
- reasoning
- long conversations
- high quality assistant answers

Other model candidates to test:

- `SmolLM2-135M-Instruct-Q4_0.gguf`
- `SmolLM2-360M-Instruct-Q4_0.gguf`
- `Qwen2.5-1.5B-Instruct-Q4_0.gguf`
- `Llama-3.2-1B-Instruct-Q4_0.gguf`

For Snapdragon Hexagon testing, start with `Q4_0` GGUFs before trying more
complex quantization formats.

## Troubleshooting

### Server starts, but browser says server offline

Check whether port `8080` is already in use:

```powershell
Get-NetTCPConnection -LocalPort 8080 -State Listen
```

Start on another port if needed:

```powershell
.\start-npu-chat.ps1 -Port 8081
```

### Missing HTP libraries

Make sure `pkg-snapdragon\lib` contains the HTP files and that the launcher set:

```powershell
$env:ADSP_LIBRARY_PATH = "...\pkg-snapdragon\lib"
```

### NPU does not appear

Check:

```powershell
Get-PnpDevice -Class ComputeAccelerator
```

If no Qualcomm Hexagon NPU appears, install or repair the Qualcomm NPU/HND
driver before debugging llama.cpp.

### No text returned

This can happen with tiny models when they emit a stop token immediately. Clear
the chat and retry, or use a stronger instruct model.

## What This Is Not

This is not a fork of llama.cpp and does not modify llama.cpp source code. It is
a small example that runs on top of an already-built Snapdragon-enabled
llama.cpp package.

It also does not include model weights or Qualcomm binaries. Those must be
obtained and installed separately according to their respective licenses.
