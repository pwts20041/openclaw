import plugin from "../extensions/abb-robot-real-control/index.js";

let tool;
plugin.register(
  { registerTool: (t) => { tool = t; } },
  {
    controllerHost: "127.0.0.1",
    controllerPort: 7000,
    bridgeDllPath: "d:/OpenClaw/Develop/openclaw/extensions/abb-robot-control/src/ABBBridge.dll",
  }
);

async function execStep(name, payload) {
  process.stdout.write(`STEP_START ${name}\n`);
  const result = await tool.execute(name, payload);
  const text = String(result?.content?.[0]?.text ?? "").replace(/\s+/g, " ").trim();
  process.stdout.write(`STEP_END ${name} | ${text}\n`);
  process.stdout.write(`STEP_JSON ${name} ${JSON.stringify(result?.details ?? {})}\n`);
  return result;
}

async function main() {
  await execStep("connect", { action: "connect", host: "127.0.0.1", port: 7000 });
  const tasks = await execStep("tasks", { action: "list_tasks" });

  const firstTask = tasks?.details?.result?.tasks?.[0];
  const taskName = firstTask?.taskName || "T_ROB1";
  const moduleName = firstTask?.modules?.[0] || "MainModule";

  await execStep("backup", {
    action: "backup_module",
    taskName,
    moduleName,
    outputDir: "d:/OpenClaw/Develop/openclaw/scripts/_abb_backup"
  });

  await execStep("resetpp", { action: "reset_program_pointer", taskName });

  const joints = await execStep("joints", { action: "get_joints" });
  const j = joints?.details?.result?.joints;
  if (Array.isArray(j) && j.length === 6) {
    const target = [...j];
    target[0] = Number(target[0]) + 0.2;
    await execStep("movj_small", { action: "movj", joints: target, speed: 6, zone: "fine" });
  }

  await execStep("movj_bad", { action: "movj", joints: [1, 2], speed: 5 });
  await execStep("analyze", { action: "analyze_logs", categoryId: 0, limit: 20, error_hint: "T_ROB1 MainModule 行3 错误" });

  process.stdout.write("PHASE2_DONE\n");
}

main().catch((e) => {
  process.stdout.write(`PHASE2_ERROR ${e?.message ?? String(e)}\n`);
  process.exit(1);
});
