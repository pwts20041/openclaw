import { Type, type Static } from "@sinclair/typebox";
import { optionalStringEnum, stringEnum } from "openclaw/plugin-sdk/core";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import type { ApFreeWifidogBridge, DeviceSnapshot } from "./manager.js";

type JsonRecord = Record<string, unknown>;

function asObject(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function getClientsFromResponse(response: JsonRecord): unknown[] {
  if (Array.isArray(response.clients)) {
    return response.clients;
  }
  const data = asObject(response.data);
  return Array.isArray(data?.clients) ? data.clients : [];
}

const DeviceIdField = Type.String({
  minLength: 1,
  description: "Target apfree-wifidog device_id.",
});
const TimeoutField = Type.Optional(
  Type.Integer({
    minimum: 1000,
    maximum: 120_000,
    description: "Request timeout in milliseconds.",
  }),
);

const GenericToolSchema = Type.Object(
  {
    action: stringEnum(["list_devices", "get_device", "call"] as const, {
      description: "Action to perform: list_devices, get_device, or call.",
    }),
    deviceId: Type.Optional(DeviceIdField),
    op: Type.Optional(
      Type.String({ minLength: 1, description: "Exact apfree-wifidog operation name." }),
    ),
    payload: Type.Optional(
      Type.Record(Type.String(), Type.Unknown(), {
        description: "Additional JSON fields to include with the device request.",
      }),
    ),
    timeoutMs: TimeoutField,
    expectResponse: Type.Optional(
      Type.Boolean({ description: "Override whether the request waits for a response." }),
    ),
  },
  { additionalProperties: false },
);

const DeviceOnlySchema = Type.Object(
  {
    deviceId: DeviceIdField,
    timeoutMs: TimeoutField,
  },
  { additionalProperties: false },
);

const ClientInfoSchema = Type.Object(
  {
    deviceId: DeviceIdField,
    clientMac: Type.String({ minLength: 1, description: "Client MAC address." }),
    timeoutMs: TimeoutField,
  },
  { additionalProperties: false },
);

const KickoffClientSchema = Type.Object(
  {
    deviceId: DeviceIdField,
    clientMac: Type.String({ minLength: 1, description: "Client MAC address to disconnect." }),
    clientIp: Type.Optional(
      Type.String({ minLength: 1, description: "Client IPv4 address if already known." }),
    ),
    gwId: Type.Optional(Type.String({ minLength: 1, description: "Gateway ID if already known." })),
    timeoutMs: TimeoutField,
  },
  { additionalProperties: false },
);

const WifiConfigDataField = Type.Object(
  {
    ssid: Type.Optional(
      Type.String({ minLength: 1, description: "Wi-Fi SSID (network name) to set." }),
    ),
    radio: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Radio interface name (e.g., 'radio0', 'radio1').",
      }),
    ),
    interface: Type.Optional(
      Type.String({ minLength: 1, description: "Wireless interface name (e.g., 'wifnet0')." }),
    ),
    encryption: Type.Optional(
      Type.String({ description: "Encryption type (e.g., 'psk2', 'none')." }),
    ),
    key: Type.Optional(Type.String({ description: "Wi-Fi password/key." })),
    hidden: Type.Optional(Type.Boolean({ description: "Whether to hide the SSID." })),
  },
  { additionalProperties: true, description: "Wi-Fi configuration fields to update." },
);

const SetWifiInfoSchema = Type.Object(
  {
    deviceId: DeviceIdField,
    data: WifiConfigDataField,
    timeoutMs: TimeoutField,
  },
  { additionalProperties: false },
);

const SetAuthServerSchema = Type.Object(
  {
    deviceId: DeviceIdField,
    hostname: Type.String({ minLength: 1, description: "Authentication server hostname." }),
    port: Type.Optional(Type.String({ minLength: 1, description: "Authentication server port." })),
    path: Type.Optional(Type.String({ minLength: 1, description: "Authentication server path." })),
    timeoutMs: TimeoutField,
  },
  { additionalProperties: false },
);

const SetMqttServerSchema = Type.Object(
  {
    deviceId: DeviceIdField,
    hostname: Type.Optional(Type.String({ minLength: 1, description: "MQTT server hostname." })),
    port: Type.Optional(Type.String({ minLength: 1, description: "MQTT server port." })),
    username: Type.Optional(Type.String({ minLength: 1, description: "MQTT username." })),
    password: Type.Optional(Type.String({ minLength: 1, description: "MQTT password." })),
    useSsl: Type.Optional(Type.Boolean({ description: "Whether to enable MQTT TLS/SSL." })),
    timeoutMs: TimeoutField,
  },
  { additionalProperties: false },
);

const SetWebsocketServerSchema = Type.Object(
  {
    deviceId: DeviceIdField,
    hostname: Type.Optional(
      Type.String({ minLength: 1, description: "WebSocket server hostname." }),
    ),
    port: Type.Optional(Type.String({ minLength: 1, description: "WebSocket server port." })),
    path: Type.Optional(Type.String({ minLength: 1, description: "WebSocket path (e.g., /ws)." })),
    useSsl: Type.Optional(Type.Boolean({ description: "Whether to enable WSS." })),
    timeoutMs: TimeoutField,
  },
  { additionalProperties: false },
);
const JsonObjectField = Type.Record(Type.String(), Type.Unknown(), {
  description: "Arbitrary JSON object payload.",
});

const StringArrayField = Type.Array(Type.String({ minLength: 1 }));
const BandField = optionalStringEnum(["2g", "5g"] as const, {
  description: "Wi-Fi band to scan: 2g or 5g.",
});
const BpfTableField = stringEnum(["ipv4", "ipv6", "mac"] as const, {
  description: "BPF table to target: ipv4, ipv6, or mac.",
});
const BpfJsonTableField = stringEnum(["ipv4", "ipv6", "mac", "sid", "l7"] as const, {
  description: "BPF JSON table to query: ipv4, ipv6, mac, sid, or l7.",
});

const UpdateDeviceInfoSchema = Type.Object(
  {
    deviceId: DeviceIdField,
    deviceInfo: JsonObjectField,
    timeoutMs: TimeoutField,
  },
  { additionalProperties: false },
);

const TmpPassSchema = Type.Object(
  {
    deviceId: DeviceIdField,
    clientMac: Type.String({
      minLength: 1,
      description: "Client MAC address to temporarily allow.",
    }),
    timeout: Type.Optional(
      Type.Integer({ minimum: 1, description: "Temporary allow duration in seconds." }),
    ),
    timeoutMs: TimeoutField,
  },
  { additionalProperties: false },
);

const ScanWifiSchema = Type.Object(
  {
    deviceId: DeviceIdField,
    band: BandField,
    timeoutMs: TimeoutField,
  },
  { additionalProperties: false },
);

const SetWifiRelaySchema = Type.Object(
  {
    deviceId: DeviceIdField,
    ssid: Type.String({ minLength: 1 }),
    key: Type.Optional(Type.String()),
    band: BandField,
    encryption: Type.Optional(Type.String()),
    bssid: Type.Optional(Type.String()),
    apply: Type.Optional(Type.Boolean()),
    timeoutMs: TimeoutField,
  },
  { additionalProperties: false },
);

const DomainSyncSchema = Type.Object(
  {
    deviceId: DeviceIdField,
    domains: StringArrayField,
    timeoutMs: TimeoutField,
  },
  { additionalProperties: false },
);

const TrustedMacSyncSchema = Type.Object(
  {
    deviceId: DeviceIdField,
    macs: StringArrayField,
    values: Type.Optional(StringArrayField),
    timeoutMs: TimeoutField,
  },
  { additionalProperties: false },
);

const ShellCommandSchema = Type.Object(
  {
    deviceId: DeviceIdField,
    command: Type.String({ minLength: 1, maxLength: 4096 }),
    timeoutSeconds: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 120,
        description: "Device-side shell execution timeout in seconds.",
      }),
    ),
    timeoutMs: TimeoutField,
  },
  { additionalProperties: false },
);

const BpfAddSchema = Type.Object(
  {
    deviceId: DeviceIdField,
    table: Type.Optional(BpfTableField),
    address: Type.String({
      minLength: 1,
      description: "IPv4, IPv6, or MAC target to add to BPF monitoring.",
    }),
    timeoutMs: TimeoutField,
  },
  { additionalProperties: false },
);

const BpfJsonSchema = Type.Object(
  {
    deviceId: DeviceIdField,
    table: Type.Optional(BpfJsonTableField),
    timeoutMs: TimeoutField,
  },
  { additionalProperties: false },
);

const BpfDeleteSchema = Type.Object(
  {
    deviceId: DeviceIdField,
    table: Type.Optional(BpfTableField),
    address: Type.String({
      minLength: 1,
      description: "IPv4, IPv6, or MAC target to remove from BPF monitoring.",
    }),
    timeoutMs: TimeoutField,
  },
  { additionalProperties: false },
);

const BpfFlushSchema = Type.Object(
  {
    deviceId: DeviceIdField,
    table: Type.Optional(BpfTableField),
    timeoutMs: TimeoutField,
  },
  { additionalProperties: false },
);

const BpfUpdateSchema = Type.Object(
  {
    deviceId: DeviceIdField,
    table: Type.Optional(BpfTableField),
    target: Type.String({
      minLength: 1,
      description: "IPv4, IPv6, or MAC target whose rate limits will be updated.",
    }),
    downrate: Type.Integer({
      minimum: 1,
      maximum: 10_000_000_000,
      description: "Download rate limit in bps.",
    }),
    uprate: Type.Integer({
      minimum: 1,
      maximum: 10_000_000_000,
      description: "Upload rate limit in bps.",
    }),
    timeoutMs: TimeoutField,
  },
  { additionalProperties: false },
);

const BpfUpdateAllSchema = Type.Object(
  {
    deviceId: DeviceIdField,
    table: Type.Optional(BpfTableField),
    downrate: Type.Integer({
      minimum: 1,
      maximum: 10_000_000_000,
      description: "Download rate limit in bps for all entries in the table.",
    }),
    uprate: Type.Integer({
      minimum: 1,
      maximum: 10_000_000_000,
      description: "Upload rate limit in bps for all entries in the table.",
    }),
    timeoutMs: TimeoutField,
  },
  { additionalProperties: false },
);

type GenericToolParams = Static<typeof GenericToolSchema>;
type DeviceOnlyParams = Static<typeof DeviceOnlySchema>;
type ClientInfoParams = Static<typeof ClientInfoSchema>;
type KickoffClientParams = Static<typeof KickoffClientSchema>;
type UpdateDeviceInfoParams = Static<typeof UpdateDeviceInfoSchema>;
type SetAuthServerParams = Static<typeof SetAuthServerSchema>;
type SetMqttServerParams = Static<typeof SetMqttServerSchema>;
type SetWebsocketServerParams = Static<typeof SetWebsocketServerSchema>;
type TmpPassParams = Static<typeof TmpPassSchema>;
type SetWifiInfoParams = Static<typeof SetWifiInfoSchema>;
type ScanWifiParams = Static<typeof ScanWifiSchema>;
type SetWifiRelayParams = Static<typeof SetWifiRelaySchema>;
type DomainSyncParams = Static<typeof DomainSyncSchema>;
type TrustedMacSyncParams = Static<typeof TrustedMacSyncSchema>;
type ShellCommandParams = Static<typeof ShellCommandSchema>;
type BpfAddParams = Static<typeof BpfAddSchema>;
type BpfJsonParams = Static<typeof BpfJsonSchema>;
type BpfDeleteParams = Static<typeof BpfDeleteSchema>;
type BpfFlushParams = Static<typeof BpfFlushSchema>;
type BpfUpdateParams = Static<typeof BpfUpdateSchema>;
type BpfUpdateAllParams = Static<typeof BpfUpdateAllSchema>;

type BpfJsonTable = "ipv4" | "ipv6" | "mac" | "sid" | "l7";

function normalizeMac(input: string): string {
  return input.trim().toUpperCase().replace(/-/g, ":");
}

function normalizeBpfAddress(table: "ipv4" | "ipv6" | "mac", address: string): string {
  const trimmed = address.trim();
  if (table === "mac") {
    return normalizeMac(trimmed).toLowerCase();
  }
  return trimmed;
}

function summarizeBpfJsonResponse(
  response: JsonRecord,
  table: BpfJsonTable,
  deviceId: string,
): string {
  const data = response.data;
  const count = Array.isArray(data)
    ? data.length
    : data && typeof data === "object"
      ? Object.keys(data as JsonRecord).length
      : 0;
  return `Fetched ${table} BPF stats for ${deviceId}${count > 0 ? ` (${count} entries)` : ""}.`;
}

function ensureDevice(bridge: ApFreeWifidogBridge, deviceId: string): DeviceSnapshot {
  const device = bridge.getDevice(deviceId);
  if (!device) {
    throw new Error(`device not connected: ${deviceId}`);
  }
  return device;
}

function getSingleGatewayId(device: DeviceSnapshot): string | undefined {
  const gateways = Array.isArray(device.gateway) ? device.gateway : [];
  if (gateways.length !== 1) {
    return undefined;
  }
  const gateway = gateways[0];
  if (!gateway || typeof gateway !== "object" || Array.isArray(gateway)) {
    return undefined;
  }
  const gwId = (gateway as JsonRecord).gw_id;
  return typeof gwId === "string" && gwId.trim() ? gwId.trim() : undefined;
}

async function callDeviceOp(params: {
  bridge: ApFreeWifidogBridge;
  deviceId: string;
  op: string;
  payload?: JsonRecord;
  timeoutMs?: number;
  expectResponse?: boolean;
}) {
  return await params.bridge.callDevice({
    deviceId: params.deviceId,
    op: params.op,
    payload: params.payload,
    timeoutMs: params.timeoutMs,
    expectResponse: params.expectResponse,
  });
}

async function lookupClientByMac(params: {
  bridge: ApFreeWifidogBridge;
  deviceId: string;
  clientMac: string;
  timeoutMs?: number;
}): Promise<JsonRecord | null> {
  const response = await callDeviceOp({
    bridge: params.bridge,
    deviceId: params.deviceId,
    op: "get_clients",
    timeoutMs: params.timeoutMs,
  });
  const clients = getClientsFromResponse(response);
  const normalized = normalizeMac(params.clientMac);
  const found = clients.find((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return false;
    }
    const mac = (entry as JsonRecord).mac;
    return typeof mac === "string" && normalizeMac(mac) === normalized;
  });
  return found && typeof found === "object" && !Array.isArray(found) ? (found as JsonRecord) : null;
}

function buildToolResult(text: string, details: JsonRecord) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

function createSimpleOperationTool(params: {
  bridge: ApFreeWifidogBridge;
  name: string;
  label: string;
  description: string;
  op: string;
  parameters?: AnyAgentTool["parameters"];
  expectResponse?: boolean;
  buildPayload?: (rawParams: unknown) => {
    deviceId: string;
    payload?: JsonRecord;
    timeoutMs?: number;
    expectResponse?: boolean;
  };
  summarize?: (response: JsonRecord, rawParams: unknown) => string;
}): AnyAgentTool {
  return {
    name: params.name,
    label: params.label,
    description: params.description,
    parameters: params.parameters ?? DeviceOnlySchema,
    execute: async (_toolCallId, rawParams) => {
      const fallbackArgs = rawParams as DeviceOnlyParams;
      const built = params.buildPayload?.(rawParams) ?? {
        deviceId: fallbackArgs.deviceId ? fallbackArgs.deviceId.trim() : "",
        timeoutMs: fallbackArgs.timeoutMs,
      };
      try {
        const response = await callDeviceOp({
          bridge: params.bridge,
          deviceId: built.deviceId,
          op: params.op,
          payload: built.payload,
          timeoutMs: built.timeoutMs,
          expectResponse: built.expectResponse ?? params.expectResponse,
        });
        const summary =
          params.summarize?.(response, rawParams) ??
          `Device ${built.deviceId} responded to ${params.op}.`;
        const responseJson = JSON.stringify(response);
        const text = `${summary}\n\nDevice response data:\n${responseJson}`;
        return buildToolResult(text, { response });
      } catch (error) {
        throw error;
      }
    },
  };
}

function createGenericTool(bridge: ApFreeWifidogBridge): AnyAgentTool {
  return {
    name: "apfree_wifidog",
    label: "ApFree WiFiDog",
    description:
      "Low-level fallback tool for apfree-wifidog. Prefer the more specific apfree_wifidog_* tools when they match the user intent.",
    parameters: GenericToolSchema,
    execute: async (_toolCallId, rawParams) => {
      const toolParams = rawParams as GenericToolParams;
      if (toolParams.action === "list_devices") {
        const devices = bridge.listDevices();
        return buildToolResult(`Connected devices: ${devices.length}`, { devices });
      }

      const deviceId = toolParams.deviceId?.trim();
      if (!deviceId) {
        throw new Error("deviceId required");
      }

      if (toolParams.action === "get_device") {
        const device = ensureDevice(bridge, deviceId);
        return buildToolResult(`Device ${deviceId} is connected.`, { device });
      }

      const op = toolParams.op?.trim();
      if (!op) {
        throw new Error("op required for action=call");
      }

      const response = await callDeviceOp({
        bridge,
        deviceId,
        op,
        payload: toolParams.payload,
        timeoutMs: toolParams.timeoutMs,
        expectResponse: toolParams.expectResponse,
      });

      return buildToolResult(`Device ${deviceId} responded to ${op}.`, { response });
    },
  };
}

function createListDevicesTool(bridge: ApFreeWifidogBridge): AnyAgentTool {
  return {
    name: "apfree_wifidog_list_devices",
    label: "ApFree WiFiDog Devices",
    description: "List all currently connected apfree-wifidog devices.",
    parameters: Type.Object(
      {
        dummy_field: Type.Optional(
          Type.String({
            description: "Ignore this field. It exists to prevent empty parameter objects.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async () => {
      const devices = bridge.listDevices();

      const deviceStrings = devices.map((d) => `${d.alias} (ID: ${d.deviceId})`).join(", ");
      const textOutput = `Connected devices: ${devices.length}${devices.length > 0 ? `. Devices: ${deviceStrings}` : ""}`;

      return buildToolResult(textOutput, { devices });
    },
  };
}

function createGetDeviceTool(bridge: ApFreeWifidogBridge): AnyAgentTool {
  return {
    name: "apfree_wifidog_get_device",
    label: "ApFree WiFiDog Device",
    description: "Get the current connection snapshot for one connected apfree-wifidog device.",
    parameters: Type.Object({ deviceId: DeviceIdField }, { additionalProperties: false }),
    execute: async (_toolCallId, rawParams) => {
      const args = rawParams as { deviceId: string };
      const device = ensureDevice(bridge, args.deviceId.trim());
      return buildToolResult(`Device ${device.deviceId} is connected.`, { device });
    },
  };
}

export function createApFreeWifidogTools(params: { bridge: ApFreeWifidogBridge }): AnyAgentTool[] {
  const { bridge } = params;

  return [
    createListDevicesTool(bridge),
    createGetDeviceTool(bridge),
    createSimpleOperationTool({
      bridge,
      name: "apfree_wifidog_get_status",
      label: "ApFree WiFiDog Status",
      description: "Get a router's current apfree-wifidog status and runtime health summary.",
      op: "get_status",
      summarize: (_response, rawParams) => {
        const args = rawParams as DeviceOnlyParams;
        return `Fetched status for device ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "apfree_wifidog_get_sys_info",
      label: "ApFree WiFiDog System Info",
      description: "Get router system information, resource usage, and platform details.",
      op: "get_sys_info",
      summarize: (_response, rawParams) => {
        const args = rawParams as DeviceOnlyParams;
        return `Fetched system info for ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "apfree_wifidog_get_device_info",
      label: "ApFree WiFiDog Device Info",
      description: "Get the configured device metadata for a router.",
      op: "get_device_info",
      summarize: (_response, rawParams) => {
        const args = rawParams as DeviceOnlyParams;
        return `Fetched device info for ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "apfree_wifidog_update_device_info",
      label: "ApFree WiFiDog Update Device Info",
      description: "Update device metadata such as site, label, location, or custom fields.",
      op: "update_device_info",
      parameters: UpdateDeviceInfoSchema,
      buildPayload: (rawParams) => {
        const args = rawParams as UpdateDeviceInfoParams;
        return {
          deviceId: args.deviceId.trim(),
          payload: { device_info: args.deviceInfo },
          timeoutMs: args.timeoutMs,
        };
      },
      summarize: (_response, rawParams) => {
        const args = rawParams as UpdateDeviceInfoParams;
        return `Updated device info for ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "apfree_wifidog_get_clients",
      label: "ApFree WiFiDog Clients",
      description: "List currently authenticated clients on a router.",
      op: "get_clients",
      summarize: (response, rawParams) => {
        const args = rawParams as DeviceOnlyParams;
        const count = getClientsFromResponse(response).length;
        return `Fetched ${count} clients from ${args.deviceId}.`;
      },
    }),
    {
      name: "apfree_wifidog_get_client_info",
      label: "ApFree WiFiDog Client Info",
      description: "Get detailed information for one authenticated client by MAC address.",
      parameters: ClientInfoSchema,
      execute: async (_toolCallId, rawParams) => {
        const args = rawParams as ClientInfoParams;
        const normalizedMac = normalizeMac(args.clientMac);
        const response = await callDeviceOp({
          bridge,
          deviceId: args.deviceId.trim(),
          op: "get_client_info",
          payload: { mac: normalizedMac },
          timeoutMs: args.timeoutMs,
        });
        return buildToolResult(`Fetched client info for ${normalizedMac} on ${args.deviceId}.`, {
          response,
        });
      },
    },
    {
      name: "apfree_wifidog_kickoff_client",
      label: "ApFree WiFiDog Kickoff Client",
      description:
        "Disconnect an authenticated client by MAC address. If client IP is omitted, the tool looks it up from get_clients. If the router has exactly one gateway, gwId is inferred automatically.",
      parameters: KickoffClientSchema,
      execute: async (_toolCallId, rawParams) => {
        const args = rawParams as KickoffClientParams;
        const deviceId = args.deviceId.trim();
        const device = ensureDevice(bridge, deviceId);
        const clientMac = normalizeMac(args.clientMac);
        const explicitClientIp = args.clientIp?.trim();
        const client = explicitClientIp
          ? null
          : await lookupClientByMac({
              bridge,
              deviceId,
              clientMac,
              timeoutMs: args.timeoutMs,
            });
        const resolvedClientMac =
          typeof client?.mac === "string" && client.mac.trim() ? client.mac.trim() : clientMac;
        const clientIp =
          explicitClientIp ||
          (typeof client?.ip === "string" && client.ip.trim() ? client.ip.trim() : undefined);
        if (!clientIp) {
          throw new Error(`client IP not found for ${clientMac}; provide clientIp explicitly`);
        }
        const gwId = args.gwId?.trim() || getSingleGatewayId(device);
        if (!gwId) {
          throw new Error("gwId required when the device has multiple gateways");
        }
        const response = await callDeviceOp({
          bridge,
          deviceId,
          op: "kickoff",
          payload: {
            client_ip: clientIp,
            client_mac: resolvedClientMac,
            gw_id: gwId,
          },
          timeoutMs: args.timeoutMs,
        });
        return buildToolResult(`Kickoff requested for ${clientMac} on ${deviceId}.`, {
          response,
          resolved: { clientIp, gwId, clientMac: resolvedClientMac },
        });
      },
    },
    createSimpleOperationTool({
      bridge,
      name: "apfree_wifidog_tmp_pass",
      label: "ApFree WiFiDog Temporary Pass",
      description: "Temporarily allow one client MAC to bypass captive portal authentication.",
      op: "tmp_pass",
      parameters: TmpPassSchema,
      buildPayload: (rawParams) => {
        const args = rawParams as TmpPassParams;
        const payload: JsonRecord = {
          client_mac: normalizeMac(args.clientMac).toLowerCase(),
        };
        if (typeof args.timeout === "number") {
          payload.timeout = args.timeout;
        }
        return {
          deviceId: args.deviceId.trim(),
          payload,
          timeoutMs: args.timeoutMs,
          expectResponse: true,
        };
      },
      summarize: (_response, rawParams) => {
        const args = rawParams as TmpPassParams;
        return `Temporary pass requested for ${normalizeMac(args.clientMac)} on ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "apfree_wifidog_get_wifi_info",
      label: "ApFree WiFiDog WiFi Info",
      description: "Get the router's Wi-Fi and radio configuration.",
      op: "get_wifi_info",
      summarize: (_response, rawParams) => {
        const args = rawParams as DeviceOnlyParams;
        return `Fetched Wi-Fi info for ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "apfree_wifidog_set_wifi_info",
      label: "ApFree WiFiDog Set WiFi Info",
      description:
        "Update Wi-Fi configuration on the router, such as changing SSID (network name), password, encryption type, or hiding the network. Use this tool when the user asks to modify, change, or update Wi-Fi settings including SSID.",
      op: "set_wifi_info",
      parameters: SetWifiInfoSchema,
      buildPayload: (rawParams) => {
        const args = rawParams as SetWifiInfoParams;
        return {
          deviceId: args.deviceId.trim(),
          payload: { data: args.data },
          timeoutMs: args.timeoutMs,
        };
      },
      summarize: (_response, rawParams) => {
        const args = rawParams as SetWifiInfoParams;
        return `Applied Wi-Fi config changes to ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "apfree_wifidog_scan_wifi",
      label: "ApFree WiFiDog Scan WiFi",
      description: "Scan nearby Wi-Fi networks, optionally filtered to 2.4 GHz or 5 GHz.",
      op: "scan_wifi",
      parameters: ScanWifiSchema,
      buildPayload: (rawParams) => {
        const args = rawParams as ScanWifiParams;
        return {
          deviceId: args.deviceId.trim(),
          payload: args.band ? { band: args.band } : undefined,
          timeoutMs: args.timeoutMs,
        };
      },
      summarize: (_response, rawParams) => {
        const args = rawParams as ScanWifiParams;
        return `Completed Wi-Fi scan for ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "apfree_wifidog_set_wifi_relay",
      label: "ApFree WiFiDog Set WiFi Relay",
      description: "Configure the router to join an upstream Wi-Fi as relay/STA.",
      op: "set_wifi_relay",
      parameters: SetWifiRelaySchema,
      buildPayload: (rawParams) => {
        const args = rawParams as SetWifiRelayParams;
        const payload: JsonRecord = { ssid: args.ssid };
        if (typeof args.key === "string") payload.key = args.key;
        if (typeof args.band === "string") payload.band = args.band;
        if (typeof args.encryption === "string") payload.encryption = args.encryption;
        if (typeof args.bssid === "string") payload.bssid = args.bssid;
        if (typeof args.apply === "boolean") payload.apply = args.apply;
        return {
          deviceId: args.deviceId.trim(),
          payload,
          timeoutMs: args.timeoutMs,
        };
      },
      summarize: (_response, rawParams) => {
        const args = rawParams as SetWifiRelayParams;
        return `Configured Wi-Fi relay for ${args.deviceId} using SSID ${args.ssid}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "apfree_wifidog_bpf_add",
      label: "ApFree WiFiDog BPF Add",
      description: "Add an IPv4, IPv6, or MAC target to the device's BPF traffic monitoring table.",
      op: "bpf_add",
      parameters: BpfAddSchema,
      buildPayload: (rawParams) => {
        const args = rawParams as BpfAddParams;
        const table = args.table ?? "mac";
        return {
          deviceId: args.deviceId.trim(),
          payload: {
            table,
            address: normalizeBpfAddress(table, args.address),
          },
          timeoutMs: args.timeoutMs,
        };
      },
      summarize: (_response, rawParams) => {
        const args = rawParams as BpfAddParams;
        const table = args.table ?? "mac";
        return `Added ${args.address} to the ${table} BPF monitor table on ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "apfree_wifidog_bpf_json",
      label: "ApFree WiFiDog BPF Stats",
      description:
        "Query BPF traffic monitoring statistics for one table (`ipv4`, `ipv6`, `mac`, `sid`, or `l7`).",
      op: "bpf_json",
      parameters: BpfJsonSchema,
      buildPayload: (rawParams) => {
        const args = rawParams as BpfJsonParams;
        const table = (args.table ?? "mac") as BpfJsonTable;
        return {
          deviceId: args.deviceId.trim(),
          payload: {
            table,
          },
          timeoutMs: args.timeoutMs ?? 30_000,
        };
      },
      summarize: (response, rawParams) => {
        const args = rawParams as BpfJsonParams;
        const table = (args.table ?? "mac") as BpfJsonTable;
        return summarizeBpfJsonResponse(response, table, args.deviceId);
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "apfree_wifidog_get_l7_active_stats",
      label: "ApFree WiFiDog L7 Active Stats",
      description:
        "Get active L7 protocol traffic speed and volume statistics (SID view) for the current device.",
      op: "bpf_json",
      parameters: DeviceOnlySchema,
      buildPayload: (rawParams) => {
        const args = rawParams as DeviceOnlyParams;
        return {
          deviceId: args.deviceId.trim(),
          payload: { table: "sid" },
          timeoutMs: args.timeoutMs ?? 30_000,
        };
      },
      summarize: (response, rawParams) => {
        const args = rawParams as DeviceOnlyParams;
        return summarizeBpfJsonResponse(response, "sid", args.deviceId);
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "apfree_wifidog_get_l7_protocol_catalog",
      label: "ApFree WiFiDog L7 Protocol Catalog",
      description:
        "List the L7 protocol library currently supported by the device, including domain signatures when available.",
      op: "bpf_json",
      parameters: DeviceOnlySchema,
      buildPayload: (rawParams) => {
        const args = rawParams as DeviceOnlyParams;
        return {
          deviceId: args.deviceId.trim(),
          payload: { table: "l7" },
          timeoutMs: args.timeoutMs ?? 30_000,
        };
      },
      summarize: (response, rawParams) => {
        const args = rawParams as DeviceOnlyParams;
        return summarizeBpfJsonResponse(response, "l7", args.deviceId);
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "apfree_wifidog_bpf_del",
      label: "ApFree WiFiDog BPF Delete",
      description:
        "Remove an IPv4, IPv6, or MAC target from the device's BPF traffic monitoring table.",
      op: "bpf_del",
      parameters: BpfDeleteSchema,
      buildPayload: (rawParams) => {
        const args = rawParams as BpfDeleteParams;
        const table = args.table ?? "mac";
        return {
          deviceId: args.deviceId.trim(),
          payload: {
            table,
            address: normalizeBpfAddress(table, args.address),
          },
          timeoutMs: args.timeoutMs,
        };
      },
      summarize: (_response, rawParams) => {
        const args = rawParams as BpfDeleteParams;
        const table = args.table ?? "mac";
        return `Removed ${args.address} from the ${table} BPF monitor table on ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "apfree_wifidog_bpf_flush",
      label: "ApFree WiFiDog BPF Flush",
      description: "Clear all entries from one BPF monitoring table.",
      op: "bpf_flush",
      parameters: BpfFlushSchema,
      buildPayload: (rawParams) => {
        const args = rawParams as BpfFlushParams;
        return {
          deviceId: args.deviceId.trim(),
          payload: {
            table: args.table ?? "mac",
          },
          timeoutMs: args.timeoutMs,
        };
      },
      summarize: (_response, rawParams) => {
        const args = rawParams as BpfFlushParams;
        const table = args.table ?? "mac";
        return `Flushed ${table} BPF monitor table on ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "apfree_wifidog_bpf_update",
      label: "ApFree WiFiDog BPF Update",
      description: "Update downrate/uprate limits for one BPF monitored target.",
      op: "bpf_update",
      parameters: BpfUpdateSchema,
      buildPayload: (rawParams) => {
        const args = rawParams as BpfUpdateParams;
        const table = args.table ?? "mac";
        return {
          deviceId: args.deviceId.trim(),
          payload: {
            table,
            target: normalizeBpfAddress(table, args.target),
            downrate: args.downrate,
            uprate: args.uprate,
          },
          timeoutMs: args.timeoutMs,
        };
      },
      summarize: (_response, rawParams) => {
        const args = rawParams as BpfUpdateParams;
        const table = args.table ?? "mac";
        return `Updated ${table} BPF rate limits for ${args.target} on ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "apfree_wifidog_bpf_update_all",
      label: "ApFree WiFiDog BPF Update All",
      description: "Update downrate/uprate limits for all entries in one BPF table.",
      op: "bpf_update_all",
      parameters: BpfUpdateAllSchema,
      buildPayload: (rawParams) => {
        const args = rawParams as BpfUpdateAllParams;
        return {
          deviceId: args.deviceId.trim(),
          payload: {
            table: args.table ?? "mac",
            downrate: args.downrate,
            uprate: args.uprate,
          },
          timeoutMs: args.timeoutMs,
        };
      },
      summarize: (_response, rawParams) => {
        const args = rawParams as BpfUpdateAllParams;
        const table = args.table ?? "mac";
        return `Updated ${table} BPF rate limits for all monitored entries on ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "apfree_wifidog_get_trusted_domains",
      label: "ApFree WiFiDog Trusted Domains",
      description: "Get the trusted domain whitelist for captive portal bypass.",
      op: "get_trusted_domains",
      summarize: (_response, rawParams) => {
        const args = rawParams as DeviceOnlyParams;
        return `Fetched trusted domains for ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "apfree_wifidog_sync_trusted_domains",
      label: "ApFree WiFiDog Sync Trusted Domains",
      description: "Replace the trusted domain whitelist with the provided full domain list.",
      op: "sync_trusted_domain",
      parameters: DomainSyncSchema,
      buildPayload: (rawParams) => {
        const args = rawParams as DomainSyncParams;
        return {
          deviceId: args.deviceId.trim(),
          payload: { domains: args.domains },
          timeoutMs: args.timeoutMs,
        };
      },
      summarize: (_response, rawParams) => {
        const args = rawParams as DomainSyncParams;
        return `Synced ${args.domains.length} trusted domains on ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "apfree_wifidog_get_trusted_wildcard_domains",
      label: "ApFree WiFiDog Trusted Wildcard Domains",
      description: "Get the trusted wildcard domain whitelist such as *.example.com.",
      op: "get_trusted_wildcard_domains",
      summarize: (_response, rawParams) => {
        const args = rawParams as DeviceOnlyParams;
        return `Fetched trusted wildcard domains for ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "apfree_wifidog_sync_trusted_wildcard_domains",
      label: "ApFree WiFiDog Sync Trusted Wildcard Domains",
      description: "Replace the trusted wildcard domain whitelist with the provided full list.",
      op: "sync_trusted_wildcard_domains",
      parameters: DomainSyncSchema,
      buildPayload: (rawParams) => {
        const args = rawParams as DomainSyncParams;
        return {
          deviceId: args.deviceId.trim(),
          payload: { domains: args.domains },
          timeoutMs: args.timeoutMs,
        };
      },
      summarize: (_response, rawParams) => {
        const args = rawParams as DomainSyncParams;
        return `Synced ${args.domains.length} trusted wildcard domains on ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "apfree_wifidog_get_trusted_mac",
      label: "ApFree WiFiDog Trusted MACs",
      description: "Get the trusted MAC whitelist.",
      op: "get_trusted_mac",
      summarize: (_response, rawParams) => {
        const args = rawParams as DeviceOnlyParams;
        return `Fetched trusted MACs for ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "apfree_wifidog_sync_trusted_mac",
      label: "ApFree WiFiDog Sync Trusted MACs",
      description: "Replace the trusted MAC whitelist with the provided full MAC list.",
      op: "sync_trusted_mac",
      parameters: TrustedMacSyncSchema,
      buildPayload: (rawParams) => {
        const args = rawParams as TrustedMacSyncParams;
        const macs = args.macs.map((value) => normalizeMac(value).toLowerCase());
        return {
          deviceId: args.deviceId.trim(),
          payload: {
            macs,
            values: args.values ?? Array(macs.length).fill("1"),
          },
          timeoutMs: args.timeoutMs,
        };
      },
      summarize: (_response, rawParams) => {
        const args = rawParams as TrustedMacSyncParams;
        return `Synced ${args.macs.length} trusted MACs on ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "apfree_wifidog_get_auth_serv",
      label: "ApFree WiFiDog Get Auth Server",
      description: "Get the current captive portal authentication server configuration.",
      op: "get_auth_serv",
      summarize: (_response, rawParams) => {
        const args = rawParams as DeviceOnlyParams;
        return `Fetched auth server config for ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "apfree_wifidog_set_auth_serv",
      label: "ApFree WiFiDog Set Auth Server",
      description: "Set the captive portal authentication server hostname, port, and path.",
      op: "set_auth_serv",
      parameters: SetAuthServerSchema,
      buildPayload: (rawParams) => {
        const args = rawParams as SetAuthServerParams;
        const payload: JsonRecord = { hostname: args.hostname };
        if (args.port !== undefined) {
          payload.port = String(args.port);
        }
        if (typeof args.path === "string") {
          payload.path = args.path;
        }
        return {
          deviceId: args.deviceId.trim(),
          payload,
          timeoutMs: args.timeoutMs,
        };
      },
      summarize: (_response, rawParams) => {
        const args = rawParams as SetAuthServerParams;
        return `Updated auth server for ${args.deviceId} to ${args.hostname}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "apfree_wifidog_get_mqtt_serv",
      label: "ApFree WiFiDog Get MQTT Server",
      description: "Get the current MQTT server configuration for the device.",
      op: "get_mqtt_serv",
      summarize: (_response, rawParams) => {
        const args = rawParams as DeviceOnlyParams;
        return `Fetched MQTT server config for ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "apfree_wifidog_set_mqtt_serv",
      label: "ApFree WiFiDog Set MQTT Server",
      description: "Set the MQTT server hostname, port, credentials, and TLS flag.",
      op: "set_mqtt_serv",
      parameters: SetMqttServerSchema,
      buildPayload: (rawParams) => {
        const args = rawParams as SetMqttServerParams;
        const payload: JsonRecord = {};
        if (typeof args.hostname === "string") payload.hostname = args.hostname;
        if (args.port !== undefined) payload.port = String(args.port);
        if (typeof args.username === "string") payload.username = args.username;
        if (typeof args.password === "string") payload.password = args.password;
        if (typeof args.useSsl === "boolean") payload.use_ssl = args.useSsl;
        return {
          deviceId: args.deviceId.trim(),
          payload,
          timeoutMs: args.timeoutMs,
        };
      },
      summarize: (_response, rawParams) => {
        const args = rawParams as SetMqttServerParams;
        return `Updated MQTT server config for ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "apfree_wifidog_get_websocket_serv",
      label: "ApFree WiFiDog Get WebSocket Server",
      description: "Get the current WebSocket server configuration for the device.",
      op: "get_websocket_serv",
      summarize: (_response, rawParams) => {
        const args = rawParams as DeviceOnlyParams;
        return `Fetched WebSocket server config for ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "apfree_wifidog_set_websocket_serv",
      label: "ApFree WiFiDog Set WebSocket Server",
      description: "Set the WebSocket server hostname, port, path, and TLS flag.",
      op: "set_websocket_serv",
      parameters: SetWebsocketServerSchema,
      buildPayload: (rawParams) => {
        const args = rawParams as SetWebsocketServerParams;
        const payload: JsonRecord = {};
        if (typeof args.hostname === "string") payload.hostname = args.hostname;
        if (args.port !== undefined) payload.port = String(args.port);
        if (typeof args.path === "string") payload.path = args.path;
        if (typeof args.useSsl === "boolean") payload.use_ssl = args.useSsl;
        return {
          deviceId: args.deviceId.trim(),
          payload,
          timeoutMs: args.timeoutMs,
        };
      },
      summarize: (_response, rawParams) => {
        const args = rawParams as SetWebsocketServerParams;
        return `Updated WebSocket server config for ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "apfree_wifidog_get_firmware_info",
      label: "ApFree WiFiDog Firmware Info",
      description: "Get the router's firmware/build information.",
      op: "get_firmware_info",
      summarize: (_response, rawParams) => {
        const args = rawParams as DeviceOnlyParams;
        return `Fetched firmware info for ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "apfree_wifidog_get_network_interfaces",
      label: "ApFree WiFiDog Network Interfaces",
      description: "Get network interface status using the device shell bridge.",
      op: "shell",
      parameters: DeviceOnlySchema,
      buildPayload: (rawParams) => {
        const args = rawParams as DeviceOnlyParams;
        return {
          deviceId: args.deviceId ? args.deviceId.trim() : "",
          payload: {
            command:
              'ip link show | grep -E "^[0-9]+:" | cut -d: -f2 | sed "s/ //g" | wc -l && echo "--- Interface Details ---" && ip addr show',
          },
          timeoutMs: args.timeoutMs,
        };
      },
      summarize: (_response, rawParams) => {
        const args = rawParams as DeviceOnlyParams;
        return `Fetched network interfaces for ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "apfree_wifidog_execute_shell",
      label: "ApFree WiFiDog Execute Shell",
      description:
        "Execute a shell command on the router. Use only when the user explicitly requests shell-level access.",
      op: "shell",
      parameters: ShellCommandSchema,
      buildPayload: (rawParams) => {
        const args = rawParams as ShellCommandParams;
        const payload: JsonRecord = { command: args.command };
        if (typeof args.timeoutSeconds === "number") {
          payload.timeout = args.timeoutSeconds;
        }
        return {
          deviceId: args.deviceId.trim(),
          payload,
          timeoutMs: args.timeoutMs,
        };
      },
      summarize: (_response, rawParams) => {
        const args = rawParams as ShellCommandParams;
        return `Executed shell command on ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "apfree_wifidog_reboot_device",
      label: "ApFree WiFiDog Reboot Device",
      description:
        "Request a router reboot. The device should respond before rebooting, but it may disconnect immediately.",
      op: "reboot_device",
      summarize: (_response, rawParams) => {
        const args = rawParams as DeviceOnlyParams;
        return `Reboot request sent to ${args.deviceId}. Treat this as best-effort and expect disconnect.`;
      },
    }),
    createGenericTool(bridge),
  ];
}
