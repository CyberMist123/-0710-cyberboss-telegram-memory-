#!/usr/bin/env node
const {
  buildManifest,
  writeManifestFile,
  verifyManifest,
} = require("../../src/orchestration/release-manifest");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const eq = item.indexOf("=");
    if (eq !== -1) {
      out[item.slice(2, eq)] = item.slice(eq + 1);
      continue;
    }
    const key = item.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function usage() {
  console.error("Usage:");
  console.error("  release-manifest.js build --release-dir <path> --repo-dir <path> --commit <sha> --release-id <id> --out <path> [--build-time <iso>] [--build-time-source <label>] [--additional-runtime-assets '<json array of {prefix,reason}>']");
  console.error("  release-manifest.js verify --manifest <path> --release-dir <path> [--repo-dir <path>]");
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (command === "build") {
    for (const required of ["release-dir", "repo-dir", "commit", "release-id", "out"]) {
      if (!args[required]) {
        console.error(`Missing required --${required}`);
        usage();
        process.exit(2);
      }
    }
    const manifest = buildManifest({
      releaseId: args["release-id"],
      releaseDir: args["release-dir"],
      repoDir: args["repo-dir"],
      commit: args.commit,
      buildTime: args["build-time"] || new Date().toISOString(),
      buildTimeSource: args["build-time-source"] || "manifest_generation_time",
      nodeVersion: process.version,
      npmVersion: (() => {
        try {
          return require("child_process").execFileSync("npm", ["--version"], { encoding: "utf8" }).trim();
        } catch {
          return null;
        }
      })(),
      additionalRuntimeAssetAllowlist: args["additional-runtime-assets"] ? JSON.parse(args["additional-runtime-assets"]) : [],
    });
    const outPath = writeManifestFile(manifest, args.out);
    console.log(JSON.stringify({ ok: true, out: outPath, release_id: manifest.release_id, files: manifest.files.length }));
    return;
  }

  if (command === "verify") {
    if (!args.manifest || !args["release-dir"]) {
      console.error("Missing required --manifest and/or --release-dir");
      usage();
      process.exit(2);
    }
    const result = verifyManifest({
      manifestPath: args.manifest,
      releaseDir: args["release-dir"],
      repoDir: args["repo-dir"] || null,
    });
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  }

  usage();
  process.exit(2);
}

main();
