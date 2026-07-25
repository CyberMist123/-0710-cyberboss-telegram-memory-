#!/usr/bin/env node
/* Control-plane primitives.  They only operate on explicit paths. */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { loadReleaseDescriptor } = require("../../src/orchestration/release-descriptor");
const { verifyManifest } = require("../../src/orchestration/release-manifest");

function sha256(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function hasBom(bytes) { return bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])); }
function equalHash(actual, expected, label) {
  if (!/^[0-9a-f]{64}$/i.test(expected || "") || actual.toLowerCase() !== expected.toLowerCase()) throw new Error(`${label} SHA256 does not match the explicit expected hash`);
}
function manifestCovers(manifest, releaseDir, file) {
  const rel = path.relative(releaseDir, file).split(path.sep).join("/");
  if (rel.startsWith("../") || path.isAbsolute(rel)) throw new Error("startup source is outside the active release");
  const record = [...(manifest.files || []), ...(manifest.additional_runtime_assets || [])].find((item) => item.path === rel);
  if (!record || record.sha256 !== sha256(file)) throw new Error(`startup source is not covered by the verified manifest: ${rel}`);
}
function readManifest(pathname) {
  const bytes = fs.readFileSync(pathname);
  if (hasBom(bytes)) throw new Error("manifest must be UTF-8 without BOM");
  return JSON.parse(bytes.toString("utf8"));
}
function installDescriptor({ candidatePath, expectedCandidateSha256, manifestPath, expectedManifestSha256, auditDirectory, targetPath, repoDir, verify = verifyManifest }) {
  const candidate = path.resolve(candidatePath); const manifestFile = path.resolve(manifestPath); const target = path.resolve(targetPath);
  const candidateBytes = fs.readFileSync(candidate);
  if (hasBom(candidateBytes)) throw new Error("candidate descriptor must be UTF-8 without BOM");
  equalHash(sha256(candidate), expectedCandidateSha256, "candidate");
  equalHash(sha256(manifestFile), expectedManifestSha256, "manifest");
  const descriptor = loadReleaseDescriptor(candidate, { requireExistingPaths: true });
  const manifest = readManifest(manifestFile);
  const result = verify({ manifestPath: manifestFile, releaseDir: path.dirname(path.dirname(descriptor.telegram_entry)), repoDir: repoDir || null });
  if (!result.ok) throw new Error(`manifest verification failed: ${(result.errors || []).join("; ")}`);
  fs.mkdirSync(auditDirectory, { recursive: true }); fs.mkdirSync(path.dirname(target), { recursive: true });
  const oldBytes = fs.existsSync(target) ? fs.readFileSync(target) : null;
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomUUID()}.tmp`);
  const backup = oldBytes ? path.join(path.resolve(auditDirectory), `${path.basename(target)}.${Date.now()}.${crypto.randomUUID()}.bak`) : null;
  try {
    fs.writeFileSync(temp, candidateBytes, { flag: "wx" });
    if (oldBytes) fs.copyFileSync(target, backup);
    // Rename is atomic within this directory; it never exposes a partial JSON file.
    fs.renameSync(temp, target);
    const written = fs.readFileSync(target);
    if (!written.equals(candidateBytes) || hasBom(written) || sha256(target) !== sha256(candidate)) throw new Error("post-write descriptor readback does not match candidate");
    loadReleaseDescriptor(target, { requireExistingPaths: true });
    const audit = { timestamp: new Date().toISOString(), old_sha256: oldBytes ? crypto.createHash("sha256").update(oldBytes).digest("hex") : null, new_sha256: sha256(target), manifest_sha256: sha256(manifestFile), backup_path: backup };
    fs.writeFileSync(path.join(path.resolve(auditDirectory), `descriptor-install-${Date.now()}-${crypto.randomUUID()}.json`), `${JSON.stringify(audit)}\n`, "utf8");
    return audit;
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function installStartupArtifact({ source, target, manifestPath, releaseDir, verify = verifyManifest, repoDir }) {
  const result = verify({ manifestPath, releaseDir, repoDir: repoDir || null });
  if (!result.ok) throw new Error(`manifest verification failed: ${(result.errors || []).join("; ")}`);
  const manifest = readManifest(manifestPath); manifestCovers(manifest, releaseDir, source);
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target);
  if (sha256(source) !== sha256(target)) throw new Error("installed startup artifact hash mismatch");
}
function args(list) { const out = {}; for (let i=0;i<list.length;i+=2) out[list[i].replace(/^--/,"")] = list[i+1]; return out; }
if (require.main === module) { const [command, ...rest] = process.argv.slice(2); const a = args(rest); try { if (command === "install-descriptor") console.log(JSON.stringify(installDescriptor({ candidatePath:a.candidate, expectedCandidateSha256:a["candidate-sha256"], manifestPath:a.manifest, expectedManifestSha256:a["manifest-sha256"], auditDirectory:a.audit, targetPath:a.target, repoDir:a.repo }))); else throw new Error("unknown command"); } catch (error) { console.error(`control-plane failure: ${error.message}`); process.exitCode = 1; } }
module.exports = { hasBom, installDescriptor, installStartupArtifact, manifestCovers, sha256 };
