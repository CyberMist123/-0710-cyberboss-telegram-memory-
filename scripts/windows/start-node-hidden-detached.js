const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

// 通过"隐藏 console 锚点"启动 node 桥,保证:
// 1) 存活:桥是本 helper 的孙子(cmd -> start /b -> anchor -> node 桥),
//    libuv 全局 job 带 SILENT_BREAKAWAY_OK,孙子不入 job,不随 helper 退出被杀;
// 2) 无窗:cmd 以 CREATE_NO_WINDOW 启动,持有一个"没有窗口"的 console,
//    anchor、桥及桥再 spawn 的所有子 node 都继承它,不再弹 conhost;
// 3) 真实 PID:anchor 把桥的 PID 写进 pid 文件,本 helper 回捞后打印,
//    launcher 的 pid 文件/存活检查/stop 按树杀的语义不变。
// 回滚:设置环境变量 CYBERBOSS_LEGACY_DETACHED_SPAWN=1 即恢复旧 detached 行为。
function launchViaHiddenConsole({ command, args, cwd, env, stdoutPath, stderrPath }, callback) {
  const anchorScript = path.join(__dirname, "hidden-console-anchor.js");
  const specPath = stdoutPath + ".launch.json";
  const pidPath = stdoutPath + ".launch.pid";
  const errPath = stdoutPath + ".launch.err";
  for (const p of [specPath, pidPath, errPath]) {
    try { fs.unlinkSync(p); } catch (_) {}
  }
  fs.writeFileSync(specPath, JSON.stringify({
    command, args, cwd, stdoutPath, stderrPath, pidPath, errPath,
  }));

  // 命令行上只有三个纯路径;参数全部在 spec JSON 里,避免 cmd 转义地狱。
  const inner = `start "" /b "${process.execPath}" "${anchorScript}" "${specPath}"`;
  const cmdChild = spawn("cmd.exe", ["/d", "/s", "/c", `"${inner}"`], {
    cwd,
    env,
    windowsHide: true, // CREATE_NO_WINDOW;仅在 stdio 无 fd 继承时生效,这里必须保持 "ignore"
    windowsVerbatimArguments: true,
    shell: false,
    stdio: "ignore",
  });

  cmdChild.once("error", (error) => callback(error));
  // 等 cmd 完成 start(毫秒级)再回捞 PID;提前退出会因 job 连带杀掉还没执行的 cmd。
  cmdChild.once("exit", () => {
    const deadline = Date.now() + 15000;
    const timer = setInterval(() => {
      try {
        if (fs.existsSync(errPath)) {
          clearInterval(timer);
          callback(new Error(fs.readFileSync(errPath, "utf8")));
          return;
        }
        if (fs.existsSync(pidPath)) {
          const raw = fs.readFileSync(pidPath, "utf8").trim();
          if (raw) {
            clearInterval(timer);
            try { fs.unlinkSync(specPath); } catch (_) {}
            callback(null, parseInt(raw, 10));
            return;
          }
        }
        if (Date.now() > deadline) {
          clearInterval(timer);
          callback(new Error("Timed out waiting for hidden-console anchor to report PID"));
        }
      } catch (error) {
        clearInterval(timer);
        callback(error);
      }
    }, 100);
  });
}

function legacyDetachedSpawn({ command, args, cwd, env, stdoutPath, stderrPath }) {
  const outFd = fs.openSync(stdoutPath, "a");
  const errFd = fs.openSync(stderrPath, "a");
  const child = spawn(command, args, {
    cwd,
    env,
    detached: true,
    shell: false,
    stdio: ["ignore", outFd, errFd],
  });
  child.unref();
  return child.pid || 0;
}

function main() {
  const [rootDir, stdoutPath, stderrPath, scriptPath, ...args] = process.argv.slice(2);
  if (!rootDir || !stdoutPath || !stderrPath || !scriptPath) {
    throw new Error("usage: node start-node-hidden-detached.js <rootDir> <stdout> <stderr> <script> [args...]");
  }

  fs.mkdirSync(path.dirname(stdoutPath), { recursive: true });
  fs.mkdirSync(path.dirname(stderrPath), { recursive: true });

  const options = {
    command: process.execPath,
    args: [scriptPath, ...args],
    cwd: rootDir,
    env: process.env,
    stdoutPath,
    stderrPath,
  };

  if (process.env.CYBERBOSS_LEGACY_DETACHED_SPAWN === "1") {
    process.stdout.write(String(legacyDetachedSpawn(options)));
    return;
  }

  launchViaHiddenConsole(options, (error, pid) => {
    if (error) {
      console.error(error && error.message ? error.message : String(error));
      process.exit(1);
    }
    process.stdout.write(String(pid || 0));
  });
}

try {
  main();
} catch (error) {
  console.error(error && error.message ? error.message : String(error));
  process.exit(1);
}
