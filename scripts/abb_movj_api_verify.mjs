import plugin from "../extensions/abb-robot-control/index.js";

let tool = null;
plugin.register(
  { registerTool: (t) => { tool = t; } },
  { defaultMode: "real", controllerHost: "127.0.0.1", controllerPort: 7000, defaultRobot: "abb-irb-120" }
);

const main = async () => {
  await tool.execute("1", { action: "connect", mode: "real", host: "127.0.0.1", port: 7000, robot_profile: "abb-irb-120" });
  const j = await tool.execute("2", { action: "get_joints", mode: "real" });
  const joints = j?.details?.result?.joints ?? [];
  const m = await tool.execute("3", {
    action: "movj",
    mode: "real",
    safety_confirmed: true,
    joints,
    speed: 8,
    zone: "fine",
  });
  const text = String(m?.content?.[0]?.text ?? "");
  if (/executed/i.test(text)) {
    console.log("VERIFY_MOVJ_API_OK");
  } else {
    console.log("VERIFY_MOVJ_API_FAIL", text.replace(/\s+/g, " "));
  }
};

main().catch((e) => {
  console.log("VERIFY_MOVJ_API_FAIL_EXCEPTION", e?.message ?? String(e));
});
