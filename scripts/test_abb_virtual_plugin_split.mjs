import plugin from "../extensions/abb-robot-virtual-control/index.js";

let tool;
plugin.register({ registerTool: (t) => { tool = t; } }, { wsBridgePort: 9877, defaultRobot: "abb-crb-15000" });

const run = async () => {
  const c = await tool.execute("1", { action: "connect", port: 9877, robot_id: "abb-crb-15000" });
  const s = await tool.execute("2", { action: "get_status" });
  const j = await tool.execute("3", { action: "get_joints" });
  const ok = c?.details?.connected === true && s?.details?.mode === "virtual";
  if (ok) {
    console.log("SPLIT_VIRTUAL_OK", j?.details?.joints?.length ?? 0);
  } else {
    console.log("SPLIT_VIRTUAL_FAIL", JSON.stringify({ c, s }));
  }
};

run().catch((err) => {
  console.log("SPLIT_VIRTUAL_FAIL_EXCEPTION", err?.message ?? String(err));
});
