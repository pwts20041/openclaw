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
  await execStep("scan", { action: "scan_controllers" });
  await execStep("connect", { action: "connect", host: "127.0.0.1", port: 7000 });
  await execStep("status", { action: "get_status" });
  await execStep("system", { action: "get_system_info" });
  await execStep("service", { action: "get_service_info" });
  await execStep("get_speed", { action: "get_speed" });
  await execStep("set_speed", { action: "set_speed", speed: 25 });
  await execStep("joints", { action: "get_joints" });
  await execStep("world", { action: "get_world_position" });
  await execStep("event_log", { action: "get_event_log", categoryId: 0, limit: 15 });
  await execStep("tasks", { action: "list_tasks" });
  process.stdout.write("PHASE1_DONE\n");
}

main().catch((e) => {
  process.stdout.write(`PHASE1_ERROR ${e?.message ?? String(e)}\n`);
  process.exit(1);
});
