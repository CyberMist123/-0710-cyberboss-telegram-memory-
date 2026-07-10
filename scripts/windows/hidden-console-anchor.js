// hidden-console-anchor.js
// 常驻锚点:本进程经由 `cmd(CREATE_NO_WINDOW) -> start /b` 链启动,
// 因此持有一个"无窗口"的 console。在这里直接 spawn 目标进程,
// 目标及其所有后代(codex 的 node_repl、桥的子 node 等)都继承这个
// 无窗口 console,Windows 不会再为它们新建可见 conhost。
//
// 生命周期:目标进程留在本进程的 libuv job(kill-on-job-close)里,
// 锚点被杀则目标被杀;目标退出则锚点跟着退出。不留孤儿。
//
// 用法: node hidden-console-anchor.js <spec.json>
// spec: { command, args, cwd, stdoutPath, stderrPath, pidPath, errPath }
// 复杂参数(TOML/JSON 串)全部走 spec 文件,绝不过 cmd 命令行转义。
const fs = require("fs");
const { spawn } = require("child_process");

function fail(spec, error) {
  const message = error && error.stack ? error.stack : String(error);
  try {
    if (spec && spec.errPath) {
      fs.writeFileSync(spec.errPath, message);
    }
  } catch (_) {}
  process.exit(1);
}

let spec = null;
try {
  const specPath = process.argv[2];
  if (!specPath) {
    throw new Error("usage: node hidden-console-anchor.js <spec.json>");
  }
  spec = JSON.parse(fs.readFileSync(specPath, "utf8"));

  const outFd = fs.openSync(spec.stdoutPath, "a");
  const errFd = fs.openSync(spec.stderrPath, "a");

  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: process.env,
    // 必须 false:detached 会给 DETACHED_PROCESS,子进程就继承不到
    // 本进程的隐藏 console 了(冒窗根因)。
    detached: false,
    shell: false,
    stdio: ["ignore", outFd, errFd],
  });

  child.once("error", (error) => fail(spec, error));

  if (child.pid) {
    fs.writeFileSync(spec.pidPath, String(child.pid));
  }

  // 不 unref:目标存活期间锚点常驻,目标退出后锚点以相同退出码退出。
  child.once("exit", (code) => process.exit(code == null ? 0 : code));
} catch (error) {
  fail(spec, error);
}
