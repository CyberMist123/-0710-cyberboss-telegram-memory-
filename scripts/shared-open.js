const { spawn } = require("child_process");
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const {
  listenUrl,
  ensureSharedAppServer,
  resolveBoundThread,
} = require("./shared-common");

async function main() {
  const workspaceRoot = process.env.CYBERBOSS_WORKSPACE_ROOT || process.cwd();
  const runtime = process.env.CYBERBOSS_RUNTIME || "codex";

  if (runtime === "codex") {
    await ensureSharedAppServer();
    const { threadId, workspaceRoot: resolvedWorkspaceRoot } = resolveBoundThread(workspaceRoot);
    const child = spawn(process.env.CYBERBOSS_CODEX_COMMAND || "codex", [
      "resume",
      threadId,
      "--remote",
      listenUrl,
      "-C",
      resolvedWorkspaceRoot,
      ...process.argv.slice(2),
    ], {
      stdio: "inherit",
      shell: process.platform === "win32",
    });

    child.on("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      process.exit(code ?? 0);
    });
    return;
  }

  // For Claude: connect to the bridge's IPC socket so we can observe and
  // interact with the same ClaudeCode process that handles channel messages.
  const stateDir = process.env.CYBERBOSS_STATE_DIR || path.join(os.homedir(), ".cyberboss");
  const socketPath = path.join(stateDir, "claudecode-runtime.sock");
  const endpointFile = path.join(stateDir, "claudecode-runtime.json");
  const tokenFile = path.join(stateDir, "claudecode-runtime.token");
  const endpoint = readClaudeIpcEndpoint({ endpointFile, socketPath, tokenFile });

  if (!endpoint) {
    console.error(`Claude IPC endpoint not found: ${endpointFile}`);
    console.error(`Legacy socket path also missing: ${socketPath}`);
    console.error("Make sure the bridge is running with CYBERBOSS_RUNTIME=claudecode.");
    process.exit(1);
  }

  const socket = endpoint.transport === "tcp"
    ? net.createConnection(endpoint.port, endpoint.host)
    : net.createConnection(endpoint.socketPath);
  socket.setEncoding("utf8");

  let connected = false;
  await new Promise((resolve, reject) => {
    socket.once("connect", () => {
      connected = true;
      resolve();
    });
    socket.once("error", (err) => reject(err));
    setTimeout(() => reject(new Error("connect timeout")), 3000);
  });

  console.log(`Connected to ClaudeCode bridge IPC (${formatEndpointLabel(endpoint)})`);
  console.log(`Observing workspace: ${workspaceRoot}`);
  console.log("Type your message and press Enter to send. Ctrl+C to exit.\n");

  // Authenticate with the IPC server
  let authToken = "";
  try {
    authToken = fs.readFileSync(endpoint.tokenFile, "utf8").trim();
  } catch {
    console.error(`Failed to read IPC auth token: ${endpoint.tokenFile}`);
    process.exit(1);
  }
  socket.write(JSON.stringify({ type: "auth", token: authToken }) + "\n");

  // Handle incoming events from the bridge
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        handleIpcMessage(msg);
      } catch {
        // ignore malformed
      }
    }
  });

  socket.on("close", () => {
    if (connected) {
      console.log("\n[IPC disconnected]");
      process.exit(0);
    }
  });

  socket.on("error", (err) => {
    console.error(`[IPC error] ${err.message}`);
    process.exit(1);
  });

  // Read user input from terminal
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "> ",
  });

  rl.prompt();

  rl.on("line", (line) => {
    const text = line.trim();
    if (!text) {
      rl.prompt();
      return;
    }
    if (pendingApproval && (text === "/yes" || text === "/always" || text === "/no")) {
      const approvalPayload = JSON.stringify({
        type: "respondApproval",
        workspaceRoot: pendingApproval.workspaceRoot || workspaceRoot,
        requestId: pendingApproval.requestId,
        decision: text === "/no" ? "decline" : "accept",
      }) + "\n";
      socket.write(approvalPayload);
      if (text === "/always") {
        console.log(`${c.gray}[shared-open]${c.reset} approved once; persistent auto-allow is only available from the chat side.\n`);
      }
      pendingApproval = null;
      rl.prompt();
      return;
    }
    const payload = JSON.stringify({
      type: "sendUserMessage",
      workspaceRoot,
      text,
    }) + "\n";
    socket.write(payload);
  });

  rl.on("close", () => {
    console.log("\n[Exiting]");
    socket.end();
    process.exit(0);
  });

  process.on("SIGINT", () => {
    rl.close();
  });
}

function readClaudeIpcEndpoint({ endpointFile, socketPath, tokenFile }) {
  try {
    const parsed = JSON.parse(fs.readFileSync(endpointFile, "utf8"));
    if (
      parsed
      && parsed.transport === "tcp"
      && typeof parsed.host === "string"
      && Number.isInteger(parsed.port)
      && parsed.port > 0
    ) {
      return {
        transport: "tcp",
        host: parsed.host,
        port: parsed.port,
        tokenFile: typeof parsed.tokenFile === "string" && parsed.tokenFile.trim()
          ? parsed.tokenFile
          : tokenFile,
      };
    }
  } catch {
    // ignore
  }

  if (fs.existsSync(socketPath)) {
    return {
      transport: "socket",
      socketPath,
      tokenFile: `${socketPath}.token`,
    };
  }
  return null;
}

function formatEndpointLabel(endpoint) {
  if (!endpoint) {
    return "(unknown)";
  }
  if (endpoint.transport === "tcp") {
    return `${endpoint.host}:${endpoint.port}`;
  }
  return endpoint.socketPath;
}

const c = {
  reset: "\x1b[0m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m",
  red: "\x1b[31m",
  green: "\x1b[32m",
};

let turnCount = 0;
let pendingApproval = null;

function handleIpcMessage(msg) {
  if (msg.type === "processEvent") {
    const event = msg.event;
    switch (event?.type) {
      case "turn.started":
        turnCount += 1;
        break;
      case "reply.completed":
        console.log(`\n${c.cyan}[ClaudeCode → Chat]${c.reset}\n${event.text}\n`);
        break;
      case "turn.completed":
        if (event.text) {
          console.log(`\n${c.cyan}[ClaudeCode → Chat]${c.reset}\n${event.text}\n`);
        }
        console.log(`${c.gray}─────────────────────────${c.reset}`);
        break;
      case "tool.use": {
        const inputStr = event.input
          ? JSON.stringify(event.input, null, 2)
          : "";
        console.log(`\n${c.yellow}● ${formatReadableToolName(event.toolName) || "Tool"}${c.reset}`);
        if (inputStr) {
          console.log(inputStr.split("\n").map((l) => `  ${l}`).join("\n"));
        }
        console.log("");
        break;
      }
      case "tool.result": {
        const status = event.isError
          ? `${c.red}ERROR${c.reset}`
          : `${c.green}OK${c.reset}`;
        const bulletColor = event.isError ? c.red : c.green;
        console.log(`\n  ${bulletColor}● ${status}${c.reset}`);
        if (event.toolResult) {
          console.log(event.toolResult.split("\n").map((l) => `    ${l}`).join("\n"));
        }
        console.log("");
        break;
      }
      case "thinking":
        console.log(`\n${c.gray}[Thinking]${c.reset}\n${event.text}\n`);
        break;
      case "approval.requested": {
        if (isProjectNativeToolApproval(event.toolName)) {
          break;
        }
        pendingApproval = {
          requestId: event.requestId,
          workspaceRoot: event.workspaceRoot || "",
        };
        const inputStr = event.input
          ? JSON.stringify(event.input, null, 2)
          : "";
        console.log(`\n${c.magenta}[Approval] ${formatReadableToolName(event.toolName) || ""}${c.reset}`);
        if (inputStr) console.log(inputStr);
        console.log(`${c.gray}─────────────────────────${c.reset}`);
        console.log(`Reply: ${c.green}/yes${c.reset}  ${c.yellow}/always${c.reset}  ${c.red}/no${c.reset}\n`);
        break;
      }
      case "process.error":
        console.log(`\n${c.red}[process error]${c.reset} ${event.error}\n`);
        break;
      case "process.close":
        console.log(`\n${c.red}[process closed]${c.reset} code=${event.code}\n`);
        break;
    }
  } else if (msg.type === "stderr") {
    console.log(`[stderr] ${msg.text}`);
  } else if (msg.type === "inboundMessage") {
    console.log(`\n${c.cyan}[Chat → ClaudeCode]${c.reset}\n${msg.text || ""}\n`);
  }
}

function formatReadableToolName(toolName) {
  const normalized = typeof toolName === "string" ? toolName.trim() : "";
  if (!normalized.startsWith("mcp__")) {
    return normalized;
  }
  const parts = normalized.split("__").filter(Boolean);
  if (parts.length < 3 || parts[0] !== "mcp") {
    return normalized;
  }
  return parts.slice(2).join("__") || normalized;
}

function isProjectNativeToolApproval(toolName) {
  const normalized = typeof toolName === "string" ? toolName.trim().toLowerCase() : "";
  return normalized.startsWith("mcp__cyberboss_tools__");
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
