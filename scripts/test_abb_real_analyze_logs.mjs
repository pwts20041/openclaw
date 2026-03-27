import plugin from "../extensions/abb-robot-real-control/index.js";

let tool;
plugin.register(
  { registerTool: (t) => { tool = t; } },
  { controllerHost: "127.0.0.1", controllerPort: 7000, bridgeDllPath: "d:/OpenClaw/Develop/openclaw/extensions/abb-robot-control/src/ABBBridge.dll" }
);

const call = async (i, action, extra = {}) => {
  const r = await tool.execute(String(i), { action, ...extra });
  const text = r?.content?.[0]?.text ?? "";
  console.log(`STEP_${i}_${action}`, text.replace(/\s+/g, " "));
  return r;
};

const run = async () => {
  await call(1, "connect", { host: "127.0.0.1", port: 7000 });
  const logs = await call(2, "get_event_log", { categoryId: 0, limit: 15 });
  const analysis = await call(3, "analyze_logs", { categoryId: 0, limit: 20 });
  const diag = analysis?.details?.diagnosis;

  const ok =
    logs?.details?.success === true &&
    Array.isArray(logs?.details?.result?.entries) &&
    analysis?.details?.success === true &&
    Array.isArray(diag?.issues) &&
    Array.isArray(diag?.recommendations);

  if (ok) {
    console.log("ANALYZE_LOGS_OK", `issues=${diag.issues.length}`, `reco=${diag.recommendations.length}`);
  } else {
    console.log("ANALYZE_LOGS_FAIL");
  }
};

run().catch((err) => {
  console.log("ANALYZE_LOGS_FAIL_EXCEPTION", err?.message ?? String(err));
});
