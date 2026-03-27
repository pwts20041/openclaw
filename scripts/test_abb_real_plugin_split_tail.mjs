import plugin from "../extensions/abb-robot-real-control/index.js";

let tool;
plugin.register(
  { registerTool: (t) => { tool = t; } },
  { controllerHost: "127.0.0.1", controllerPort: 7000, bridgeDllPath: "d:/OpenClaw/Develop/openclaw/extensions/abb-robot-control/src/ABBBridge.dll" }
);

async function call(i, action, extra = {}) {
  const r = await tool.execute(String(i), { action, ...extra });
  const text = r?.content?.[0]?.text ?? "";
  console.log(`STEP_${i}_${action}`, text.replace(/\s+/g, " "));
  return r;
}

const run = async () => {
  await call(1, "connect", { host: "127.0.0.1", port: 7000 });
  await call(2, "get_joints");
  await call(3, "get_world_position");
  await call(4, "get_event_log", { limit: 5, categoryId: 0 });
  const tasks = await call(5, "list_tasks");
  const taskName = tasks?.details?.result?.tasks?.[0]?.taskName || "T_ROB1";
  const moduleName = tasks?.details?.result?.tasks?.[0]?.modules?.[0] || "";
  await call(6, "backup_module", { moduleName, taskName, outputDir: "d:/OpenClaw/Develop/openclaw/scripts/_abb_backup" });
  await call(7, "reset_program_pointer", { taskName });
  const j = await call(8, "get_joints");
  const joints = j?.details?.result?.joints ?? [];
  if (Array.isArray(joints) && joints.length >= 6) {
    const target = [...joints];
    target[0] = Number(target[0]) + 0.3;
    await call(9, "movj", { joints: target, speed: 8, zone: "fine" });
  }
  console.log("TAIL_DONE");
};

run().catch((err) => {
  console.log("TAIL_FAIL_EXCEPTION", err?.message ?? String(err));
});
