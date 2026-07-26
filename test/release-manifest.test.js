const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const {
  buildManifest,
  writeManifestFile,
  readManifestFile,
  verifyManifest,
  classifyTransform,
  EXCLUDED_RELATIONSHIP_MEMORY_FILES,
} = require("../src/orchestration/release-manifest");

function sh(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: "pipe" });
}

function writeFile(root, relPath, content) {
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

// Builds a minimal git repo with: one plain text file, one .ps1 file, and
// every declared relationship-memory exclusion path (so buildManifest's
// "declared exclusion must exist in source" check is satisfied), then
// commits it and returns { repoDir, commit }.
function makeFixtureRepo() {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-manifest-repo-"));
  sh("git", ["init", "-q"], repoDir);
  sh("git", ["config", "user.email", "test@example.com"], repoDir);
  sh("git", ["config", "user.name", "Test"], repoDir);

  writeFile(repoDir, "README.md", "hello\nworld\n");
  writeFile(repoDir, "scripts/windows/start-safe.ps1", "Write-Output 'hi'\n");
  writeFile(repoDir, "package-lock.json", "{}\n");
  for (const item of EXCLUDED_RELATIONSHIP_MEMORY_FILES) {
    writeFile(repoDir, item.path, "private\n");
  }

  sh("git", ["add", "-A"], repoDir);
  sh("git", ["commit", "-q", "-m", "fixture commit"], repoDir);
  const commit = execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  return { repoDir, commit };
}

// Materializes a release directory from the fixture: the plain text file is
// converted to CRLF (no BOM); the .ps1 file is converted to UTF-8 with BOM
// and CRLF; the 15 declared exclusions are omitted, matching a correctly
// packaged release.
function makeFixtureRelease(root) {
  const releaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-manifest-release-"));
  fs.writeFileSync(path.join(releaseDir, "README.md"), "hello\r\nworld\r\n");
  fs.mkdirSync(path.join(releaseDir, "scripts", "windows"), { recursive: true });
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  fs.writeFileSync(path.join(releaseDir, "scripts", "windows", "start-safe.ps1"), Buffer.concat([bom, Buffer.from("Write-Output 'hi'\r\n")]));
  fs.writeFileSync(path.join(releaseDir, "package-lock.json"), "{}\n");
  return releaseDir;
}

test("classifyTransform: identical bytes are 'unconverted'", () => {
  const buf = Buffer.from("same\n");
  const result = classifyTransform(buf, buf, "some/file.md");
  assert.equal(result.classification, "unconverted");
});

test("classifyTransform: .ps1 gains BOM+CRLF and is classified powershell_bom_crlf", () => {
  const source = Buffer.from("Write-Output 'x'\n");
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const release = Buffer.concat([bom, Buffer.from("Write-Output 'x'\r\n")]);
  const result = classifyTransform(release, source, "scripts/windows/foo.ps1");
  assert.equal(result.classification, "powershell_bom_crlf");
});

test("classifyTransform: a BOM on a non-.ps1 file is a mismatch", () => {
  const source = Buffer.from("hello\n");
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const release = Buffer.concat([bom, Buffer.from("hello\n")]);
  const result = classifyTransform(release, source, "README.md");
  assert.equal(result.classification, "mismatch");
});

test("classifyTransform: real content differences are a mismatch, not a declared transform", () => {
  const source = Buffer.from("hello\n");
  const release = Buffer.from("goodbye\n");
  const result = classifyTransform(release, source, "README.md");
  assert.equal(result.classification, "mismatch");
});

test("buildManifest + verifyManifest succeed end-to-end on a correctly packaged release", () => {
  const { repoDir, commit } = makeFixtureRepo();
  const releaseDir = makeFixtureRelease();
  const manifest = buildManifest({
    releaseId: "fixture-release",
    releaseDir,
    repoDir,
    commit,
    buildTime: "2026-01-01T00:00:00.000Z",
    buildTimeSource: "test",
    nodeVersion: process.version,
    npmVersion: "0.0.0",
  });
  assert.equal(manifest.excluded.length, EXCLUDED_RELATIONSHIP_MEMORY_FILES.length);
  assert.equal(manifest.files.length, 3);

  const outPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-manifest-out-")), "manifest.json");
  writeManifestFile(manifest, outPath);
  const roundTripped = readManifestFile(outPath);
  assert.equal(roundTripped.release_id, "fixture-release");

  const verification = verifyManifest({ manifestPath: outPath, releaseDir, repoDir });
  assert.equal(verification.ok, true, verification.errors.join("\n"));
});

test("buildManifest fails when a declared-excluded file is actually present in the release", () => {
  const { repoDir, commit } = makeFixtureRepo();
  const releaseDir = makeFixtureRelease();
  writeFile(releaseDir, EXCLUDED_RELATIONSHIP_MEMORY_FILES[0].path, "private\n");
  assert.throws(
    () => buildManifest({ releaseId: "x", releaseDir, repoDir, commit, buildTime: "t", buildTimeSource: "test", nodeVersion: "v", npmVersion: "v" }),
    /present in the release and must not be/
  );
});

test("buildManifest fails on an undeclared extra file not present in source", () => {
  const { repoDir, commit } = makeFixtureRepo();
  const releaseDir = makeFixtureRelease();
  writeFile(releaseDir, "extra/mystery.bin", "???\n");
  assert.throws(
    () => buildManifest({ releaseId: "x", releaseDir, repoDir, commit, buildTime: "t", buildTimeSource: "test", nodeVersion: "v", npmVersion: "v" }),
    /not declared as an exclusion or an allowlisted additional runtime asset/
  );
});

test("buildManifest accepts an undeclared extra file when explicitly allowlisted", () => {
  const { repoDir, commit } = makeFixtureRepo();
  const releaseDir = makeFixtureRelease();
  writeFile(releaseDir, "stickers/a.gif", "gifdata\n");
  const manifest = buildManifest({
    releaseId: "x",
    releaseDir,
    repoDir,
    commit,
    buildTime: "t",
    buildTimeSource: "test",
    nodeVersion: "v",
    npmVersion: "v",
    additionalRuntimeAssetAllowlist: [{ prefix: "stickers/", reason: "test fixture asset" }],
  });
  assert.equal(manifest.additional_runtime_assets.length, 1);
  assert.equal(manifest.additional_runtime_assets[0].path, "stickers/a.gif");
});

test("verifyManifest catches a tampered file (sha256 mismatch) by name", () => {
  const { repoDir, commit } = makeFixtureRepo();
  const releaseDir = makeFixtureRelease();
  const manifest = buildManifest({ releaseId: "x", releaseDir, repoDir, commit, buildTime: "t", buildTimeSource: "test", nodeVersion: "v", npmVersion: "v" });
  fs.appendFileSync(path.join(releaseDir, "README.md"), "tampered\r\n");
  const outPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-manifest-out-")), "manifest.json");
  writeManifestFile(manifest, outPath);
  const verification = verifyManifest({ manifestPath: outPath, releaseDir });
  assert.equal(verification.ok, false);
  assert.match(verification.errors.join("\n"), /README\.md: sha256 mismatch/);
});

test("verifyManifest rejects a manifest with a UTF-8 BOM", () => {
  const { repoDir, commit } = makeFixtureRepo();
  const releaseDir = makeFixtureRelease();
  const manifest = buildManifest({ releaseId: "x", releaseDir, repoDir, commit, buildTime: "t", buildTimeSource: "test", nodeVersion: "v", npmVersion: "v" });
  const outPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-manifest-out-")), "manifest.json");
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  fs.writeFileSync(outPath, Buffer.concat([bom, Buffer.from(JSON.stringify(manifest))]));
  const verification = verifyManifest({ manifestPath: outPath, releaseDir });
  assert.equal(verification.ok, false);
  assert.match(verification.errors.join("\n"), /without BOM/);
});

test("verifyManifest checks commit/tree SHA existence against an external read-only repo", () => {
  const { repoDir, commit } = makeFixtureRepo();
  const releaseDir = makeFixtureRelease();
  const manifest = buildManifest({ releaseId: "x", releaseDir, repoDir, commit, buildTime: "t", buildTimeSource: "test", nodeVersion: "v", npmVersion: "v" });
  manifest.commit.sha = "1".repeat(40);
  const outPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-manifest-out-")), "manifest.json");
  writeManifestFile(manifest, outPath);
  const verification = verifyManifest({ manifestPath: outPath, releaseDir, repoDir });
  assert.equal(verification.ok, false);
  assert.match(verification.errors.join("\n"), /commit\.sha: does not exist in the external repository/);
});

test("verifyManifest rejects a tree_sha that exists but is not the tree of commit.sha", () => {
  const { repoDir, commit } = makeFixtureRepo();
  const releaseDir = makeFixtureRelease();
  const manifest = buildManifest({ releaseId: "x", releaseDir, repoDir, commit, buildTime: "t", buildTimeSource: "test", nodeVersion: "v", npmVersion: "v" });
  // the commit SHA itself exists in the repository, so a pure existence
  // check passes — but it is an unrelated object, not this commit's tree
  manifest.commit.tree_sha = commit;
  const outPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-manifest-out-")), "manifest.json");
  writeManifestFile(manifest, outPath);
  const verification = verifyManifest({ manifestPath: outPath, releaseDir, repoDir });
  assert.equal(verification.ok, false);
  assert.match(verification.errors.join("\n"), /commit\.tree_sha: is not the tree of commit\.sha/);
});

test("verifyManifest judges caller-pinned manifest bytes over the file on disk", () => {
  const { repoDir, commit } = makeFixtureRepo();
  const releaseDir = makeFixtureRelease();
  const manifest = buildManifest({ releaseId: "x", releaseDir, repoDir, commit, buildTime: "t", buildTimeSource: "test", nodeVersion: "v", npmVersion: "v" });
  const outPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-manifest-out-")), "manifest.json");
  writeManifestFile(manifest, outPath);
  const pinnedBytes = fs.readFileSync(outPath);
  // swap the on-disk manifest for garbage: verification must still succeed
  // because it judges the pinned bytes, proving there is no second read
  fs.writeFileSync(outPath, "{ not json");
  const verification = verifyManifest({ manifestPath: outPath, releaseDir, repoDir, manifestBytes: pinnedBytes });
  assert.equal(verification.ok, true, verification.errors.join("\n"));
});
