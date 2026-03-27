import type { PluginChannelRegistration, PluginRegistry } from "../../plugins/registry.js";
import {
  getActivePluginChannelRegistry,
  getActivePluginChannelRegistryVersion,
} from "../../plugins/runtime.js";
import type { ChannelId } from "./types.js";

type ChannelRegistryValueResolver<TValue> = (
  entry: PluginChannelRegistration,
) => TValue | undefined;

export function createChannelRegistryLoader<TValue>(
  resolveValue: ChannelRegistryValueResolver<TValue>,
): (id: ChannelId) => Promise<TValue | undefined> {
  const cache = new Map<ChannelId, TValue>();
  let lastRegistry: PluginRegistry | null = null;
  let lastRegistryVersion = -1;

  return async (id: ChannelId): Promise<TValue | undefined> => {
    const registry = getActivePluginChannelRegistry();
    const registryVersion = getActivePluginChannelRegistryVersion();
    if (registry !== lastRegistry || registryVersion !== lastRegistryVersion) {
      cache.clear();
      lastRegistry = registry;
      lastRegistryVersion = registryVersion;
    }
    const pluginEntry = registry?.channels.find((entry) => entry.plugin.id === id);
    if (!pluginEntry) {
      cache.delete(id);
      return undefined;
    }
    const resolved = resolveValue(pluginEntry);
    if (!resolved) {
      cache.delete(id);
      return undefined;
    }
    const cached = cache.get(id);
    if (cached === resolved) {
      return cached;
    }
    cache.set(id, resolved);
    return resolved;
  };
}
