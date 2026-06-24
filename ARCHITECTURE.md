# Architecture Explanation

Yes: this is `llama.cpp` running under the hood. The browser UI is only a thin
frontend.

## What Is Running

The current tested bigger model is:

```text
C:\Users\Admin\Documents\llamacpp\gguf\qwen2.5-0.5b-instruct-q4_0.gguf
```

That is Qwen2.5 0.5B Instruct, quantized as `Q4_0`, about 409 MB. It is still a
small on-device model, but it gives better answers than the first tiny
proof-of-pipeline model.

The first smoke-test model was:

```text
C:\Users\Admin\Documents\llamacpp\gguf\SmolLM2-135M-Instruct-Q4_0.gguf
```

That model is a very small Hugging Face SmolLM2 instruct model, quantized as
`Q4_0`, about 92 MB. It is useful for proving the pipeline works, but it is not
a strong reasoning or chat model. If it gives weird answers, that is mostly the
tiny model, not the UI.

The runtime is:

```text
C:\Users\Admin\Documents\llamacpp\pkg-snapdragon\bin\llama-server.exe
```

That is the `llama.cpp` server built for Windows ARM64 with the
Snapdragon/Hexagon backend included.

## Architecture

The flow is:

```text
Browser chat UI
  -> fetch("/v1/chat/completions", stream: true)
  -> llama-server.exe
  -> llama.cpp model/token runtime
  -> ggml compute graph
  -> ggml Hexagon backend
  -> Qualcomm HTP / Hexagon NPU device HTP0
```

The frontend files are in:

```text
C:\Users\Admin\Documents\llamacpp\npu-chat\
```

They do not run the model themselves. They send chat messages to the local
`llama-server` API and read back streaming chunks.

## How The Server Is Started

The launcher is:

```text
C:\Users\Admin\Documents\llamacpp\start-npu-chat.ps1
```

The important args are:

```powershell
-m gguf\qwen2.5-0.5b-instruct-q4_0.gguf
--path npu-chat
--host 127.0.0.1
--port 8080
--device HTP0
-ngl 99
--no-mmap
```

`--path npu-chat` makes `llama-server` serve the frontend.

`--device HTP0` tells llama.cpp to use the Snapdragon Hexagon NPU device.

`-ngl 99` tells llama.cpp to offload as many model layers as possible to the
selected accelerator backend.

## How llama.cpp Talks To The NPU

llama.cpp uses `ggml`, its tensor/compute backend layer. In this build, ggml has
multiple backends available:

- CPU backend
- OpenCL backend for Adreno GPU
- Hexagon backend for Snapdragon HTP/NPU

The important pieces are present here:

```text
pkg-snapdragon\bin\ggml-hexagon.dll
pkg-snapdragon\lib\libggml-htp-v73.so
pkg-snapdragon\lib\libggml-htp.cat
```

The launcher sets:

```powershell
$env:ADSP_LIBRARY_PATH = "C:\Users\Admin\Documents\llamacpp\pkg-snapdragon\lib"
```

That lets the Hexagon runtime find the HTP-side libraries. The catalog
signing/test-signing flow is what allows Windows to load the HTP binary
package.

When you send a prompt, llama.cpp tokenizes it, builds a ggml graph for
inference, and the backend scheduler places supported work on `HTP0`.
Unsupported or control-ish pieces can still run on CPU. The big win is matrix
multiplication and transformer layer work moving to the NPU backend.

## Is The NPU Being Used?

For this app, the server is running with:

```powershell
--device HTP0 -ngl 99
```

The startup log detected:

```text
HTP0 : Hexagon
```

So the app is configured to use the NPU backend, not just CPU.

The strongest proof commands are:

```powershell
Select-String .\logs\npu-chat-server.err.log -Pattern "HTP0|Hexagon|prompt eval|eval time"
```

and the backend sanity test:

```powershell
.\pkg-snapdragon\bin\test-backend-ops.exe -b HTP0 -o MUL_MAT
```

The backend test passed on `HTP0`, which proves the Hexagon backend can execute
NPU ops. The chat app then uses the same installed Snapdragon build and launches
`llama-server` against `HTP0`.

## Why The Answer Quality May Look Bad

Answer quality depends heavily on the model.

`SmolLM2-135M-Instruct-Q4_0` is tiny. It is good for verifying:

- frontend works
- streaming works
- llama-server works
- NPU backend loads
- tokens generate

It is not good for reliable math or high-quality assistant answers.

`qwen2.5-0.5b-instruct-q4_0` is a better default for this example. It is still
small enough to test quickly, but gives more useful answers than the 135M
smoke-test model.
