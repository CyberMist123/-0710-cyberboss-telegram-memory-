const fs = require("fs");
function runToolMcpServer({ toolHost, runtimeId = "", workspaceRoot = "" }) {
  const reader = createMessageReader(process.stdin);
  const toolCatalog = toolHost.listTools();
  const resources = buildToolResources(toolCatalog);

  reader.onMessage(async (message) => {
    if (!message || typeof message !== "object") {
      return;
    }
    const id = message.id;
    const method = typeof message.method === "string" ? message.method : "";
    const params = message.params || {};

    try {
      if (method === "initialize") {
        writeRpcResponse(id, {
          protocolVersion: params.protocolVersion || "2024-11-05",
          capabilities: {
            tools: {
              listChanged: false,
            },
            prompts: {
              listChanged: false,
            },
            resources: {
              listChanged: false,
            },
          },
          serverInfo: {
            name: "cyberboss-tools",
            version: "0.1.0",
          },
        }, reader.getMode());
        return;
      }

      if (method === "notifications/initialized") {
        return;
      }

      if (method === "ping") {
        writeRpcResponse(id, {}, reader.getMode());
        return;
      }

      if (method === "tools/list") {
        writeRpcResponse(id, {
          tools: toolHost.listTools(),
        }, reader.getMode());
        return;
      }

      if (method === "resources/list") {
        writeRpcResponse(id, {
          resources: resources.map((resource) => ({
            uri: resource.uri,
            name: resource.name,
            description: resource.description,
            mimeType: resource.mimeType,
          })),
        }, reader.getMode());
        return;
      }

      if (method === "resources/read") {
        const uri = typeof params.uri === "string" ? params.uri.trim() : "";
        const resource = resources.find((entry) => entry.uri === uri);
        if (!resource) {
          writeRpcError(id, -32602, `Unknown resource: ${uri}`, reader.getMode());
          return;
        }
        writeRpcResponse(id, {
          contents: [
            {
              uri: resource.uri,
              mimeType: resource.mimeType,
              text: resource.text,
            },
          ],
        }, reader.getMode());
        return;
      }

      if (method === "prompts/list") {
        writeRpcResponse(id, {
          prompts: [],
        }, reader.getMode());
        return;
      }

      if (method === "tools/call") {
        const toolName = typeof params.name === "string" ? params.name : "";
        const args = params.arguments && typeof params.arguments === "object"
          ? params.arguments
          : {};
        const result = await toolHost.invokeTool(toolName, args, {
          runtimeId,
          workspaceRoot,
        });
        writeRpcResponse(id, {
          content: [
            {
              type: "text",
              text: formatToolResult(result),
            },
          ],
        }, reader.getMode());
        return;
      }

      writeRpcError(id, -32601, `Method not found: ${method}`, reader.getMode());
    } catch (error) {
      writeRpcResponse(id, {
        content: [
          {
            type: "text",
            text: error instanceof Error ? error.message : String(error || "unknown error"),
          },
        ],
        isError: true,
      }, reader.getMode());
    }
  });
}

function formatToolResult(result) {
  if (!result || typeof result !== "object") {
    return String(result || "");
  }
  if (result.text && result.data) {
    return `${result.text}\n${JSON.stringify(result.data, null, 2)}`;
  }
  if (result.text) {
    return String(result.text);
  }
  return JSON.stringify(result, null, 2);
}

function buildToolResources(toolCatalog) {
  const tools = Array.isArray(toolCatalog) ? toolCatalog : [];
  const resources = [];
  resources.push({
    uri: "cyberboss://tools/index",
    name: "Cyberboss Tool Index",
    description: "Overview of Cyberboss project tools with schemas and usage notes.",
    mimeType: "text/markdown",
    text: buildToolIndexMarkdown(tools),
  });
  resources.push({
    uri: "cyberboss://docs/sleep-mode",
    name: "Cyberboss Sleep Mode",
    description: "Sleep mode rules and examples for check-in polling.",
    mimeType: "text/markdown",
    text: buildSleepModeMarkdown(),
  });
  resources.push({
    uri: "cyberboss://docs/telegram-send",
    name: "Cyberboss Telegram Send",
    description: "When to call the Telegram send tool and a short example.",
    mimeType: "text/markdown",
    text: buildTelegramSendMarkdown(),
  });
  resources.push({
    uri: "cyberboss://docs/telegram-send-file",
    name: "Cyberboss Telegram Send File",
    description: "When to call the Telegram file send tool and a short example.",
    mimeType: "text/markdown",
    text: buildTelegramSendFileMarkdown(),
  });
  resources.push({
    uri: "cyberboss://docs/telegram-send-voice",
    name: "Cyberboss Telegram Send Voice",
    description: "When to send a synthesized voice reply to Telegram and a short example.",
    mimeType: "text/markdown",
    text: buildTelegramSendVoiceMarkdown(),
  });
  resources.push({
    uri: "cyberboss://docs/weather",
    name: "Cyberboss Weather",
    description: "When to call the weather tool, what it reads, and example commands.",
    mimeType: "text/markdown",
    text: buildWeatherMarkdown(),
  });
  for (const tool of tools) {
    resources.push({
      uri: `cyberboss://tools/${tool.name}`,
      name: `${tool.name} schema`,
      description: `Detailed schema and usage guidance for ${tool.name}.`,
      mimeType: "text/markdown",
      text: buildToolMarkdown(tool),
    });
  }
  return resources;
}

function buildToolIndexMarkdown(tools) {
  const lines = [
    "# Cyberboss Project Tools",
    "",
    "These are Cyberboss project tools.",
    "Descriptions are short call criteria. Read the docs resources for examples, edge cases, and format rules.",
    "",
  ];
  for (const tool of tools) {
    lines.push(`## ${tool.name}`);
    lines.push("");
    lines.push(tool.description || "");
    lines.push("");
    lines.push("Schema:");
    lines.push("```json");
    lines.push(JSON.stringify(tool.inputSchema || {}, null, 2));
    lines.push("```");
    lines.push("");
  }
  return lines.join("\n").trim() + "\n";
}


function buildSleepModeMarkdown() {
  return [
    "# Cyberboss Sleep Mode",
    "",
    "Sleep mode switches the check-in poller into a long-interval state when the user says they are going to sleep or the local time is between 22:00 and 06:30 Asia/Shanghai.",
    "",
    "## When to switch to sleep mode",
    "",
    "- The user says sleep-related phrases such as 晚安, 睡了, 去睡了, good night, or going to bed.",
    "- The local time in Asia/Shanghai is between 22:00 and 06:30.",
    "",
    "## When to switch back",
    "",
    "- Any non-sleep message from the user restores awake mode immediately.",
    "",
    "## Polling behavior",
    "",
    "- Normal mode uses the configured check-in interval range.",
    "- Sleep mode uses a long interval range so the user is not interrupted frequently.",
    "- The poller restores awake mode once a wake signal is detected.",
    "",
    "## Tool entrypoint",
    "",
    "- Use cyberboss_sleep_mode when you need to enable, disable, or inspect the current sleep state.",
    "",
    "## Examples",
    "",
    "- User says 晚安: switch to sleep mode and persist the state fields sleeping=true and sleepStateChangedAt.",
    "- Any non-sleep message: switch back to awake mode.",
  ].join("\n");
}

function buildTelegramSendMarkdown() {
  return [
    "# Cyberboss Telegram Send",
    "",
    "Do not use cyberboss_telegram_send for the normal reply to a Telegram inbound turn.",
    "Cyberboss already delivers the normal assistant reply back to Telegram automatically.",
    "Use cyberboss_telegram_send only for an extra out-of-band Telegram message that is separate from the normal reply.",
    "",
    "## When to call",
    "",
    "- Call it for Telegram-only follow-ups, clarifications, or private messages that must be sent in addition to the normal reply.",
    "- Do not call it just because the inbound turn came from Telegram.",
    "- Do not call it for ordinary WeChat check-ins, reminders, or normal outbound messages.",
    "- Use the optional userId only when you need to override the default Telegram target.",
    "",
    "## Example",
    "",
    "```json",
    "{",
    "  \"text\": \"我看到了，稍后回你。\"",
    "}",
    "```",
  ].join("\n");
}

function buildWeatherMarkdown() {
  return [
    "# Cyberboss Weather",
    "",
    "Use the weather tool when you need the configured local weather and must not use GPS, IP lookup, or chat messages.",
    "",
    "## Query source",
    "",
    "- First use CYBERBOSS_WEATHER_ADCODE when configured.",
    "- Otherwise use CYBERBOSS_WEATHER_CITY.",
    "- CYBERBOSS_WEATHER_ADDRESS is only a note in v1 and does not affect the request.",
    "",
    "## Provider",
    "",
    "- Provider: Amap weather API.",
    "- Request mode: extensions=all, output=JSON.",
    "- The request city parameter is filled with the configured adcode or city value.",
    "",
    "## Commands",
    "",
    "- current: return a normalized current weather and today forecast summary.",
    "- raw: return the raw Amap weather payload for debugging.",
    "",
    "## What this tool never does",
    "",
    "- No GPS or real-time device location.",
    "- No IP-based location.",
    "- No WeChat message access.",
    "",
    "## Example",
    "",
    "```json",
    "{",
    "  \"command\": \"current\"",
    "}",
    "```",
    "",
    "```json",
    "{",
    "  \"command\": \"raw\"",
    "}",
    "```",
  ].join("\n");
}


function buildTelegramSendFileMarkdown() {
  return [
    "# Cyberboss Telegram Send File",
    "",
    "Use cyberboss_telegram_send_file only when you want to send an existing local file to Telegram instead of WeChat.",
    "",
    "## When to call",
    "",
    "- Call it for Telegram-only attachments, private follow-ups, or explicit file deliveries that should stay off WeChat.",
    "- Do not call it for normal WeChat file replies or check-ins.",
    "- Use userId only when you need to override the default Telegram target.",
    "",
    "## Example",
    "",
    "```json",
    "{",
    "  \"filePath\": \"<WORKSPACE>/tmp/reward.pdf\"",
    "}",
    "```",
  ].join("\n");
}

function buildTelegramSendVoiceMarkdown() {
  return [
    "# Cyberboss Telegram Send Voice",
    "",
    "Use cyberboss_telegram_send_voice to speak a reply as a Telegram voice bubble instead of text.",
    "The system synthesizes the given text with the configured TTS voice and sends it; the spoken text is saved to the conversation log automatically.",
    "",
    "## When to call",
    "",
    "- The user sent a voice message and a spoken reply feels natural.",
    "- Emotional or intimate moments where hearing a voice matters more than reading text.",
    "- Keep the text short, natural spoken language; avoid markdown, lists, or long paragraphs.",
    "- If the tool reports TTS is not configured, fall back to a normal text reply.",
    "",
    "## Example",
    "",
    "```json",
    "{",
    "  \"text\": \"我在呢，刚听完你的语音，抱一下。\"",
    "}",
    "```",
  ].join("\n");
}

function buildToolMarkdown(tool) {
  const lines = [
    `# ${tool.name}`,
    "",
    tool.description || "",
    "",
    "Input schema:",
    "```json",
    JSON.stringify(tool.inputSchema || {}, null, 2),
    "```",
    "",
  ];
  return lines.join("\n");
}

function createMessageReader(stream) {
  let buffer = Buffer.alloc(0);
  const listeners = new Set();
  let mode = "content-length";

  stream.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    while (true) {
      const headerEnd = findHeaderBoundary(buffer);
      if (headerEnd >= 0) {
        mode = "content-length";
        const separatorLength = buffer[headerEnd] === 13 ? 4 : 2;
        const headerText = buffer.slice(0, headerEnd).toString("utf8");
        const lengthMatch = headerText.match(/Content-Length:\s*(\d+)/i);
        if (!lengthMatch) {
          buffer = Buffer.alloc(0);
          return;
        }
        const contentLength = Number.parseInt(lengthMatch[1], 10);
        const bodyStart = headerEnd + separatorLength;
        if (buffer.length < bodyStart + contentLength) {
          return;
        }
        const body = buffer.slice(bodyStart, bodyStart + contentLength).toString("utf8");
        buffer = buffer.slice(bodyStart + contentLength);
        emitParsedMessage(body, listeners);
        continue;
      }

      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const line = buffer.slice(0, newlineIndex).toString("utf8").trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }
      mode = "jsonl";
      emitParsedMessage(line, listeners);
    }
  });

  return {
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getMode() {
      return mode;
    },
  };
}

function emitParsedMessage(body, listeners) {
  let parsed = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    return;
  }
  for (const listener of listeners) {
    listener(parsed);
  }
}

function findHeaderBoundary(buffer) {
  const crlf = buffer.indexOf("\r\n\r\n");
  if (crlf >= 0) {
    return crlf;
  }
  return buffer.indexOf("\n\n");
}

function writeRpcResponse(id, result, mode = "content-length") {
  writeMessage({
    jsonrpc: "2.0",
    id,
    result,
  }, mode);
}

function writeRpcError(id, code, message, mode = "content-length") {
  writeMessage({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  }, mode);
}

function writeMessage(payload, mode = "content-length") {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  if (mode === "jsonl") {
    fs.writeSync(process.stdout.fd, Buffer.concat([body, Buffer.from("\n", "utf8")]));
    return;
  }
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
  fs.writeSync(process.stdout.fd, Buffer.concat([header, body]));
}

module.exports = { runToolMcpServer };
