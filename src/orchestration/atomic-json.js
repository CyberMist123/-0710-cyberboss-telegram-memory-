const fs = require("fs");
const path = require("path");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJsonAtomic(filePath, value, options = {}) {
  const destination = path.resolve(filePath);
  const directory = path.dirname(destination);
  fs.mkdirSync(directory, { recursive: true });
  const tempPath = path.join(
    directory,
    `.${path.basename(destination)}.${process.pid}.${Date.now()}.tmp`,
  );
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  let handle;
  try {
    handle = fs.openSync(tempPath, "wx", options.mode || 0o600);
    fs.writeFileSync(handle, payload, "utf8");
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
    fs.renameSync(tempPath, destination);
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
    try {
      fs.unlinkSync(tempPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return destination;
}

module.exports = { readJson, writeJsonAtomic };
