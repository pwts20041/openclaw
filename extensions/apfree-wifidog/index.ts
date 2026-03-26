import type { OpenClawPluginApi, OpenClawPluginService } from "openclaw/plugin-sdk/plugin-entry";
import { createApFreeWifidogPluginConfigSchema, resolveApFreeWifidogConfig } from "./src/config.js";
import { ApFreeWifidogBridge } from "./src/manager.js";
import { createApFreeWifidogTools } from "./src/tool.js";

const plugin = {
  id: "apfree-wifidog",
  name: "ApFree WiFiDog",
  description: "Bridge apfree-wifidog devices into OpenClaw over WebSocket.",
  configSchema: (() => {
    const schema = createApFreeWifidogPluginConfigSchema();
    schema.uiHints = {
      enabled: { label: "Enable bridge" },
      bind: { label: "Bind address", advanced: true },
      port: { label: "Bridge port" },
      path: { label: "WebSocket path" },
      allowDeviceIds: {
        label: "Allowed device IDs",
        help: "Optional allowlist. Leave empty to accept any device_id.",
      },
      requestTimeoutMs: { label: "Default request timeout (ms)", advanced: true },
      maxPayloadBytes: { label: "Max payload bytes", advanced: true },
      awasEnabled: { label: "Enable AWAS auth proxy" },
      awasHost: { label: "AWAS server hostname" },
      awasPort: { label: "AWAS server port" },
      awasPath: { label: "AWAS WebSocket path" },
      awasSsl: { label: "Use TLS (wss://)", advanced: true },
    };
    return schema;
  })(),
  register(api: OpenClawPluginApi) {
    const config = resolveApFreeWifidogConfig(api.pluginConfig);
    const bridge = new ApFreeWifidogBridge({
      config,
      logger: api.logger,
    });

    const service: OpenClawPluginService = {
      id: "apfree-wifidog-bridge",
      async start() {
        await bridge.start();
      },
      async stop() {
        await bridge.stop();
      },
    };

    api.registerService(service);
    for (const tool of createApFreeWifidogTools({ bridge })) {
      api.registerTool(tool);
    }
  },
};

export default plugin;
