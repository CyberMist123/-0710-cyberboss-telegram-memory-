// Offline stand-in for a Codex sub-agent.
//
// Same shape the real adapter would expose to the delegation runner
// ({ run, cancel }), but it never spawns a process, never opens a socket and
// never spends quota -- it just performs the file writes it was scripted to
// perform. That is what lets the whole bounded-delegation loop run in CI.
//
// Mirrors the spirit of test/helpers/fake-claude-cli.js, which is the existing
// offline-fixture precedent in this repo.

const fs = require("fs");
const path = require("path");

// script:
//   writes    - [{ path (repo-relative), content }] applied inside spec.workspace
//   summary   - the prose the runtime claims
//   hang      - never settle, so the runner's timeout is the thing under test
//   cancelled - report a cooperative cancellation
//   throws    - reject with this message
function createFakeCodexRuntime(script = {}) {
  const calls = { run: 0, cancel: 0 };

  function applyWrites(workspace) {
    for (const write of script.writes || []) {
      const target = path.resolve(workspace, write.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, write.content, "utf8");
    }
  }

  return {
    calls,
    run({ spec }) {
      calls.run += 1;

      if (script.throws) {
        return Promise.reject(new Error(script.throws));
      }

      // Writes land before the hang so a timed-out run leaves the same partial
      // state a real interrupted run would.
      applyWrites(spec.workspace);

      if (script.hang) {
        return new Promise(() => {});
      }

      return Promise.resolve({
        summary: script.summary || "fake runtime completed",
        cancelled: Boolean(script.cancelled),
      });
    },
    cancel() {
      calls.cancel += 1;
    },
  };
}

module.exports = { createFakeCodexRuntime };
