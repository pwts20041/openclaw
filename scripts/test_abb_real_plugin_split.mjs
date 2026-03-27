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
  const scan = await call(1, "scan_controllers");
  const connect = await call(2, "connect", { host: "127.0.0.1", port: 7000 });
  const status = await call(3, "get_status");
  const sys = await call(4, "get_system_info");
  const service = await call(5, "get_service_info");
  const speed = await call(6, "get_speed");
  await call(7, "set_speed", { speed: 30 });
  const joints = await call(8, "get_joints");
  const world = await call(9, "get_world_position");
  const log = await call(10, "get_event_log", { limit: 5, categoryId: 0 });
  const tasks = await call(11, "list_tasks");
  const taskName = tasks?.details?.result?.tasks?.[0]?.taskName || "T_ROB1";
  const moduleName = tasks?.details?.result?.tasks?.[0]?.modules?.[0] || "";
  const backup = await call(12, "backup_module", { moduleName, taskName, outputDir: "d:/OpenClaw/Develop/openclaw/scripts/_abb_backup" });
  const ptr = await call(13, "reset_program_pointer", { taskName });

  const j = joints?.details?.result?.joints;
  if (Array.isArray(j) && j.length >= 6) {
    const target = [...j];
    target[0] = Number(target[0]) + 0.5;
    await call(14, "movj", { joints: target, speed: 8, zone: "fine" });
  }

  const ok =
    scan?.details?.success !== false &&
    connect?.details?.success === true &&
    status?.details?.success === true &&
    sys?.details?.success === true &&
    service?.details?.success === true &&
    speed?.details?.success === true &&
    world?.details?.success === true &&
    log?.details?.success === true &&
    backup?.details?.success === true &&
    ptr?.details?.success === true;

  if (ok) {
    console.log("SPLIT_REAL_OK");
  } else {
    console.log("SPLIT_REAL_FAIL");
  }
};

run().catch((err) => {
  console.log("SPLIT_REAL_FAIL_EXCEPTION", err?.message ?? String(err));
});
