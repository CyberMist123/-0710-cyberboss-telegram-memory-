"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { stripConversationArtifacts } = require("../src/continuity/conversation-purity");
const { ProjectToolHost } = require("../src/tools/tool-host");

test("A7/A8 notice is deterministic, bounded, and stripped before materialization", () => {
  const notice = "<route1_task_notice>task_id=fixture; lifecycle=completed; decision=accept; summary=done</route1_task_notice>";
  assert.equal(stripConversationArtifacts(`before\n${notice}\nafter`), "before\nafter");
  assert.equal(stripConversationArtifacts(`<subject_memory_handoff>${notice}</subject_memory_handoff>`), "");
});

test("A6 explicit status/result tools are visible only with the shared dispatch flag", async () => {
  const priorDispatch = process.env.CYBERBOSS_ROUTE1_CHAT_DISPATCH_ENABLED;
  const priorTask = process.env.CYBERBOSS_CLAUDE_ROUTE1_TASK_SESSION_ENABLED;
  process.env.CYBERBOSS_ROUTE1_CHAT_DISPATCH_ENABLED = "true";
  process.env.CYBERBOSS_CLAUDE_ROUTE1_TASK_SESSION_ENABLED = "true";
  try {
    const calls = [];
    const host = new ProjectToolHost({
      services: {
        route1TaskQuery: {
          async query(action, args, context) {
            calls.push({ action, args, context });
            return { status: action === "result" ? "claimed" : "ok", task_id: args.task_id || "none" };
          },
        },
      },
      runtimeContextStore: { load() {}, resolveActiveContext() { return {}; } },
    });
    assert.equal(host.listTools().some((tool) => tool.name === "route1_task_status"), true);
    assert.equal(host.listTools().some((tool) => tool.name === "route1_task_result"), true);
    await host.invokeTool("route1_task_status", {}, { turnId: "fixture-turn" });
    await host.invokeTool("route1_task_result", { task_id: "fixture-task" }, { turnId: "fixture-turn" });
    assert.deepEqual(calls.map((entry) => entry.action), ["status", "result"]);
  } finally {
    if (priorDispatch === undefined) delete process.env.CYBERBOSS_ROUTE1_CHAT_DISPATCH_ENABLED;
    else process.env.CYBERBOSS_ROUTE1_CHAT_DISPATCH_ENABLED = priorDispatch;
    if (priorTask === undefined) delete process.env.CYBERBOSS_CLAUDE_ROUTE1_TASK_SESSION_ENABLED;
    else process.env.CYBERBOSS_CLAUDE_ROUTE1_TASK_SESSION_ENABLED = priorTask;
  }
});
