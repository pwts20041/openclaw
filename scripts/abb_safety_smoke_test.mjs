import plugin from "../extensions/abb-robot-control/index.js";

let tool = null;
plugin.register(
  { registerTool: (t) => { tool = t; } },
  { defaultMode: "real", controllerHost: "127.0.0.1", controllerPort: 7000, wsBridgePort: 9877 }
);

function log(label, payload) {
  console.log(`--- ${label} ---`);
  console.log(JSON.stringify(payload, null, 2));
}

function extractJoints(result) {
  if (Array.isArray(result?.details?.result?.joints)) return result.details.result.joints;
  if (Array.isArray(result?.details?.joints)) return result.details.joints;
  return [];
}

const limits = [
  [-165, 165],
  [-110, 110],
  [-110, 70],
  [-160, 160],
  [-120, 120],
  [-400, 400],
];

async function main() {
  if (!tool) {
    console.log("RESULT:FAIL_NO_TOOL");
    process.exit(2);
  }

  const realConnect = await tool.execute("1", {
    action: "connect",
    mode: "real",
    host: "127.0.0.1",
    port: 7000,
  });
  log("real-connect", realConnect);

  const status = await tool.execute("2", { action: "get_status", mode: "real" });
  log("real-status", status);

  const jointsBeforeResult = await tool.execute("3", { action: "get_joints", mode: "real" });
  log("real-joints-before", jointsBeforeResult);
  const jointsBefore = extractJoints(jointsBeforeResult);
  if (!Array.isArray(jointsBefore) || jointsBefore.length < 6) {
    console.log("RESULT:FAIL_NO_JOINTS");
    process.exit(3);
  }

  const target = [...jointsBefore];
  target[0] = Math.max(limits[0][0], Math.min(limits[0][1], Number(jointsBefore[0] ?? 0) + 3));
  target[1] = Math.max(limits[1][0], Math.min(limits[1][1], Number(jointsBefore[1] ?? 0) + 2));

  const move = await tool.execute("4", {
    action: "movj",
    mode: "real",
    host: "127.0.0.1",
    port: 7000,
    safety_confirmed: true,
    joints: target,
    speed: 12,
  });
  log("real-movj", move);

  const jointsAfterResult = await tool.execute("5", { action: "get_joints", mode: "real" });
  log("real-joints-after", jointsAfterResult);
  const jointsAfter = extractJoints(jointsAfterResult);

  const d0 = Math.abs(Number(jointsAfter[0] ?? 0) - Number(jointsBefore[0] ?? 0));
  const d1 = Math.abs(Number(jointsAfter[1] ?? 0) - Number(jointsBefore[1] ?? 0));
  console.log("JOINT_DELTA", { d0, d1 });

  const virtualPrecheck = await tool.execute("6", {
    action: "movj",
    mode: "virtual",
    joints: [0, 0, 0, 0, 0, 0],
    speed: 20,
  });
  log("virtual-precheck", virtualPrecheck);

  const blockedBySafety = move?.details?.blockedBySafety === true;
  const hasText = Boolean(move?.content?.[0]?.text);
  if (blockedBySafety || !hasText) {
    console.log("RESULT:FAIL_REAL_MOVE");
    process.exit(4);
  }

  console.log("RESULT:OK");
}

main().catch((err) => {
  console.error("RESULT:FAIL_EXCEPTION", err?.message ?? String(err));
  process.exit(5);
});
