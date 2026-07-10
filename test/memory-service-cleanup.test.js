const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { MemoryService } = require("../src/services/memory-service");

test("cleanup deletes noisy active memories and downgrades unstable ones", () => {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-memory-cleanup-"));
  fs.writeFileSync(path.join(memoryDir, "index.jsonl"), "", "utf8");
  const service = new MemoryService({ memoryDir });
  service.ensureFiles();

  service.appendMemory({
    id: "mem_bad_1",
    category: "projects",
    key: "",
    value: "哥哥没计划我可有计划",
    text: "哥哥没计划我可有计划",
    priority: "project",
    tier: "stable",
    status: "active",
  });
  service.appendMemory({
    id: "mem_obs_1",
    category: "projects",
    key: "project_current_page",
    value: "正在做一个页面",
    text: "正在做一个页面",
    priority: "project",
    tier: "stable",
    status: "active",
  });
  service.appendMemory({
    id: "mem_keep_1",
    category: "preferences",
    key: "pref_style_direct",
    value: "喜欢直接一点",
    text: "喜欢直接一点",
    priority: "hard_preference",
    tier: "stable",
    status: "active",
  });
  service.appendMemory({
    id: "mem_bad_2",
    category: "preferences",
    key: "",
    value: "谁让我喜欢你呢",
    text: "谁让我喜欢你呢",
    priority: "hard_preference",
    tier: "stable",
    status: "active",
  });
  service.appendMemory({
    id: "mem_bad_3",
    category: "relationships",
    key: "rel_客户跟进到5_4了_基金调仓还没好",
    value: "客户跟进到5/4了 基金调仓还没好",
    text: "客户跟进到5/4了 基金调仓还没好",
    priority: "relationship",
    tier: "stable",
    status: "active",
  });

  const result = service.cleanupHistoricalMemories();
  assert.equal(result.deleted, 3);
  assert.equal(result.downgraded, 1);

  const rows = service.searchMemory("计划");
  const deleted = rows.find((item) => item.id === "mem_bad_1");
  assert.equal(deleted.status, "deleted");

  const stableProjects = service.readIndex({ status: "active", categories: ["projects"], tiers: ["stable"], limit: 20 });
  assert.equal(stableProjects.length, 0);

  const observedProjects = service.readIndex({ status: "active", categories: ["projects"], tiers: ["observation"], limit: 20 });
  assert.equal(observedProjects.length, 1);
  assert.equal(observedProjects[0].id, "mem_obs_1");

  const preferences = service.readIndex({ status: "active", categories: ["preferences"], limit: 20 });
  assert.equal(preferences.length, 1);
  assert.equal(preferences[0].id, "mem_keep_1");
});
