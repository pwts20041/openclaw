import plugin from "../extensions/abb-robot-control/index.js";

let tool = null;
plugin.register(
  { registerTool: (t) => { tool = t; } },
  { defaultMode: "real", controllerHost: "127.0.0.1", controllerPort: 7000, defaultRobot: "abb-irb-120" }
);

const main = async () => {
  const conn = await tool.execute("1", {
    action: "connect",
    mode: "real",
    host: "127.0.0.1",
    port: 7000,
    robot_profile: "abb-irb-120",
  });
  const status = await tool.execute("2", { action: "get_status", mode: "real" });
  const joints = await tool.execute("3", { action: "get_joints", mode: "real" });
  const robots = await tool.execute("4", { action: "list_robots", mode: "real" });

  const okConn = !!conn?.details?.connected;
  const okStatus = !!status?.details?.result?.success;
  const okJoints = Array.isArray(joints?.details?.result?.joints) && joints.details.result.joints.length >= 6;
  const hasIrb120 = Array.isArray(robots?.details?.robots) && robots.details.robots.includes("abb-irb-120");

  if (okConn && okStatus && okJoints && hasIrb120) {
    console.log("VERIFY_CONNECT_PROFILE_OK");
  } else {
    console.log("VERIFY_CONNECT_PROFILE_FAIL", JSON.stringify({
      okConn,
      okStatus,
      okJoints,
      hasIrb120,
      connText: conn?.content?.[0]?.text,
      statusText: status?.content?.[0]?.text,
      jointsText: joints?.content?.[0]?.text,
      robotsText: robots?.content?.[0]?.text,
    }));
  }
};

main().catch((e) => {
  console.log("VERIFY_CONNECT_PROFILE_FAIL_EXCEPTION", e?.message ?? String(e));
});
