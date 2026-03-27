import plugin from "../extensions/abb-robot-control/index.js";

let tool = null;
plugin.register(
  { registerTool: (t) => { tool = t; } },
  { defaultMode: "real", controllerHost: "127.0.0.1", controllerPort: 7000, defaultRobot: "abb-irb-120" }
);

function jointsFrom(r) {
  return r?.details?.result?.joints ?? r?.details?.joints ?? [];
}

const run = async () => {
  const c = await tool.execute("1", { action: "connect", mode: "real", host: "127.0.0.1", port: 7000, robot_profile: "abb-irb-120" });
  const s = await tool.execute("2", { action: "get_status", mode: "real" });
  const j0r = await tool.execute("3", { action: "get_joints", mode: "real" });
  const j0 = jointsFrom(j0r);

  if (!Array.isArray(j0) || j0.length < 6) {
    console.log("VERIFY_FAIL no_joints");
    return;
  }

  const target = [...j0];
  target[0] = Math.max(-165, Math.min(165, Number(j0[0]) + 1.5));
  target[1] = Math.max(-110, Math.min(110, Number(j0[1]) + 1.0));

  const m = await tool.execute("4", {
    action: "movj",
    mode: "real",
    safety_confirmed: true,
    joints: target,
    speed: 10,
    zone: "fine",
  });

  const j1r = await tool.execute("5", { action: "get_joints", mode: "real" });
  const j1 = jointsFrom(j1r);

  const d0 = Math.abs(Number(j1[0] ?? 0) - Number(j0[0] ?? 0));
  const d1 = Math.abs(Number(j1[1] ?? 0) - Number(j0[1] ?? 0));

  const connected = !!s?.details?.result?.success;
  const moved = d0 > 0.2 || d1 > 0.2;
  const moveOk = /executed/i.test(m?.content?.[0]?.text ?? "");

  if (connected && moveOk && moved) {
    console.log(`VERIFY_OK d0=${d0.toFixed(3)} d1=${d1.toFixed(3)}`);
  } else {
    console.log(`VERIFY_FAIL connected=${connected} moveOk=${moveOk} moved=${moved} msg=${(m?.content?.[0]?.text ?? "").replace(/\s+/g, " ")}`);
  }

  const cText = (c?.content?.[0]?.text ?? "").replace(/\s+/g, " ");
  console.log(`CONNECT_MSG ${cText}`);
};

run().catch((err) => {
  console.log("VERIFY_FAIL exception", err?.message ?? String(err));
});
