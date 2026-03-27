import plugin from "../extensions/abb-robot-real-control/index.js";

let tool;
plugin.register(
  { registerTool: (t) => { tool = t; } },
  { controllerHost: "127.0.0.1", controllerPort: 7000, bridgeDllPath: "d:/OpenClaw/Develop/openclaw/extensions/abb-robot-control/src/ABBBridge.dll" }
);

const run = async () => {
  await tool.execute("1", { action: "connect", host: "127.0.0.1", port: 7000 });
  const a = await tool.execute("2", {
    action: "analyze_logs",
    categoryId: 0,
    limit: 20,
    error_hint: "T_ROB1 MainModule 行3 错误",
  });
  const txt = a?.content?.[0]?.text ?? "";
  const ok = /semantic error/i.test(txt) || /RAPID semantic/i.test(txt);
  console.log(ok ? "ANALYZE_HINT_OK" : "ANALYZE_HINT_FAIL", txt.replace(/\s+/g, " "));
};

run().catch((err) => {
  console.log("ANALYZE_HINT_FAIL_EXCEPTION", err?.message ?? String(err));
});
