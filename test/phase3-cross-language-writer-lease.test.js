// issue #89: the Python 520 reentry writer and Node History writer share one lease domain.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");

const {
  acquireWriterLease,
  releaseWriterLease,
  validateStoredLease,
} = require("../src/orchestration/writer-lease");
const { resolveMemoryWriterLeaseFile } = require("../src/orchestration/memory-writer-lease");

const KIT = path.resolve(__dirname, "../extensions/relationship-memory/memory-kit");
const LEASE_DETAILS = {
  writer: "history-writer",
  model: "fixture-model",
  phase: "phase3-fixture",
  branch: "fixture-branch",
  worktree: "fixture-worktree",
  base_sha: "f".repeat(40),
};

test("Node and Python resolve byte-identical writer lease paths", () => {
  const fixture = createFixture();
  const configured = path.join(fixture.root, "shared-root", "MEMORY_WRITER_LEASE.json");
  const cases = [
    {
      label: "configured",
      env: { CYBERBOSS_WRITER_LEASE_FILE: configured },
      node: resolveMemoryWriterLeaseFile({
        continuityDir: fixture.continuity,
        writerLeaseFile: configured,
      }),
    },
    {
      label: "default",
      env: { CYBERBOSS_WRITER_LEASE_FILE: "" },
      node: resolveMemoryWriterLeaseFile({ continuityDir: fixture.continuity }),
    },
  ];
  for (const item of cases) {
    const result = runPython(PYTHON_RESOLVE, [KIT, fixture.continuity], item.env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), item.node, `${item.label} path differs across languages`);
  }
});

test("Node-held lease makes the 520 reentry endpoint fail closed with a constructed collision", () => {
  const fixture = createFixture();
  const reentry = path.join(fixture.memory, "reentry.md");
  fs.writeFileSync(reentry, "Obviously fake original handoff.\n", "utf8");
  const held = acquireWriterLease(fixture.leaseFile, LEASE_DETAILS);
  const leaseBefore = fs.readFileSync(fixture.leaseFile);
  const reentryBefore = fs.readFileSync(reentry);

  // The parent owns the lease before the Python HTTP process starts, so its
  // first acquisition is guaranteed to collide rather than relying on timing.
  const result = runPython(PYTHON_HTTP_SAVE, [KIT], fixture.env);
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout.trim());
  assert.equal(response.status, 409);
  assert.equal(response.payload.error, "writer_lease_unavailable");
  assert.deepEqual(fs.readFileSync(reentry), reentryBefore);
  assert.deepEqual(fs.readFileSync(fixture.leaseFile), leaseBefore);
  releaseWriterLease(fixture.leaseFile, held.lease_id);
  console.log(`[issue89] constructed Node->Python collision, platform ${process.platform}`);
});

test("Python-held lease blocks Node acquisition without changing reentry", async () => {
  const fixture = createFixture();
  const reentry = path.join(fixture.memory, "reentry.md");
  fs.writeFileSync(reentry, "Obviously fake Python-owner handoff.\n", "utf8");
  const before = fs.readFileSync(reentry);
  const child = spawn("python", ["-c", PYTHON_HOLD, KIT, fixture.leaseFile], {
    env: { ...process.env, PYTHONUTF8: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const ready = JSON.parse(await readLine(child.stdout));
  assert.equal(ready.ready, true);
  assert.throws(
    () => acquireWriterLease(fixture.leaseFile, LEASE_DETAILS),
    /Writer lease already held/,
  );
  assert.deepEqual(fs.readFileSync(reentry), before);
  child.stdin.end("release\n");
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
  assert.equal(fs.existsSync(fixture.leaseFile), false);
});

test("Python lease validates and releases through the Node protocol", () => {
  const fixture = createFixture();
  const result = runPython(PYTHON_ACQUIRE, [KIT, fixture.leaseFile]);
  assert.equal(result.status, 0, result.stderr);
  const lease = JSON.parse(result.stdout.trim());
  const stored = JSON.parse(fs.readFileSync(fixture.leaseFile, "utf8"));
  validateStoredLease(stored);
  assert.deepEqual(stored, lease);
  assert.deepEqual(
    Object.fromEntries(["writer", "model", "phase", "branch", "worktree", "base_sha"].map((key) => [key, stored[key]])),
    {
      writer: "520-dashboard",
      model: "not-applicable",
      phase: "reentry-save",
      branch: "not-applicable",
      worktree: "not-applicable",
      base_sha: "not-applicable",
    },
  );
  releaseWriterLease(fixture.leaseFile, stored.lease_id);
  assert.equal(fs.existsSync(fixture.leaseFile), false);
});

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-issue89-"));
  const memory = path.join(root, "memory");
  const continuity = path.join(root, "continuity");
  const state = path.join(root, "state");
  const workspace = path.join(root, "workspace");
  for (const directory of [memory, continuity, state, workspace]) fs.mkdirSync(directory, { recursive: true });
  const leaseFile = path.join(root, "shared", "MEMORY_WRITER_LEASE.json");
  return {
    root,
    memory,
    continuity,
    leaseFile,
    env: {
      CYBERBOSS_DASHBOARD_KEYS_FILE: path.join(root, "keys.local.json"),
      CYBERBOSS_MEMORY_DIR: memory,
      CYBERBOSS_CONTINUITY_DIR: continuity,
      CYBERBOSS_STATE_DIR: state,
      CYBERBOSS_DASHBOARD_STATE_DIR: state,
      CYBERBOSS_WORKSPACE_ROOT: workspace,
      CYBERBOSS_PROJECT_ROOT: workspace,
      CYBERBOSS_WRITER_LEASE_FILE: leaseFile,
    },
  };
}

function runPython(source, args, extraEnv = {}) {
  return spawnSync("python", ["-c", source, ...args], {
    env: { ...process.env, PYTHONUTF8: "1", ...extraEnv },
    encoding: "utf8",
    timeout: 30_000,
  });
}

function readLine(stream) {
  return new Promise((resolve, reject) => {
    let buffered = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline >= 0) resolve(buffered.slice(0, newline));
    });
    stream.on("error", reject);
    stream.on("end", () => reject(new Error(`child ended before ready: ${buffered}`)));
  });
}

const PYTHON_RESOLVE = String.raw`
import sys
sys.path.insert(0, sys.argv[1])
from writer_lease import resolve_memory_writer_lease_file
print(resolve_memory_writer_lease_file(sys.argv[2]))
`;

const PYTHON_ACQUIRE = String.raw`
import json, sys
sys.path.insert(0, sys.argv[1])
from writer_lease import acquire_memory_writer_lease
print(json.dumps(acquire_memory_writer_lease(sys.argv[2])))
`;

const PYTHON_HOLD = String.raw`
import json, sys
sys.path.insert(0, sys.argv[1])
from writer_lease import acquire_memory_writer_lease, release_memory_writer_lease
lease = acquire_memory_writer_lease(sys.argv[2])
print(json.dumps({"ready": True, "lease_id": lease["lease_id"]}), flush=True)
sys.stdin.readline()
release_memory_writer_lease(sys.argv[2], lease["lease_id"])
`;

const PYTHON_HTTP_SAVE = String.raw`
import importlib.util, json, sys, threading, urllib.error, urllib.request
from http.server import HTTPServer
sys.path.insert(0, sys.argv[1])
spec = importlib.util.spec_from_file_location("dashboard_issue89_http", sys.argv[1] + "/dashboard.py")
dashboard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dashboard)
server = HTTPServer(("127.0.0.1", 0), dashboard.H)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
body = json.dumps({"key": "reentry", "content": "Obviously fake blocked replacement.", "source": "fixture"}).encode("utf-8")
request = urllib.request.Request(
    "http://127.0.0.1:%d/api/context-source/save" % server.server_port,
    data=body,
    method="POST",
    headers={"Content-Type": "application/json", "X-Api-Token": dashboard.API_TOKEN},
)
try:
    urllib.request.urlopen(request, timeout=5)
    raise AssertionError("blocked request unexpectedly succeeded")
except urllib.error.HTTPError as error:
    print(json.dumps({"status": error.code, "payload": json.loads(error.read().decode("utf-8"))}))
finally:
    server.shutdown()
    server.server_close()
`;
