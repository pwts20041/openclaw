import { vi } from "vitest";
import type { MockFn } from "../test-utils/vitest-mock-fn.js";

export const configMocks: {
  readConfigFileSnapshot: MockFn;
  writeConfigFile: MockFn;
} = {
  readConfigFileSnapshot: vi.fn() as unknown as MockFn,
  writeConfigFile: vi.fn().mockResolvedValue(undefined) as unknown as MockFn,
};

export const offsetMocks: {
  deleteTelegramUpdateOffset: MockFn;
} = {
  deleteTelegramUpdateOffset: vi.fn().mockResolvedValue(undefined) as unknown as MockFn,
};

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    readConfigFileSnapshot: configMocks.readConfigFileSnapshot,
    writeConfigFile: configMocks.writeConfigFile,
  };
});

vi.mock("../../extensions/telegram/api.js", async () => {
  const actual = await vi.importActual<typeof import("../../extensions/telegram/api.js")>(
    "../../extensions/telegram/api.js",
  );
  return {
    ...actual,
    deleteTelegramUpdateOffset: offsetMocks.deleteTelegramUpdateOffset,
  };
});

vi.mock("../../extensions/telegram/update-offset-runtime-api.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../extensions/telegram/update-offset-runtime-api.js")
  >("../../extensions/telegram/update-offset-runtime-api.js");
  return {
    ...actual,
    deleteTelegramUpdateOffset: offsetMocks.deleteTelegramUpdateOffset,
  };
});
