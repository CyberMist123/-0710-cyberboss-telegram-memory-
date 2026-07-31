"use strict";

const path = require("node:path");

const HANDOFF_DELIVERY_LEASE_BASENAME = "HANDOFF_DELIVERY_WRITER_LEASE.json";
const HANDOFF_ACK_LEASE_BASENAME = "HANDOFF_ACK_WRITER_LEASE.json";

function resolveHandoffWriterLeaseFile({ continuityDir = "", kind = "" } = {}) {
  const root = normalize(continuityDir);
  if (!root) return "";
  const basename = kind === "delivery"
    ? HANDOFF_DELIVERY_LEASE_BASENAME
    : (kind === "ack" ? HANDOFF_ACK_LEASE_BASENAME : "");
  if (!basename) throw new Error("handoff writer lease kind must be delivery or ack");
  return path.resolve(root, ".jobs", basename);
}

function handoffWriterLeaseArchiveDir(continuityDir) {
  const root = normalize(continuityDir);
  return root ? path.resolve(root, ".backups", "writer-leases") : "";
}

function normalize(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  HANDOFF_ACK_LEASE_BASENAME,
  HANDOFF_DELIVERY_LEASE_BASENAME,
  handoffWriterLeaseArchiveDir,
  resolveHandoffWriterLeaseFile,
};
