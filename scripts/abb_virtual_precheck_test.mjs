import plugin from "../extensions/abb-robot-control/index.js";

let tool = null;
plugin.register({ registerTool: (t) => { tool = t; } }, { wsBridgePort: 9877, defaultMode: "virtual" });

function log(name, obj) {
  console.log(`--- ${name} ---`);
  console.log(JSON.stringify(obj, null, 2));
}

const main = async () => {
  const c = await tool.execute("1", { action: "connect", mode: "virtual", host: "127.0.0.1", port: 9877 });
  log("virtual-connect", c);

  const s = await tool.execute("2", { action: "get_status", mode: "virtual" });
  log("virtual-status", s);

  const m = await tool.execute("3", { action: "movj", mode: "virtual", joints: [0, 0, 0, 0, 0, 0], speed: 20 });
  log("virtual-movj", m);

  console.log("RESULT:OK");
};

main().catch((e) => {
  console.error("RESULT:FAIL", e?.message ?? String(e));
  process.exit(1);
});
