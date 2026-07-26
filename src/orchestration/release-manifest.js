const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const SCHEMA_VERSION = 1;

// The 15 files that are intentionally excluded from every packaged release.
// They live under extensions/relationship-memory/{memory,memory-kit/memory}
// and hold private, personal relationship-memory runtime content (notes,
// episodic records, portraits, and the reading/closeout policy that governs
// that private data). None of their contents are read or reproduced here —
// only their repo-relative paths are recorded, with a shared, honest reason.
const RELATIONSHIP_MEMORY_EXCLUSION_REASON =
  "Private relationship-memory runtime content (personal notes, episodic " +
  "records, portraits, or the reading/closeout policy for that private " +
  "data); intentionally excluded from every packaged release so personal " +
  "conversational memory is never shipped in a versioned artifact.";

const EXCLUDED_RELATIONSHIP_MEMORY_FILES = [
  "extensions/relationship-memory/memory/README.md",
  "extensions/relationship-memory/memory/ai_self_notes.md",
  "extensions/relationship-memory/memory/ai_self_portrait.md",
  "extensions/relationship-memory/memory/closeout_guide.md",
  "extensions/relationship-memory/memory/episodes.candidates.jsonl",
  "extensions/relationship-memory/memory/episodes.jsonl",
  "extensions/relationship-memory/memory/home.md",
  "extensions/relationship-memory/memory/reading_policy.md",
  "extensions/relationship-memory/memory/reentry.extracted.md",
  "extensions/relationship-memory/memory/reentry.md",
  "extensions/relationship-memory/memory/relationship_timeline.md",
  "extensions/relationship-memory/memory/rereadings.md",
  "extensions/relationship-memory/memory/state_log.jsonl",
  "extensions/relationship-memory/memory/user_portrait.md",
  "extensions/relationship-memory/memory-kit/memory/reading_policy.md",
].map((relPath) => ({ path: relPath, reason: RELATIONSHIP_MEMORY_EXCLUSION_REASON }));

const TRANSFORM_RULES = {
  unconverted: "File bytes are identical to the source commit blob.",
  powershell_bom_crlf: "Packaged .ps1 files are content-equivalent to the source commit blob (ignoring BOM/line-ending differences) and are packaged as UTF-8 with a BOM, with no bare LF line endings (CRLF throughout).",
  text_normalized: "Non-.ps1 text files are content-equivalent to the source commit blob (ignoring line-ending differences only); no BOM is added. Either LF or CRLF line endings may appear, matching whatever style the source commit blob itself already used.",
};

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function hasUtf8Bom(buffer) {
  return buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
}

function listFilesRecursive(rootDir, { skipDirNames = [] } = {}) {
  const results = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (skipDirNames.includes(entry.name)) continue;
        walk(path.join(dir, entry.name));
        continue;
      }
      const full = path.join(dir, entry.name);
      const rel = path.relative(rootDir, full).split(path.sep).join("/");
      results.push(rel);
    }
  }
  walk(rootDir);
  return results.sort();
}

function countFilesRecursive(rootDir) {
  if (!fs.existsSync(rootDir)) return 0;
  let count = 0;
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) { walk(path.join(dir, entry.name)); continue; }
      count += 1;
    }
  }
  walk(rootDir);
  return count;
}

// \r and \n are single-byte ASCII code points in UTF-8, so a latin1 view lets
// us inspect/normalize line endings and a leading BOM without risking
// corruption of multi-byte UTF-8 sequences elsewhere in the buffer, and
// without assuming which side (source vs. release) "owns" the canonical
// line-ending style — history shows at least one source blob already used
// CRLF, so line-ending differences are treated as normalization, not as
// evidence of a fixed direction of conversion.
function normalizeForComparison(buffer) {
  const bom = hasUtf8Bom(buffer);
  const body = bom ? buffer.subarray(3) : buffer;
  const text = body.toString("latin1").replace(/\r\n/g, "\n");
  return Buffer.from(text, "latin1");
}

function describeEncoding(buffer) {
  const bom = hasUtf8Bom(buffer);
  const body = bom ? buffer.subarray(3) : buffer;
  const text = body.toString("latin1");
  const hasCrlf = /\r\n/.test(text);
  const hasBareLf = /(^|[^\r])\n/.test(text);
  let eol = "none";
  if (hasCrlf && hasBareLf) eol = "mixed";
  else if (hasCrlf) eol = "crlf";
  else if (hasBareLf) eol = "lf";
  return { bom, eol };
}

// Compares a packaged release file against its source commit blob and
// classifies the (declared) transform, if any. Returns
// { classification: "unconverted" | "powershell_bom_crlf" | "text_normalized" | "mismatch", encoding }.
// "mismatch" means either the content is not equivalent to the source blob
// once BOM/line-ending differences are normalized away, or the release file
// violates one of the two hard encoding invariants (.ps1 -> BOM + no bare
// LF; non-.ps1 -> no BOM). It must be treated as an integrity failure by
// the caller.
function classifyTransform(releaseBytes, sourceBytes, relPath) {
  const isPs1 = /\.ps1$/i.test(relPath);
  const encoding = describeEncoding(releaseBytes);

  if (!normalizeForComparison(releaseBytes).equals(normalizeForComparison(sourceBytes))) {
    return { classification: "mismatch", encoding };
  }
  if (isPs1) {
    if (!encoding.bom || encoding.eol === "lf" || encoding.eol === "mixed") {
      return { classification: "mismatch", encoding };
    }
  } else if (encoding.bom) {
    return { classification: "mismatch", encoding };
  }

  if (releaseBytes.equals(sourceBytes)) {
    return { classification: "unconverted", encoding };
  }
  return { classification: isPs1 ? "powershell_bom_crlf" : "text_normalized", encoding };
}

function gitTrackedFiles(repoDir, commit) {
  const raw = execFileSync("git", ["-C", repoDir, "ls-tree", "-r", "--name-only", `${commit}^{tree}`], { encoding: "utf8" });
  return raw.split(/\r?\n/).filter(Boolean).sort();
}

function gitCommitTreeSha(repoDir, commit) {
  return execFileSync("git", ["-C", repoDir, "rev-parse", `${commit}^{tree}`], { encoding: "utf8" }).trim();
}

function gitCommitSubject(repoDir, commit) {
  return execFileSync("git", ["-C", repoDir, "show", "-s", "--format=%s", commit], { encoding: "utf8" }).trim();
}

// Extracts the exact source blobs for `commit` into a temp directory via
// `git archive`, so every packaged file can be compared byte-for-byte
// against its source-of-truth commit content without spawning one `git
// show` process per file.
function extractSourceSnapshot(repoDir, commit) {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-release-manifest-src-"));
  const archivePath = path.join(dest, "..", `${path.basename(dest)}.tar`);
  execFileSync("git", ["-C", repoDir, "archive", "--format=tar", "-o", archivePath, commit]);
  execFileSync("tar", ["-x", "-f", archivePath, "-C", dest]);
  fs.unlinkSync(archivePath);
  return dest;
}

function matchesAllowlist(relPath, allowlist) {
  return allowlist.find((entry) => relPath === entry.prefix || relPath.startsWith(entry.prefix.endsWith("/") ? entry.prefix : `${entry.prefix}/`));
}

function buildManifest({ releaseId, releaseDir, repoDir, commit, buildTime, buildTimeSource, nodeVersion, npmVersion, additionalRuntimeAssetAllowlist = [] }) {
  const commitTreeSha = gitCommitTreeSha(repoDir, commit);
  const commitSubject = gitCommitSubject(repoDir, commit);
  const trackedFiles = gitTrackedFiles(repoDir, commit);
  const excludedPaths = new Set(EXCLUDED_RELATIONSHIP_MEMORY_FILES.map((item) => item.path));

  const releaseFiles = new Set(listFilesRecursive(releaseDir, { skipDirNames: ["node_modules"] }));
  const sourceSnapshotDir = extractSourceSnapshot(repoDir, commit);

  try {
    const files = [];
    const seenExclusions = new Set();

    for (const relPath of trackedFiles) {
      if (excludedPaths.has(relPath)) {
        seenExclusions.add(relPath);
        if (releaseFiles.has(relPath)) {
          throw new Error(`declared-excluded file is present in the release and must not be: ${relPath}`);
        }
        continue;
      }
      if (!releaseFiles.has(relPath)) {
        throw new Error(`tracked source file is missing from the release (undeclared exclusion): ${relPath}`);
      }
      const releasePath = path.join(releaseDir, relPath);
      const sourcePath = path.join(sourceSnapshotDir, relPath);
      const releaseBytes = fs.readFileSync(releasePath);
      const sourceBytes = fs.readFileSync(sourcePath);
      const { classification } = classifyTransform(releaseBytes, sourceBytes, relPath);
      if (classification === "mismatch") {
        throw new Error(`packaged file does not match any declared transform of its source commit content: ${relPath}`);
      }
      files.push({
        path: relPath,
        sha256: sha256Buffer(releaseBytes),
        size: releaseBytes.length,
        transform: classification,
      });
      releaseFiles.delete(relPath);
    }

    const missingExclusions = EXCLUDED_RELATIONSHIP_MEMORY_FILES.map((item) => item.path).filter((item) => !seenExclusions.has(item));
    if (missingExclusions.length) {
      throw new Error(`declared exclusion(s) not found in the source commit tree: ${missingExclusions.join(", ")}`);
    }

    // Anything left over is neither git-tracked nor a declared exclusion.
    // It is only permitted when it matches an operator-supplied allowlist
    // entry (an explicit declaration that this path is intentionally
    // bundled into the release outside of the git-tracked build, e.g.
    // pre-existing media assets); it is still fully hashed and recorded so
    // its integrity is covered by this manifest. Anything not allowlisted
    // is a genuine, undeclared packaging inconsistency and fails the build.
    const additionalRuntimeAssets = [];
    const stillUndeclared = [];
    for (const relPath of [...releaseFiles].sort()) {
      const allowlistEntry = matchesAllowlist(relPath, additionalRuntimeAssetAllowlist);
      if (!allowlistEntry) {
        stillUndeclared.push(relPath);
        continue;
      }
      const bytes = fs.readFileSync(path.join(releaseDir, relPath));
      additionalRuntimeAssets.push({
        path: relPath,
        sha256: sha256Buffer(bytes),
        size: bytes.length,
        reason: allowlistEntry.reason,
      });
    }
    if (stillUndeclared.length) {
      throw new Error(`release contains file(s) not present in the source commit and not declared as an exclusion or an allowlisted additional runtime asset: ${stillUndeclared.join(", ")}`);
    }

    const lockfilePath = path.join(releaseDir, "package-lock.json");
    const nodeModulesDir = path.join(releaseDir, "node_modules");

    return {
      schema_version: SCHEMA_VERSION,
      release_id: releaseId,
      commit: { sha: commit, tree_sha: commitTreeSha, subject: commitSubject },
      build: {
        build_time: buildTime,
        build_time_source: buildTimeSource,
        generator: "scripts/orchestration/release-manifest.js build",
        generator_node_version: nodeVersion,
        generator_npm_version: npmVersion,
        note: "This manifest was generated after the release was already built and smoke-tested; generator_node_version/generator_npm_version reflect the manifest-generation environment, not necessarily the original `npm ci` environment.",
      },
      files,
      excluded: EXCLUDED_RELATIONSHIP_MEMORY_FILES,
      additional_runtime_assets: additionalRuntimeAssets,
      dependencies: {
        manager: "npm",
        install_command: "npm run release:install",
        lockfile_path: "package-lock.json",
        lockfile_sha256: fs.existsSync(lockfilePath) ? sha256File(lockfilePath) : null,
        file_count: countFilesRecursive(nodeModulesDir),
        integrity_note: "node_modules file integrity is delegated to package-lock.json (verified by `npm ci`); individual dependency files are not separately hashed in this manifest.",
      },
      transforms: TRANSFORM_RULES,
    };
  } finally {
    fs.rmSync(sourceSnapshotDir, { recursive: true, force: true });
  }
}

function writeManifestFile(manifest, outPath) {
  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  const buffer = Buffer.from(json, "utf8");
  if (hasUtf8Bom(buffer)) {
    throw new Error("refusing to write a manifest with a UTF-8 BOM");
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buffer);
  return outPath;
}

function readManifestFile(manifestPath) {
  const raw = fs.readFileSync(manifestPath);
  if (hasUtf8Bom(raw)) {
    throw new Error(`manifest must be UTF-8 without BOM: ${manifestPath}`);
  }
  return JSON.parse(raw.toString("utf8"));
}

// Verifies a previously generated manifest against the release directory it
// describes. Optionally verifies the recorded commit/tree SHA exist in an
// external, read-only, trusted git repository (no .git is required inside
// the release itself) and that tree_sha is actually the tree of commit.sha.
// Every failure names the specific file/field at fault; file contents and
// secret values are never included in errors.
// When the caller has already read (and hash-pinned) the manifest, it passes
// those exact bytes via `manifestBytes` so this verification cannot be
// diverted by a concurrent swap of the file at manifestPath (R4 F2).
function verifyManifest({ manifestPath, releaseDir, repoDir, manifestBytes }) {
  const errors = [];
  let manifest;
  try {
    if (manifestBytes) {
      if (hasUtf8Bom(manifestBytes)) throw new Error(`manifest must be UTF-8 without BOM: ${manifestPath}`);
      manifest = JSON.parse(manifestBytes.toString("utf8"));
    } else {
      manifest = readManifestFile(manifestPath);
    }
  } catch (error) {
    return { ok: false, errors: [error.message] };
  }

  if (manifest.schema_version !== SCHEMA_VERSION) {
    errors.push(`schema_version: expected ${SCHEMA_VERSION}, found ${manifest.schema_version}`);
  }
  if (!manifest.commit || !/^[0-9a-f]{40}$/i.test(manifest.commit.sha || "")) {
    errors.push("commit.sha: must be a full 40-character git SHA");
  }
  if (!manifest.commit || !/^[0-9a-f]{40}$/i.test(manifest.commit.tree_sha || "")) {
    errors.push("commit.tree_sha: must be a full 40-character git SHA");
  }

  if (repoDir && manifest.commit) {
    for (const [field, sha] of [["commit.sha", manifest.commit.sha], ["commit.tree_sha", manifest.commit.tree_sha]]) {
      try {
        execFileSync("git", ["-C", repoDir, "cat-file", "-e", sha], { stdio: "ignore" });
      } catch {
        errors.push(`${field}: does not exist in the external repository ${repoDir}`);
      }
    }
    // Existence alone is not a relation: any pair of SHAs that happen to
    // live in the trusted repository would pass. Require tree_sha to be
    // the actual tree of commit.sha (R4 checklist item 7).
    try {
      const actualTree = gitCommitTreeSha(repoDir, manifest.commit.sha);
      if (actualTree.toLowerCase() !== String(manifest.commit.tree_sha || "").toLowerCase()) {
        errors.push(`commit.tree_sha: is not the tree of commit.sha in the external repository ${repoDir}`);
      }
    } catch {
      // commit.sha itself is missing or unresolvable; the existence check
      // above already reported it.
    }
  }

  const declaredExcluded = new Set((manifest.excluded || []).map((item) => item.path));
  if (!manifest.excluded || manifest.excluded.length !== EXCLUDED_RELATIONSHIP_MEMORY_FILES.length) {
    errors.push(`excluded: expected exactly ${EXCLUDED_RELATIONSHIP_MEMORY_FILES.length} declared exclusions, found ${manifest.excluded ? manifest.excluded.length : 0}`);
  }
  for (const item of manifest.excluded || []) {
    if (!item.reason || !item.reason.trim()) {
      errors.push(`excluded entry missing a reason: ${item.path}`);
    }
    if (fs.existsSync(path.join(releaseDir, item.path))) {
      errors.push(`declared-excluded file is present in the release: ${item.path}`);
    }
  }

  const expectedTransformNames = new Set(Object.keys(TRANSFORM_RULES));
  const releaseFiles = new Set(listFilesRecursive(releaseDir, { skipDirNames: ["node_modules"] }));

  for (const entry of manifest.files || []) {
    const filePath = path.join(releaseDir, entry.path);
    if (!expectedTransformNames.has(entry.transform)) {
      errors.push(`${entry.path}: undeclared transform '${entry.transform}'`);
    }
    if (!fs.existsSync(filePath)) {
      errors.push(`${entry.path}: file missing from release`);
      continue;
    }
    const bytes = fs.readFileSync(filePath);
    if (bytes.length !== entry.size) {
      errors.push(`${entry.path}: size mismatch (manifest ${entry.size}, actual ${bytes.length})`);
    }
    const actualSha = sha256Buffer(bytes);
    if (actualSha !== entry.sha256) {
      errors.push(`${entry.path}: sha256 mismatch`);
    }
    releaseFiles.delete(entry.path);
  }

  for (const entry of manifest.additional_runtime_assets || []) {
    if (!entry.reason || !entry.reason.trim()) {
      errors.push(`additional_runtime_assets entry missing a reason: ${entry.path}`);
    }
    const filePath = path.join(releaseDir, entry.path);
    if (!fs.existsSync(filePath)) {
      errors.push(`${entry.path}: additional runtime asset missing from release`);
      releaseFiles.delete(entry.path);
      continue;
    }
    const bytes = fs.readFileSync(filePath);
    if (bytes.length !== entry.size) {
      errors.push(`${entry.path}: additional runtime asset size mismatch (manifest ${entry.size}, actual ${bytes.length})`);
    }
    if (sha256Buffer(bytes) !== entry.sha256) {
      errors.push(`${entry.path}: additional runtime asset sha256 mismatch`);
    }
    releaseFiles.delete(entry.path);
  }

  for (const leftover of releaseFiles) {
    if (declaredExcluded.has(leftover)) continue;
    errors.push(`${leftover}: present in release but not listed in manifest.files, manifest.additional_runtime_assets, or a declared exclusion`);
  }

  if (manifest.dependencies && manifest.dependencies.lockfile_path) {
    const lockfilePath = path.join(releaseDir, manifest.dependencies.lockfile_path);
    if (manifest.dependencies.lockfile_sha256) {
      if (!fs.existsSync(lockfilePath)) {
        errors.push(`${manifest.dependencies.lockfile_path}: lockfile missing from release`);
      } else if (sha256File(lockfilePath) !== manifest.dependencies.lockfile_sha256) {
        errors.push(`${manifest.dependencies.lockfile_path}: lockfile sha256 mismatch`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

module.exports = {
  SCHEMA_VERSION,
  EXCLUDED_RELATIONSHIP_MEMORY_FILES,
  TRANSFORM_RULES,
  classifyTransform,
  buildManifest,
  writeManifestFile,
  readManifestFile,
  verifyManifest,
  listFilesRecursive,
  sha256File,
};
