import { describe, expect, it } from "vitest";
import { createApFreeWifidogTools } from "./tool.js";

describe("apfree-wifidog intent tools", () => {
  it("kickoff tool resolves client IP from get_clients and infers gwId from a single gateway", async () => {
    const calls: Array<{ deviceId: string; op: string; payload?: Record<string, unknown> }> = [];
    const bridge = {
      listDevices() {
        return [];
      },
      getDevice() {
        return {
          deviceId: "dev-1",
          connectedAtMs: Date.now(),
          lastSeenAtMs: Date.now(),
          gateway: [{ gw_id: "gw-1" }],
        };
      },
      async callDevice(params: {
        deviceId: string;
        op: string;
        payload?: Record<string, unknown>;
      }) {
        calls.push(params);
        if (params.op === "get_clients") {
          return {
            type: "get_clients_response",
            clients: [{ mac: "aa:bb:cc:dd:ee:ff", ip: "192.168.1.10" }],
          };
        }
        return {
          type: "kickoff_response",
          status: "success",
        };
      },
    };

    const tool = createApFreeWifidogTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "apfree_wifidog_kickoff_client",
    );
    expect(tool).toBeTruthy();

    const result = await tool?.execute?.("tool-1", {
      deviceId: "dev-1",
      clientMac: "aa-bb-cc-dd-ee-ff",
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ op: "get_clients", deviceId: "dev-1" });
    expect(calls[1]).toMatchObject({
      op: "kickoff",
      deviceId: "dev-1",
      payload: {
        client_ip: "192.168.1.10",
        client_mac: "aa:bb:cc:dd:ee:ff",
        gw_id: "gw-1",
      },
    });
    expect((result as { details?: Record<string, unknown> }).details?.resolved).toEqual({
      clientIp: "192.168.1.10",
      gwId: "gw-1",
      clientMac: "aa:bb:cc:dd:ee:ff",
    });
  });

  it("get device tool accepts a device alias from the device list", async () => {
    const bridge = {
      listDevices() {
        return [{ deviceId: "dev-1", alias: "Router-1", connectedAtMs: 1, lastSeenAtMs: 1 }];
      },
      getDevice(deviceId: string) {
        if (deviceId === "Router-1" || deviceId === "dev-1") {
          return { deviceId: "dev-1", alias: "Router-1", connectedAtMs: 1, lastSeenAtMs: 1 };
        }
        return null;
      },
    };

    const tool = createApFreeWifidogTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "apfree_wifidog_get_device",
    );
    expect(tool).toBeTruthy();

    const result = await tool?.execute?.("tool-alias", {
      deviceId: "Router-1",
    });

    expect((result as { details?: Record<string, unknown> }).details?.device).toMatchObject({
      deviceId: "dev-1",
      alias: "Router-1",
    });
  });

  it("kickoff tool skips get_clients when clientIp and gwId are provided", async () => {
    const calls: Array<{ deviceId: string; op: string; payload?: Record<string, unknown> }> = [];
    const bridge = {
      listDevices() {
        return [];
      },
      getDevice() {
        return {
          deviceId: "dev-1",
          connectedAtMs: Date.now(),
          lastSeenAtMs: Date.now(),
          gateway: [{ gw_id: "gw-1" }],
        };
      },
      async callDevice(params: {
        deviceId: string;
        op: string;
        payload?: Record<string, unknown>;
      }) {
        calls.push(params);
        return {
          type: "kickoff_response",
          status: "success",
        };
      },
    };

    const tool = createApFreeWifidogTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "apfree_wifidog_kickoff_client",
    );
    expect(tool).toBeTruthy();

    await tool?.execute?.("tool-explicit", {
      deviceId: "dev-1",
      clientMac: "aa-bb-cc-dd-ee-ff",
      clientIp: "192.168.1.20",
      gwId: "gw-explicit",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      op: "kickoff",
      deviceId: "dev-1",
      payload: {
        client_ip: "192.168.1.20",
        client_mac: "AA:BB:CC:DD:EE:FF",
        gw_id: "gw-explicit",
      },
    });
  });

  it("trusted-domain sync tool sends the full domains array as sync_trusted_domain payload", async () => {
    const calls: Array<{ deviceId: string; op: string; payload?: Record<string, unknown> }> = [];
    const bridge = {
      listDevices() {
        return [];
      },
      getDevice() {
        return null;
      },
      async callDevice(params: {
        deviceId: string;
        op: string;
        payload?: Record<string, unknown>;
      }) {
        calls.push(params);
        return { type: "sync_trusted_domain_response", status: "success" };
      },
    };

    const tool = createApFreeWifidogTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "apfree_wifidog_sync_trusted_domains",
    );

    const result = await tool?.execute?.("tool-2", {
      deviceId: "dev-2",
      domains: ["example.com", "login.example.net"],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      deviceId: "dev-2",
      op: "sync_trusted_domain",
      payload: {
        domains: ["example.com", "login.example.net"],
      },
    });
    expect((result as { content?: Array<{ text?: string }> }).content?.[0]?.text).toContain(
      "Synced 2 trusted domains",
    );
  });

  it("shell tool forwards command and device-side timeout to the shell op", async () => {
    const calls: Array<{ deviceId: string; op: string; payload?: Record<string, unknown> }> = [];
    const bridge = {
      listDevices() {
        return [];
      },
      getDevice() {
        return null;
      },
      async callDevice(params: {
        deviceId: string;
        op: string;
        payload?: Record<string, unknown>;
      }) {
        calls.push(params);
        return { type: "shell_response", exit_code: 0, output: "ok" };
      },
    };

    const tool = createApFreeWifidogTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "apfree_wifidog_execute_shell",
    );

    await tool?.execute?.("tool-3", {
      deviceId: "dev-3",
      command: "uci show wireless",
      timeoutSeconds: 15,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      deviceId: "dev-3",
      op: "shell",
      payload: {
        command: "uci show wireless",
        timeout: 15,
      },
    });
  });

  it("bpf add tool sends normalized payload to bpf_add", async () => {
    const calls: Array<{ deviceId: string; op: string; payload?: Record<string, unknown> }> = [];
    const bridge = {
      listDevices() {
        return [];
      },
      getDevice() {
        return null;
      },
      async callDevice(params: {
        deviceId: string;
        op: string;
        payload?: Record<string, unknown>;
      }) {
        calls.push(params);
        return { type: "bpf_add_response", status: "success", output: "added" };
      },
    };

    const tool = createApFreeWifidogTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "apfree_wifidog_bpf_add",
    );

    const result = await tool?.execute?.("tool-4", {
      deviceId: "dev-4",
      table: "mac",
      address: "AA-BB-CC-DD-EE-FF",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      deviceId: "dev-4",
      op: "bpf_add",
      payload: {
        table: "mac",
        address: "aa:bb:cc:dd:ee:ff",
      },
    });
    expect((result as { content?: Array<{ text?: string }> }).content?.[0]?.text).toContain(
      "Added AA-BB-CC-DD-EE-FF",
    );
  });

  it("bpf json tool queries the selected table", async () => {
    const calls: Array<{ deviceId: string; op: string; payload?: Record<string, unknown> }> = [];
    const bridge = {
      listDevices() {
        return [];
      },
      getDevice() {
        return null;
      },
      async callDevice(params: {
        deviceId: string;
        op: string;
        payload?: Record<string, unknown>;
      }) {
        calls.push(params);
        return {
          type: "bpf_json_response",
          data: [{ address: "203.0.113.45", bytes: 1024 }],
        };
      },
    };

    const tool = createApFreeWifidogTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "apfree_wifidog_bpf_json",
    );

    const result = await tool?.execute?.("tool-5", {
      deviceId: "dev-5",
      table: "ipv4",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      deviceId: "dev-5",
      op: "bpf_json",
      payload: {
        table: "ipv4",
      },
    });
    expect((result as { content?: Array<{ text?: string }> }).content?.[0]?.text).toContain(
      "Fetched ipv4 BPF stats",
    );
  });

  it("bpf json tool supports sid table for active L7 traffic stats", async () => {
    const calls: Array<{ deviceId: string; op: string; payload?: Record<string, unknown> }> = [];
    const bridge = {
      listDevices() {
        return [];
      },
      getDevice() {
        return null;
      },
      async callDevice(params: {
        deviceId: string;
        op: string;
        payload?: Record<string, unknown>;
      }) {
        calls.push(params);
        return { type: "bpf_json_response", data: [{ sid: 101, bps: 4096 }] };
      },
    };

    const tool = createApFreeWifidogTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "apfree_wifidog_bpf_json",
    );

    await tool?.execute?.("tool-5b", {
      deviceId: "dev-5b",
      table: "sid",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      deviceId: "dev-5b",
      op: "bpf_json",
      payload: {
        table: "sid",
      },
    });
  });

  it("bpf del tool sends normalized payload to bpf_del", async () => {
    const calls: Array<{ deviceId: string; op: string; payload?: Record<string, unknown> }> = [];
    const bridge = {
      listDevices() {
        return [];
      },
      getDevice() {
        return null;
      },
      async callDevice(params: {
        deviceId: string;
        op: string;
        payload?: Record<string, unknown>;
      }) {
        calls.push(params);
        return { type: "bpf_del_response", status: "success", output: "deleted" };
      },
    };

    const tool = createApFreeWifidogTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "apfree_wifidog_bpf_del",
    );

    await tool?.execute?.("tool-6", {
      deviceId: "dev-6",
      table: "mac",
      address: "AA-BB-CC-DD-EE-11",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      deviceId: "dev-6",
      op: "bpf_del",
      payload: {
        table: "mac",
        address: "aa:bb:cc:dd:ee:11",
      },
    });
  });

  it("bpf flush tool targets the selected table", async () => {
    const calls: Array<{ deviceId: string; op: string; payload?: Record<string, unknown> }> = [];
    const bridge = {
      listDevices() {
        return [];
      },
      getDevice() {
        return null;
      },
      async callDevice(params: {
        deviceId: string;
        op: string;
        payload?: Record<string, unknown>;
      }) {
        calls.push(params);
        return { type: "bpf_flush_response", status: "success" };
      },
    };

    const tool = createApFreeWifidogTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "apfree_wifidog_bpf_flush",
    );

    await tool?.execute?.("tool-7", {
      deviceId: "dev-7",
      table: "ipv4",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      deviceId: "dev-7",
      op: "bpf_flush",
      payload: {
        table: "ipv4",
      },
    });
  });

  it("bpf update tool sends target and rates to bpf_update", async () => {
    const calls: Array<{ deviceId: string; op: string; payload?: Record<string, unknown> }> = [];
    const bridge = {
      listDevices() {
        return [];
      },
      getDevice() {
        return null;
      },
      async callDevice(params: {
        deviceId: string;
        op: string;
        payload?: Record<string, unknown>;
      }) {
        calls.push(params);
        return { type: "bpf_update_response", status: "success" };
      },
    };

    const tool = createApFreeWifidogTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "apfree_wifidog_bpf_update",
    );

    await tool?.execute?.("tool-8", {
      deviceId: "dev-8",
      table: "mac",
      target: "AA-BB-CC-DD-EE-22",
      downrate: 2_000_000,
      uprate: 1_000_000,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      deviceId: "dev-8",
      op: "bpf_update",
      payload: {
        table: "mac",
        target: "aa:bb:cc:dd:ee:22",
        downrate: 2_000_000,
        uprate: 1_000_000,
      },
    });
  });

  it("bpf update all tool sends table-wide rates to bpf_update_all", async () => {
    const calls: Array<{ deviceId: string; op: string; payload?: Record<string, unknown> }> = [];
    const bridge = {
      listDevices() {
        return [];
      },
      getDevice() {
        return null;
      },
      async callDevice(params: {
        deviceId: string;
        op: string;
        payload?: Record<string, unknown>;
      }) {
        calls.push(params);
        return { type: "bpf_update_all_response", status: "success" };
      },
    };

    const tool = createApFreeWifidogTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "apfree_wifidog_bpf_update_all",
    );

    await tool?.execute?.("tool-9", {
      deviceId: "dev-9",
      table: "ipv6",
      downrate: 1_500_000,
      uprate: 750_000,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      deviceId: "dev-9",
      op: "bpf_update_all",
      payload: {
        table: "ipv6",
        downrate: 1_500_000,
        uprate: 750_000,
      },
    });
  });

  it("l7 active stats tool maps to bpf_json sid", async () => {
    const calls: Array<{ deviceId: string; op: string; payload?: Record<string, unknown> }> = [];
    const bridge = {
      listDevices() {
        return [];
      },
      getDevice() {
        return null;
      },
      async callDevice(params: {
        deviceId: string;
        op: string;
        payload?: Record<string, unknown>;
      }) {
        calls.push(params);
        return { type: "bpf_json_response", data: [{ sid: 42, bytes: 1024 }] };
      },
    };

    const tool = createApFreeWifidogTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "apfree_wifidog_get_l7_active_stats",
    );

    await tool?.execute?.("tool-10", { deviceId: "dev-10" });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      deviceId: "dev-10",
      op: "bpf_json",
      payload: { table: "sid" },
    });
  });

  it("l7 protocol catalog tool maps to bpf_json l7", async () => {
    const calls: Array<{ deviceId: string; op: string; payload?: Record<string, unknown> }> = [];
    const bridge = {
      listDevices() {
        return [];
      },
      getDevice() {
        return null;
      },
      async callDevice(params: {
        deviceId: string;
        op: string;
        payload?: Record<string, unknown>;
      }) {
        calls.push(params);
        return { type: "bpf_json_response", data: [{ proto: "youtube" }] };
      },
    };

    const tool = createApFreeWifidogTools({ bridge: bridge as never }).find(
      (entry) => entry.name === "apfree_wifidog_get_l7_protocol_catalog",
    );

    await tool?.execute?.("tool-11", { deviceId: "dev-11" });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      deviceId: "dev-11",
      op: "bpf_json",
      payload: { table: "l7" },
    });
  });
});
