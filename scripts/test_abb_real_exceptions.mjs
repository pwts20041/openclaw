import plugin from "../extensions/abb-robot-real-control/index.js";

let tool;
plugin.register(
  { registerTool: (t) => { tool = t; } },
  { controllerHost: "127.0.0.1", controllerPort: 7000, bridgeDllPath: "d:/OpenClaw/Develop/openclaw/extensions/abb-robot-control/src/ABBBridge.dll" }
);

const run = async () => {
  const r1 = await tool.execute("1", { action: "get_status" });
  const t1 = r1?.content?.[0]?.text ?? "";
  console.log("EXC_1", t1.replace(/\s+/g, " "));

  const r2 = await tool.execute("2", { action: "connect", host: "127.0.0.2", port: 7000 });
  const t2 = r2?.content?.[0]?.text ?? "";
  console.log("EXC_2", t2.replace(/\s+/g, " "));

  const r3 = await tool.execute("3", { action: "connect", host: "127.0.0.1", port: 7000 });
  const t3 = r3?.content?.[0]?.text ?? "";
  console.log("EXC_3", t3.replace(/\s+/g, " "));

  const r4 = await tool.execute("4", { action: "movj", joints: [0, 1], speed: 10 });
  const t4 = r4?.content?.[0]?.text ?? "";
  console.log("EXC_4", t4.replace(/\s+/g, " "));

  const ok =
    /not connected|connect first/i.test(t1) &&
    /failed/i.test(t2) &&
    /connected/i.test(t3) &&
    /failed|requires/i.test(t4);

  console.log(ok ? "EXCEPTIONS_OK" : "EXCEPTIONS_FAIL");
};

run().catch((err) => {
  console.log("EXCEPTIONS_FAIL_EXCEPTION", err?.message ?? String(err));
});
