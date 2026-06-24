const messagesEl = document.querySelector("#messages");
const formEl = document.querySelector("#chatForm");
const promptEl = document.querySelector("#prompt");
const sendButton = document.querySelector("#sendButton");
const stopButton = document.querySelector("#stopButton");
const clearButton = document.querySelector("#clearButton");
const serverStatus = document.querySelector("#serverStatus");
const modelName = document.querySelector("#modelName");
const modelFile = document.querySelector("#modelFile");
const streamState = document.querySelector("#streamState");
const temperature = document.querySelector("#temperature");
const temperatureValue = document.querySelector("#temperatureValue");
const maxTokens = document.querySelector("#maxTokens");
const proofServer = document.querySelector("#proofServer");
const proofHealth = document.querySelector("#proofHealth");
const modelSelector = document.querySelector("#modelSelector");
const modelCommand = document.querySelector("#modelCommand");
const copyModelCommand = document.querySelector("#copyModelCommand");

const chat = [
  {
    role: "system",
    content: "You are a concise assistant running locally through llama.cpp. Always answer with plain text."
  }
];

let abortController = null;
let currentModelPath = "";

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

function appendAssistantMessage() {
  const message = document.createElement("div");
  message.className = "message assistant";

  const body = document.createElement("div");
  body.className = "message-body";

  const thinking = document.createElement("details");
  thinking.className = "thinking-panel";
  thinking.hidden = true;

  const summary = document.createElement("summary");
  summary.textContent = "Thinking";

  const thinkingText = document.createElement("div");
  thinkingText.className = "thinking-text";

  thinking.append(summary, thinkingText);
  message.append(body, thinking);
  messagesEl.appendChild(message);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  return { message, body, thinking, thinkingText };
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

function readDeltaParts(payload) {
  const choice = payload?.choices?.[0];
  return {
    content: choice?.delta?.content ?? choice?.message?.content ?? payload?.content ?? "",
    reasoning: choice?.delta?.reasoning_content ?? choice?.message?.reasoning_content ?? ""
  };
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

function readMessageParts(payload) {
  const choice = payload?.choices?.[0];
  return {
    content: choice?.message?.content ?? choice?.text ?? payload?.content ?? "",
    reasoning: choice?.message?.reasoning_content ?? ""
  };
}

function filenameFromPath(path) {
  return (path || "").split(/[\\/]/).filter(Boolean).pop() || "";
}

function updateModelCommand() {
  const selected = modelSelector.value;
  const port = new URL(window.location.href).port || "8080";
  modelCommand.value = `.\\start-npu-chat.ps1 -Model "${selected}" -Port ${port}`;
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
    const filename = filenameFromPath(props.model_path);

    modelName.textContent = alias;
    modelFile.textContent = filename || "Unknown";
    currentModelPath = props.model_path || "";
    if (filename && [...modelSelector.options].some((option) => option.value === filename)) {
      modelSelector.value = filename;
    }
    updateModelCommand();
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

  const assistantMessage = appendAssistantMessage();
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
    let thinkingText = "";

    function applyDelta(parts) {
      if (parts.reasoning) {
        thinkingText += parts.reasoning;
        assistantMessage.thinking.hidden = false;
        assistantMessage.thinkingText.textContent = thinkingText;
      }

      if (parts.content) {
        fullText += parts.content;
        assistantMessage.body.textContent = fullText;
      }

      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      buffer = parseChunk(buffer, (payload) => {
        applyDelta(readDeltaParts(payload));
      });
    }

    if (buffer.trim()) {
      parseChunk(`${buffer}\n\n`, (payload) => {
        applyDelta(readDeltaParts(payload));
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
        const retryParts = readMessageParts(retryPayload);
        fullText = retryParts.content;
        if (retryParts.reasoning) {
          thinkingText += retryParts.reasoning;
          assistantMessage.thinking.hidden = false;
          assistantMessage.thinkingText.textContent = thinkingText;
        }
        assistantMessage.body.textContent = fullText || "(Model ended without final text. Check Thinking or clear chat and try again.)";
      } else {
        assistantMessage.body.textContent = "(Model ended without final text. Check Thinking or clear chat and try again.)";
      }
    }

    if (fullText.trim()) {
      chat.push({ role: "assistant", content: fullText });
    }
  } catch (error) {
    const stopped = error?.name === "AbortError";
    assistantMessage.body.textContent = stopped ? "(Stopped.)" : `Request failed: ${error.message}`;
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

modelSelector.addEventListener("change", updateModelCommand);

copyModelCommand.addEventListener("click", async () => {
  modelCommand.select();
  try {
    await navigator.clipboard.writeText(modelCommand.value);
    copyModelCommand.textContent = "Copied";
  } catch {
    document.execCommand("copy");
    copyModelCommand.textContent = "Copied";
  }

  setTimeout(() => {
    copyModelCommand.textContent = "Copy Command";
  }, 1200);
});

appendMessage("system", "Ready for a local NPU-backed chat request.");
updateModelCommand();
refreshServerState();
setInterval(refreshServerState, 15000);
