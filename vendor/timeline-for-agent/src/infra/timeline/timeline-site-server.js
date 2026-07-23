const fs = require("fs");
const http = require("http");
const path = require("path");

function createTimelineSiteServer({ siteDir }) {
  fs.mkdirSync(siteDir, { recursive: true });
  return http.createServer((request, response) => {
    const requestPath = normalizeRequestPath(request.url || "/");
    const siteRoot = path.resolve(siteDir);
    const resolvedPath = resolveTimelineSiteAssetPath(siteRoot, requestPath);
    if (!fs.existsSync(resolvedPath)) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("timeline site not built");
      return;
    }
    response.writeHead(200, { "content-type": detectMimeType(resolvedPath) });
    fs.createReadStream(resolvedPath).pipe(response);
  });
}

async function listenTimelineSiteServer(server, { port }) {
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address();
  const resolvedPort = typeof address === "object" && address ? address.port : port;
  return {
    port: resolvedPort,
    url: `http://127.0.0.1:${resolvedPort}`,
  };
}

function closeTimelineSiteServer(server) {
  return new Promise((resolve) => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

function normalizeRequestPath(url) {
  const pathname = String(url || "/").split("?")[0];
  if (!pathname || pathname === "/") {
    return "index.html";
  }
  return pathname.replace(/^\/+/, "");
}

function resolveTimelineSiteAssetPath(siteRoot, requestPath) {
  const filePath = path.resolve(siteRoot, requestPath);
  if (!filePath.startsWith(siteRoot)) {
    return path.join(siteRoot, "index.html");
  }
  if (fs.existsSync(filePath)) {
    const stats = fs.statSync(filePath);
    if (stats.isFile()) {
      return filePath;
    }
    if (stats.isDirectory()) {
      const directoryIndexPath = path.join(filePath, "index.html");
      if (fs.existsSync(directoryIndexPath) && fs.statSync(directoryIndexPath).isFile()) {
        return directoryIndexPath;
      }
    }
  }
  return path.join(siteRoot, "index.html");
}

function detectMimeType(filePath) {
  if (filePath.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }
  if (filePath.endsWith(".js")) {
    return "application/javascript; charset=utf-8";
  }
  if (filePath.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }
  return "text/html; charset=utf-8";
}

module.exports = {
  createTimelineSiteServer,
  listenTimelineSiteServer,
  closeTimelineSiteServer,
};
