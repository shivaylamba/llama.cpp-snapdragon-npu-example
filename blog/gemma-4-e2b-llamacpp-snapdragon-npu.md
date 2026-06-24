# Running Gemma 4 E2B with llama.cpp on the Snapdragon Hexagon NPU

Running large language models locally is no longer the strange demo you show
once and then quietly abandon.

On modern Snapdragon Windows machines, the interesting question is not whether
you can run a model. You can. The more useful question is whether you can run it
through the right acceleration stack, observe what is happening, and build a
repeatable workflow that does not collapse every time you swap models.

This is the story of getting Gemma 4 E2B running with `llama.cpp` on a
Snapdragon X Elite Windows machine, targeting Qualcomm's Hexagon NPU through
the experimental Snapdragon backend in `ggml`.

The end result is a local browser chat UI backed by:

```text
Browser UI
  -> llama-server OpenAI-compatible API
  -> llama.cpp
  -> ggml
  -> ggml Hexagon backend
  -> Qualcomm HTP / Hexagon NPU device HTP0
```

The model we tested:

```text
gemma-4-E2B-it-Q8_0.gguf
```

The runtime:

```text
llama-server.exe
```

The target accelerator:

```text
HTP0 : Hexagon
```

And the important lesson:

The browser does not talk to the NPU. `llama.cpp` does not really "talk to the
NPU" directly either. The request travels through a stack of runtime layers,
and each layer has its own failure modes.

Understanding those layers is the difference between "it runs on my machine"
and "I can explain, debug, and reproduce it."

## Why Gemma 4 E2B?

Google's Gemma llama.cpp integration docs point to the official GGUF repository:

```text
ggml-org/gemma-4-E2B-it-GGUF
```

Their quick-start path is intentionally simple:

```bash
llama-cli -hf ggml-org/gemma-4-E2B-it-GGUF --prompt "Write a poem about the Kraken."
```

or:

```bash
llama-server -hf ggml-org/gemma-4-E2B-it-GGUF
```

That is the nice path.

On our Snapdragon Windows build, there was one practical wrinkle: the local
`llama.cpp` binary had Hugging Face flags such as `-hf`, but it had not been
built with HTTPS support for the internal downloader. So the `-hf` command
failed with:

```text
HTTPS is not supported. Please rebuild with one of:
  -DLLAMA_BUILD_BORINGSSL=ON
  -DLLAMA_BUILD_LIBRESSL=ON
  -DLLAMA_OPENSSL=ON
```

That does not prevent Gemma from running. It only means we download the GGUF
with `curl.exe` and pass the local file path to `llama.cpp`.

## The Hardware And Software Stack

The machine used for this test was a Snapdragon X Elite Windows PC.

At runtime, `llama.cpp` detected three relevant devices:

```text
GPUOpenCL: Qualcomm(R) Adreno(TM) X1-85 GPU
HTP0    : Hexagon
CPU     : Snapdragon(R) X Elite - Qualcomm(R) Oryon(TM) CPU
```

The important device is `HTP0`.

In llama.cpp's Snapdragon backend, the Hexagon NPU behaves like an offload
device. That means it is selected with the same kind of flags you would use for
GPU offload:

```powershell
--device HTP0 -ngl 99
```

`--device HTP0` selects the Hexagon NPU device.

`-ngl 99` asks llama.cpp to offload as many model layers as possible to the
selected accelerator backend.

Under the hood, the stack looks like this:

```text
Prompt
  -> Browser chat UI
  -> fetch("/v1/chat/completions", stream: true)
  -> llama-server.exe
  -> llama.cpp model runtime
  -> ggml compute graph
  -> ggml Hexagon backend
  -> libggml-htp-v73.so
  -> Qualcomm HTP / Hexagon NPU
```

One of the biggest misconceptions with on-device AI is that the app somehow
calls the NPU directly.

It does not.

The app calls a local HTTP API. The HTTP API is served by `llama-server`. The
server uses llama.cpp. llama.cpp builds a graph in ggml. The ggml backend
scheduler places supported operations on the Hexagon backend. The Hexagon
backend loads HTP-side libraries and dispatches supported compute to the NPU.

When something breaks, it is usually at one of those boundaries.

## Prerequisites For Windows On Snapdragon

The upstream Snapdragon backend guide lists the native Windows ARM64 dependency
set:

- Visual Studio 2026 Community or Pro
- MSVC ARM64 libraries
- UCRT and Driver Kit
- LLVM core libraries and Clang
- CMake, Git, and Python
- Qualcomm OpenCL SDK 2.3 or later
- Qualcomm Hexagon SDK Community Edition 6.6 or later
- Latest Adreno GPU driver
- Latest Qualcomm NPU/HND driver

The tested local install used:

```text
C:\Qualcomm\OpenCL_SDK\2.3.2
C:\Qualcomm\Hexagon_SDK\6.6.0.0
```

You should also confirm that Windows sees the NPU.

Depending on the driver and Windows build, one useful PowerShell check is:

```powershell
Get-PnpDevice -Class ComputeAccelerator
```

The device we wanted to see was:

```text
Snapdragon(R) X Elite - X1E80100 - Qualcomm(R) Hexagon(TM) NPU
```

The upstream Windows notes also call out Device Manager's Neural Processors
section. If no Qualcomm Hexagon NPU appears anywhere, do not debug llama.cpp
yet. Fix the driver first.

## Why Signing Matters On Windows

The Hexagon backend needs HTP ops libraries such as:

```text
libggml-htp-v73.so
```

On Windows, these HTP-side libraries need to be included in a catalog file:

```text
libggml-htp.cat
```

That catalog must be signed with a trusted certificate. This is specific to the
Hexagon NPU path. The Adreno OpenCL backend does not require this test-signing
flow.

The upstream flow is:

1. Enable Windows test-signing.
2. Reboot.
3. Create a personal certificate.
4. Import it into Trusted Root Certification Authorities.
5. Import it into Trusted Publishers.
6. Build/install llama.cpp so the HTP catalog is generated and signed.
7. Verify the catalog with `signtool`.

Enable test-signing:

```powershell
bcdedit /set TESTSIGNING ON
```

After reboot:

```powershell
bcdedit /enum
```

You want:

```text
testsigning             Yes
```

Create the certificate with Windows SDK tools:

```powershell
cd C:\Users\Admin
mkdir Certs
cd Certs

makecert -r -pe -ss PrivateCertStore -n CN=GGML.HTP.v1 -eku 1.3.6.1.5.5.7.3.3 -sv ggml-htp-v1.pvk ggml-htp-v1.cer
pvk2pfx.exe -pvk ggml-htp-v1.pvk -spc ggml-htp-v1.cer -pfx ggml-htp-v1.pfx
```

Then import the resulting certificate into:

```text
Trusted Root Certification Authorities
Trusted Publishers
```

After the build, verify:

```powershell
signtool.exe verify /v /pa .\pkg-snapdragon\lib\libggml-htp.cat
```

You want:

```text
Successfully verified: .\pkg-snapdragon\lib\libggml-htp.cat
```

If this piece is wrong, the backend can build but the runtime will fail when it
tries to load HTP ops.

## Building llama.cpp With CPU, OpenCL, And Hexagon

The Snapdragon backend guide uses CMake presets.

For Windows on Snapdragon, start from a native ARM64 PowerShell session. That
detail matters. If you build from an x64 emulated shell, you are inviting weird
toolchain behavior.

Set the Qualcomm and signing environment:

```powershell
$env:OPENCL_SDK_ROOT="C:\Qualcomm\OpenCL_SDK\2.3.2"
$env:HEXAGON_SDK_ROOT="C:\Qualcomm\Hexagon_SDK\6.6.0.0"
$env:HEXAGON_TOOLS_ROOT="C:\Qualcomm\Hexagon_SDK\6.6.0.0\tools\HEXAGON_Tools\19.0.07"
$env:HEXAGON_HTP_CERT="C:\Users\Admin\Certs\ggml-htp-v1.pfx"
$env:WINDOWS_SDK_BIN="C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0"
```

Copy the Snapdragon CMake user presets:

```powershell
Copy-Item docs\backend\snapdragon\CMakeUserPresets.json .
```

Configure:

```powershell
cmake --preset arm64-windows-snapdragon-release -B build-wos
```

Build:

```powershell
cmake --build build-wos --config Release
```

Install into a portable package folder:

```powershell
cmake --install build-wos --prefix pkg-snapdragon
```

The installed package should contain files like:

```text
pkg-snapdragon\bin\llama-server.exe
pkg-snapdragon\bin\llama-cli.exe
pkg-snapdragon\bin\ggml-hexagon.dll
pkg-snapdragon\lib\libggml-htp-v73.so
pkg-snapdragon\lib\libggml-htp.cat
```

This package is what we run from the browser chat example.

## Sanity Testing The Hexagon Backend

Before involving Gemma, the server, or a browser UI, test the backend directly.

The upstream guide shows `test-backend-ops` for `MUL_MAT`. On Windows, run:

```powershell
$env:Path = "C:\Users\Admin\Documents\llamacpp\pkg-snapdragon\bin;$env:Path"
$env:ADSP_LIBRARY_PATH = "C:\Users\Admin\Documents\llamacpp\pkg-snapdragon\lib"

.\pkg-snapdragon\bin\test-backend-ops.exe -b HTP0 -o MUL_MAT
```

Useful signs:

```text
Backend 2/3: HTP0
Device description: Hexagon
MUL_MAT(...): OK
```

This matters because language model failures can be caused by model format,
prompt template, server options, or frontend parsing. Backend op tests remove
most of that noise.

## Downloading Gemma 4 E2B GGUF

The official Gemma llama.cpp integration points to:

```text
ggml-org/gemma-4-E2B-it-GGUF
```

At the time of this test, the repo exposed:

```text
gemma-4-E2B-it-Q8_0.gguf
gemma-4-E2B-it-bf16.gguf
mmproj-gemma-4-E2B-it-Q8_0.gguf
mmproj-gemma-4-E2B-it-bf16.gguf
```

For this text-only test, we used:

```text
gemma-4-E2B-it-Q8_0.gguf
```

The file is large:

```text
4,967,494,592 bytes
about 4.63 GiB
```

Create a model directory:

```powershell
mkdir gguf
```

Download:

```powershell
curl.exe -L --fail --progress-bar `
  -o gguf\gemma-4-E2B-it-Q8_0.gguf `
  "https://huggingface.co/ggml-org/gemma-4-E2B-it-GGUF/resolve/main/gemma-4-E2B-it-Q8_0.gguf?download=true"
```

Why not use `llama-cli -hf`?

Because this local build had Hugging Face flags, but not HTTPS support in the
internal downloader. A build with OpenSSL, BoringSSL, or LibreSSL enabled should
be able to use the simpler `-hf` path.

## First Direct CLI Test

Before starting a server, run the model once through `llama-cli`.

```powershell
$env:Path = "C:\Users\Admin\Documents\llamacpp\pkg-snapdragon\bin;$env:Path"
$env:ADSP_LIBRARY_PATH = "C:\Users\Admin\Documents\llamacpp\pkg-snapdragon\lib"

.\pkg-snapdragon\bin\llama-cli.exe `
  -m .\gguf\gemma-4-E2B-it-Q8_0.gguf `
  --device HTP0 `
  -ngl 99 `
  --no-mmap `
  --ctx-size 1024 `
  -n 32 `
  -p "Write one short sentence confirming Gemma is running."
```

This verified that the model could load and begin generating on the same
Snapdragon package.

In our run, Gemma loaded and generated, but slowly. That was expected. This is a
4.63 GiB Q8 model running through an experimental Hexagon backend, not a tiny
Q4 smoke-test model.

## Starting A Local Browser Chat UI

The repository for this example contains a tiny browser frontend:

```text
npu-chat\index.html
npu-chat\styles.css
npu-chat\app.js
```

There is no framework. There is no cloud service. The page is served by
`llama-server` itself.

The launcher:

```text
start-npu-chat.ps1
```

sets the runtime paths and starts:

```powershell
.\pkg-snapdragon\bin\llama-server.exe `
  -m .\gguf\gemma-4-E2B-it-Q8_0.gguf `
  -a snapdragon-npu `
  --host 127.0.0.1 `
  --port 8080 `
  --path .\npu-chat `
  --no-mmap `
  --poll 1000 `
  -t 6 `
  --ctx-size 1024 `
  --ubatch-size 128 `
  -fa on `
  -ngl 99 `
  --device HTP0
```

The short version:

```powershell
.\start-npu-chat.ps1 -Model "gemma-4-E2B-it-Q8_0.gguf"
```

Then open:

```text
http://127.0.0.1:8080/
```

The same `llama-server` process now serves both:

```text
http://127.0.0.1:8080/
http://127.0.0.1:8080/v1/chat/completions
```

That keeps the example simple. The browser UI and inference API are same-origin,
so there is no CORS dance and no separate dev server.

## The OpenAI-Compatible Streaming Request

The frontend sends:

```json
{
  "model": "snapdragon-npu",
  "messages": [
    {
      "role": "user",
      "content": "Say exactly: Gemma is running."
    }
  ],
  "stream": true,
  "temperature": 0.2,
  "max_tokens": 24,
  "cache_prompt": false
}
```

The browser reads the response as server-sent event chunks:

```text
data: {"choices":[{"delta":{"content":"G"}}], ...}
data: {"choices":[{"delta":{"content":"emma"}}], ...}
data: {"choices":[{"delta":{"content":" is"}}], ...}
data: {"choices":[{"delta":{"content":" running"}}], ...}
data: {"choices":[{"delta":{"content":"."}}], ...}
data: [DONE]
```

Rendered as:

```text
Gemma is running.
```

## The Gemma-Specific Streaming Surprise

Gemma 4 can emit reasoning chunks before normal answer chunks.

For some prompts, the server streamed:

```json
{
  "choices": [
    {
      "delta": {
        "reasoning_content": "Thinking"
      }
    }
  ]
}
```

The original frontend only looked for:

```js
delta.content
```

That made some Gemma generations look blank even though the server was sending
tokens.

The fix was to read both fields:

```js
function readDelta(payload) {
  const choice = payload?.choices?.[0];
  return choice?.delta?.content
    ?? choice?.delta?.reasoning_content
    ?? choice?.message?.content
    ?? payload?.content
    ?? "";
}
```

And for non-stream fallback responses:

```js
function readMessage(payload) {
  const choice = payload?.choices?.[0];
  return choice?.message?.content
    ?? choice?.message?.reasoning_content
    ?? choice?.text
    ?? payload?.content
    ?? "";
}
```

This is one of those tiny frontend details that saves a lot of debugging time.

The model is running. The NPU is selected. The server is streaming. But the UI
looks empty because the model is using a different stream field.

That is a very on-device-AI kind of bug.

## Proving The NPU Path

After starting the server, inspect:

```powershell
.\logs\npu-chat-server.err.log
```

Useful command:

```powershell
Select-String .\logs\npu-chat-server.err.log `
  -Pattern "HTP0|Hexagon|loading model|prompt eval time|eval time|server is listening"
```

For the Gemma run, the important lines were:

```text
HTP0    : Hexagon
loading model 'C:\Users\Admin\Documents\llamacpp\gguf\gemma-4-E2B-it-Q8_0.gguf'
server is listening on http://127.0.0.1:8080
```

And after requests:

```text
prompt eval time = 1154.47 ms / 23 tokens
eval time        = 1470.63 ms / 6 tokens
```

The direct server `/props` endpoint also confirmed the model:

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:8080/props |
  Select-Object model_alias, model_path, build_info
```

Output:

```text
model_alias: snapdragon-npu
model_path : C:\Users\Admin\Documents\llamacpp\gguf\gemma-4-E2B-it-Q8_0.gguf
build_info : b1-a3900a6
```

For lower-level backend proof, keep using:

```powershell
.\pkg-snapdragon\bin\test-backend-ops.exe -b HTP0 -o MUL_MAT
```

If `MUL_MAT` fails on `HTP0`, fix the Hexagon backend before blaming Gemma.

## Performance Notes

Gemma 4 E2B Q8_0 worked, but it was not fast.

Observed on the tested Snapdragon X Elite machine:

```text
prompt eval: about 20 tokens/sec
generation: about 4 tokens/sec
```

A short server request reported:

```text
prompt eval time = 1154.47 ms / 23 tokens
eval time        = 1470.63 ms / 6 tokens
```

This is significantly slower than the smaller Qwen2.5 0.5B Q4_0 model we used
as the default in the example repo.

That is not surprising:

- Gemma E2B Q8_0 is about 4.63 GiB.
- Qwen2.5 0.5B Q4_0 is about 409 MiB.
- Q8_0 moves much more data than Q4_0.
- The Hexagon backend is still experimental.
- Unsupported or control-heavy pieces can still involve CPU-side work.

The conclusion is not "Gemma is bad."

The conclusion is that model size, quantization, backend support, and prompt
behavior all matter. For a fast demo, Qwen 0.5B Q4 is much more pleasant. For
testing the official Gemma llama.cpp path, Gemma 4 E2B Q8_0 is the right target.

## Troubleshooting Checklist

If the server does not start:

```powershell
Get-NetTCPConnection -LocalPort 8080 -State Listen
```

If another server is already running:

```powershell
Stop-Process -Id <PID> -Force
```

If llama.cpp cannot find HTP libraries:

```powershell
$env:ADSP_LIBRARY_PATH = "C:\Users\Admin\Documents\llamacpp\pkg-snapdragon\lib"
```

If the NPU is missing:

```powershell
Get-PnpDevice -Class ComputeAccelerator
```

If signing looks suspicious:

```powershell
signtool.exe verify /v /pa .\pkg-snapdragon\lib\libggml-htp.cat
```

If the browser shows no text:

Check whether the stream contains:

```text
reasoning_content
```

If it does, update the parser to read that field.

If `-hf` fails:

Your llama.cpp build may not include HTTPS support. Download the model with
`curl.exe` and pass `-m` a local GGUF path.

## What I Would Improve Next

The current example is intentionally simple.

But there are a few obvious next steps:

1. Add a separate "thinking" panel for `reasoning_content`.
2. Add a model selector in the browser UI.
3. Add a backend selector for `CPU`, `GPUOpenCL`, and `HTP0`.
4. Add a startup log parser that displays whether HTP was detected.
5. Rebuild llama.cpp with HTTPS support so `-hf` works directly.
6. Try a smaller Gemma quantization if one becomes available in the official
   GGUF repo.

The most useful improvement would be separating reasoning from answer text.

Dumping thinking tokens directly into the chat transcript works for debugging,
but it is not the best user experience. A collapsible "Thinking" panel would
make Gemma-style models feel much cleaner.

## Final Thoughts

The hardware is ready enough to be interesting.

The software stack is ready enough to be useful.

But the developer experience still asks you to understand the layers.

Running Gemma 4 E2B on Snapdragon with llama.cpp is not just:

```bash
llama-server -hf ggml-org/gemma-4-E2B-it-GGUF
```

At least not on every Windows ARM64 build yet.

In practice, the workflow is:

1. Build llama.cpp with CPU, OpenCL, and Hexagon backends.
2. Install Qualcomm SDKs and drivers.
3. Enable and verify HTP catalog signing.
4. Confirm `HTP0` is visible.
5. Confirm backend ops pass.
6. Download the Gemma GGUF.
7. Launch `llama-server` with `--device HTP0 -ngl 99`.
8. Stream through `/v1/chat/completions`.
9. Parse both `content` and `reasoning_content`.
10. Watch the logs.

That sounds like a lot.

But once it works, it becomes a real local development loop. You can swap
models, test prompts, watch token timing, inspect backend logs, and iterate from
a browser without touching a cloud API.

That is the part that feels different.

Not just that Gemma runs locally.

That you can understand the whole path from a browser textbox to the Hexagon
NPU.

## References

- Google AI for Developers: Run Gemma with llama.cpp:
  <https://ai.google.dev/gemma/docs/integrations/llamacpp>
- llama.cpp Snapdragon backend guide:
  <https://github.com/ggml-org/llama.cpp/blob/master/docs/backend/snapdragon/README.md>
- llama.cpp Snapdragon Windows notes:
  <https://github.com/ggml-org/llama.cpp/blob/master/docs/backend/snapdragon/windows.md>
- Example repository:
  <https://github.com/shivaylamba/llama.cpp-snapdragon-npu-example>
