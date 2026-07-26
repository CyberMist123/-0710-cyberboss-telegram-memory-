#!/usr/bin/env node
/* Control-plane primitives.  They only operate on explicit paths. */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { loadReleaseDescriptor } = require("../../src/orchestration/release-descriptor");
const { verifyManifest } = require("../../src/orchestration/release-manifest");

function sha256Bytes(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function sha256(file) { return sha256Bytes(fs.readFileSync(file)); }
function hasBom(bytes) { return bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])); }
function equalHash(actual, expected, label) {
  if (!/^[0-9a-f]{64}$/i.test(expected || "") || actual.toLowerCase() !== expected.toLowerCase()) throw new Error(`${label} SHA256 does not match the explicit expected hash`);
}
// `bytes` must be the caller's single read of `file`: the coverage decision
// and the bytes that end up installed have to be the same bytes, or a
// concurrent swap of the source self-certifies.
function manifestCovers(manifest, releaseDir, file, bytes = fs.readFileSync(file)) {
  const rel = path.relative(releaseDir, file).split(path.sep).join("/");
  if (rel.startsWith("../") || path.isAbsolute(rel)) throw new Error("startup source is outside the active release");
  const record = [...(manifest.files || []), ...(manifest.additional_runtime_assets || [])].find((item) => item.path === rel);
  if (!record || record.sha256 !== sha256Bytes(bytes)) throw new Error(`startup source is not covered by the verified manifest: ${rel}`);
  return record;
}
function installDescriptor({ candidatePath, expectedCandidateSha256, manifestPath, expectedManifestSha256, auditDirectory, targetPath, repoDir, verify = verifyManifest }) {
  const candidate = path.resolve(candidatePath); const manifestFile = path.resolve(manifestPath); const target = path.resolve(targetPath);
  // Single read: every check below (hash pin, BOM, schema validation, the
  // rename and the post-write comparison) operates on these exact bytes, so
  // a concurrent swap of the operator's candidate file cannot change what
  // gets verified versus what gets installed.
  const candidateBytes = fs.readFileSync(candidate);
  if (hasBom(candidateBytes)) throw new Error("candidate descriptor must be UTF-8 without BOM");
  equalHash(sha256Bytes(candidateBytes), expectedCandidateSha256, "candidate");
  const manifestSha256 = sha256(manifestFile);
  equalHash(manifestSha256, expectedManifestSha256, "manifest");
  fs.mkdirSync(auditDirectory, { recursive: true }); fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, candidateBytes, { flag: "wx" });
    // Validate the bytes that will be renamed into place, not a re-read of
    // the candidate file.
    const descriptor = loadReleaseDescriptor(temp, { requireExistingPaths: true });
    const result = verify({ manifestPath: manifestFile, releaseDir: path.dirname(path.dirname(descriptor.telegram_entry)), repoDir: repoDir || null });
    if (!result.ok) throw new Error(`manifest verification failed: ${(result.errors || []).join("; ")}`);
    const oldBytes = fs.existsSync(target) ? fs.readFileSync(target) : null;
    const backup = oldBytes ? path.join(path.resolve(auditDirectory), `${path.basename(target)}.${Date.now()}.${crypto.randomUUID()}.bak`) : null;
    if (oldBytes) fs.copyFileSync(target, backup);
    // Rename is atomic within this directory; it never exposes a partial JSON file.
    fs.renameSync(temp, target);
    try {
      const written = fs.readFileSync(target);
      if (!written.equals(candidateBytes) || hasBom(written)) throw new Error("post-write descriptor readback does not match candidate");
      loadReleaseDescriptor(target, { requireExistingPaths: true });
    } catch (postError) {
      // Never leave unverified bytes installed: put the previous descriptor
      // back (or remove a fresh install) before failing.
      if (backup) fs.copyFileSync(backup, target); else fs.rmSync(target, { force: true });
      throw new Error(`post-write verification failed and the previous descriptor was restored: ${postError.message}`);
    }
    const audit = { timestamp: new Date().toISOString(), old_sha256: oldBytes ? sha256Bytes(oldBytes) : null, new_sha256: sha256Bytes(candidateBytes), manifest_sha256: manifestSha256, backup_path: backup };
    fs.writeFileSync(path.join(path.resolve(auditDirectory), `descriptor-install-${Date.now()}-${crypto.randomUUID()}.json`), `${JSON.stringify(audit)}\n`, "utf8");
    return audit;
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function installStartupArtifact({ source, target, manifestPath, expectedManifestSha256, releaseDir, verify = verifyManifest, repoDir }) {
  // Single read of the manifest, pinned to the operator's explicit hash
  // (same double-anchor discipline as installDescriptor): verification,
  // coverage and the post-write comparison all judge these exact bytes, so
  // a manifest swapped mid-install cannot self-certify (R4 F2).
  const manifestBytes = fs.readFileSync(manifestPath);
  if (hasBom(manifestBytes)) throw new Error("manifest must be UTF-8 without BOM");
  equalHash(sha256Bytes(manifestBytes), expectedManifestSha256, "manifest");
  const result = verify({ manifestPath, releaseDir, repoDir: repoDir || null, manifestBytes });
  if (!result.ok) throw new Error(`manifest verification failed: ${(result.errors || []).join("; ")}`);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  // Single read of the source; install exactly the bytes that passed the
  // coverage check, and judge the installed file against the manifest's
  // recorded hash rather than a re-read of the (swappable) source.
  const sourceBytes = fs.readFileSync(source);
  const record = manifestCovers(manifest, releaseDir, source, sourceBytes);
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, sourceBytes);
  if (sha256(target) !== record.sha256) throw new Error("installed startup artifact hash does not match the manifest record");
}
function args(list) { const out = {}; for (let i=0;i<list.length;i+=2) out[list[i].replace(/^--/,"")] = list[i+1]; return out; }
if (require.main === module) { const [command, ...rest] = process.argv.slice(2); const a = args(rest); try { if (command === "install-descriptor") console.log(JSON.stringify(installDescriptor({ candidatePath:a.candidate, expectedCandidateSha256:a["candidate-sha256"], manifestPath:a.manifest, expectedManifestSha256:a["manifest-sha256"], auditDirectory:a.audit, targetPath:a.target, repoDir:a.repo }))); else throw new Error("unknown command"); } catch (error) { console.error(`control-plane failure: ${error.message}`); process.exitCode = 1; } }
module.exports = { hasBom, installDescriptor, installStartupArtifact, manifestCovers, sha256, sha256Bytes };
