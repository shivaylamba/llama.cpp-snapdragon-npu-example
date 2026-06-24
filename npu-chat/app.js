const messagesEl = document.querySelector("#messages");
const formEl = document.querySelector("#chatForm");
const promptEl = document.querySelector("#prompt");
const sendButton = document.querySelector("#sendButton");
const stopButton = document.querySelector("#stopButton");
const clearButton = document.querySelector("#clearButton");
const serverStatus = document.querySelector("#serverStatus");
const modelName = document.querySelector("#modelName");
const streamState = document.querySelector("#streamState");
const temperature = document.querySelector("#temperature");
const temperatureValue = document.querySelector("#temperatureValue");
const maxTokens = document.querySelector("#maxTokens");
const proofServer = document.querySelector("#proofServer");
const proofHealth = document.querySelector("#proofHealth");

const chat = [
  {
    role: "system",
    content: "You are a concise assistant running locally through llama.cpp. Always answer with plain text."
  }
];

let abortController = null;

function setStatus(text, state) {
  serverStatus.textContent = text;
  serverStatus.dataset.state = state;
}

function appendMessage(role, content) {
  const message = document.createElement("div");
  message.className = `message ${role}`;
  message.textContent = content;
  messagesEl.appendChild(message);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return message;
}

function setBusy(isBusy) {
  sendButton.disabled = isBusy;
  stopButton.disabled = !isBusy;
  promptEl.disabled = isBusy;
  streamState.textContent = isBusy ? "Receiving tokens" : "Idle";
}

function parseChunk(buffer, onData) {
  const events = buffer.split("\n\n");
  const rest = events.pop() ?? "";

  for (const event of events) {
    for (const line of event.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) {
        continue;
      }

      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") {
        continue;
      }

      try {
        onData(JSON.parse(payload));
      } catch {
        // Ignore partial or non-JSON server messages in the SSE stream.
      }
    }
  }

  return rest;
}

function readDelta(payload) {
  const choice = payload?.choices?.[0];
  return choice?.delta?.content ?? choice?.delta?.reasoning_content ?? choice?.message?.content ?? payload?.content ?? "";
}

function buildRequest(stream) {
  return {
    model: modelName.textContent || "snapdragon-npu",
    messages: chat,
    stream,
    temperature: Number(temperature.value),
    max_tokens: Number(maxTokens.value),
    cache_prompt: false
  };
}

function readMessage(payload) {
  const choice = payload?.choices?.[0];
  return choice?.message?.content ?? choice?.message?.reasoning_content ?? choice?.text ?? payload?.content ?? "";
}

async function refreshServerState() {
  try {
    const [healthRes, propsRes] = await Promise.all([
      fetch("/health", { cache: "no-store" }),
      fetch("/props", { cache: "no-store" })
    ]);

    if (!healthRes.ok) {
      throw new Error(`health ${healthRes.status}`);
    }

    const health = await healthRes.json().catch(() => ({}));
    const props = await propsRes.json().catch(() => ({}));
    const alias = props.model_alias || props.default_generation_settings?.model || "snapdragon-npu";

    modelName.textContent = alias;
    proofServer.classList.add("ok");
    proofHealth.classList.add("ok");
    proofHealth.textContent = `Health endpoint ${health.status || "ready"}`;
    setStatus("Server ready", "ready");
  } catch {
    proofHealth.classList.remove("ok");
    proofHealth.textContent = "Health endpoint unavailable";
    setStatus("Server offline", "error");
  }
}

async function sendMessage(text) {
  appendMessage("user", text);
  chat.push({ role: "user", content: text });

  const assistantMessage = appendMessage("assistant", "");
  abortController = new AbortController();
  setBusy(true);

  try {
    const response = await fetch("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: abortController.signal,
      body: JSON.stringify(buildRequest(true))
    });

    if (!response.ok || !response.body) {
      throw new Error(`chat ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      buffer = parseChunk(buffer, (payload) => {
        const delta = readDelta(payload);
        if (delta) {
          fullText += delta;
          assistantMessage.textContent = fullText;
          messagesEl.scrollTop = messagesEl.scrollHeight;
        }
      });
    }

    if (buffer.trim()) {
      parseChunk(`${buffer}\n\n`, (payload) => {
        const delta = readDelta(payload);
        if (delta) {
          fullText += delta;
          assistantMessage.textContent = fullText;
        }
      });
    }

    if (!fullText.trim()) {
      const retry = await fetch("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortController.signal,
        body: JSON.stringify(buildRequest(false))
      });

      if (retry.ok) {
        const retryPayload = await retry.json();
        fullText = readMessage(retryPayload);
        assistantMessage.textContent = fullText || "(Model ended without text. Clear chat and try again.)";
      } else {
        assistantMessage.textContent = "(Model ended without text. Clear chat and try again.)";
      }
    }

    if (fullText.trim()) {
      chat.push({ role: "assistant", content: fullText });
    }
  } catch (error) {
    const stopped = error?.name === "AbortError";
    assistantMessage.textContent = stopped ? "(Stopped.)" : `Request failed: ${error.message}`;
  } finally {
    abortController = null;
    setBusy(false);
    promptEl.focus();
  }
}

temperature.addEventListener("input", () => {
  temperatureValue.textContent = Number(temperature.value).toFixed(2);
});

formEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = promptEl.value.trim();
  if (!text || abortController) {
    return;
  }

  promptEl.value = "";
  await sendMessage(text);
});

promptEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    formEl.requestSubmit();
  }
});

stopButton.addEventListener("click", () => {
  abortController?.abort();
});

clearButton.addEventListener("click", () => {
  chat.splice(1);
  messagesEl.replaceChildren();
  appendMessage("system", "Chat cleared.");
});

appendMessage("system", "Ready for a local NPU-backed chat request.");
refreshServerState();
setInterval(refreshServerState, 15000);
