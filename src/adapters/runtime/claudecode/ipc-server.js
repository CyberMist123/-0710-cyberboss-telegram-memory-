const net = require("net");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { EventEmitter } = require("events");

class ClaudeCodeIpcServer extends EventEmitter {
  constructor({ stateDir }) {
    super();
    this.stateDir = stateDir;
    this.endpointFile = path.join(stateDir, "claudecode-runtime.json");
    this.tokenFile = path.join(stateDir, "claudecode-runtime.token");
    this.authToken = "";
    this.server = null;
    this.startPromise = null;
    this.clients = new Set();
    this.authenticated = new Set();
    this.address = null;
  }

  async start() {
    if (this.server) {
      return;
    }
    if (this.startPromise) {
      await this.startPromise;
      return;
    }
    this.ensureDirectory();
    this.generateAuthToken();

    this.server = net.createServer((socket) => {
      this.clients.add(socket);
      socket.setEncoding("utf8");

      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (!this.authenticated.has(socket)) {
              if (msg?.type === "auth" && msg?.token === this.authToken) {
                this.authenticated.add(socket);
              }
              continue;
            }
            if (validateIpcMessage(msg)) {
              this.emit("clientMessage", msg, socket);
            }
          } catch {
            // ignore malformed
          }
        }
      });

      socket.on("close", () => {
        this.clients.delete(socket);
        this.authenticated.delete(socket);
      });

      socket.on("error", () => {
        this.clients.delete(socket);
        this.authenticated.delete(socket);
      });
    });

    this.startPromise = new Promise((resolve, reject) => {
      const handleError = (error) => {
        this.server?.removeListener("listening", handleListening);
        this.startPromise = null;
        this.server = null;
        this.address = null;
        this.removeEndpointFile();
        this.removeAuthToken();
        reject(error);
      };
      const handleListening = () => {
        this.server?.removeListener("error", handleError);
        const address = this.server?.address();
        if (!address || typeof address === "string") {
          handleError(new Error("Claude IPC server did not expose a TCP address"));
          return;
        }
        this.address = address;
        try {
          fs.writeFileSync(this.endpointFile, JSON.stringify({
            transport: "tcp",
            host: address.address,
            port: address.port,
            tokenFile: this.tokenFile,
          }, null, 2) + "\n", { mode: 0o600 });
        } catch (error) {
          handleError(error);
          return;
        }
        this.startPromise = null;
        resolve();
      };
      this.server.once("error", handleError);
      this.server.once("listening", handleListening);
      this.server.listen(0, "127.0.0.1");
    });
    await this.startPromise;
  }

  broadcast(event) {
    const payload = JSON.stringify(event) + "\n";
    for (const client of this.authenticated) {
      try {
        client.write(payload);
      } catch {
        // ignore dead sockets
      }
    }
  }

  reply(socket, event) {
    if (!this.authenticated.has(socket)) return false;
    try {
      socket.write(`${JSON.stringify(event)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  ensureDirectory() {
    fs.mkdirSync(this.stateDir, { recursive: true });
  }

  generateAuthToken() {
    this.authToken = crypto.randomBytes(32).toString("hex");
    try {
      fs.writeFileSync(this.tokenFile, this.authToken, { mode: 0o600 });
    } catch {
      // ignore
    }
  }

  removeAuthToken() {
    try {
      fs.unlinkSync(this.tokenFile);
    } catch {
      // ignore
    }
  }

  removeEndpointFile() {
    try {
      fs.unlinkSync(this.endpointFile);
    } catch {
      // ignore
    }
  }

  async close() {
    for (const client of this.clients) {
      try {
        client.end();
      } catch {
        // ignore
      }
    }
    this.clients.clear();
    this.authenticated.clear();

    if (this.server) {
      await new Promise((resolve) => {
        this.server.close(resolve);
      });
      this.server = null;
    }

    this.address = null;
    this.removeEndpointFile();
    this.removeAuthToken();
  }
}

function validateIpcMessage(msg) {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
    return false;
  }
  const type = msg.type;
  if (typeof type !== "string") {
    return false;
  }
  switch (type) {
    case "sendUserMessage":
      return typeof msg.workspaceRoot === "string" && typeof msg.text === "string";
    case "respondApproval":
      return typeof msg.workspaceRoot === "string" && typeof msg.requestId === "string";
    default:
      return true;
  }
}

module.exports = { ClaudeCodeIpcServer };
