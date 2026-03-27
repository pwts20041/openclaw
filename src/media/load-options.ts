export type OutboundMediaLoadParams = {
  maxBytes?: number;
  mediaLocalRoots?: readonly string[];
  optimizeImages?: boolean;
};

export type OutboundMediaLoadOptions = {
  maxBytes?: number;
  localRoots?: readonly string[];
  optimizeImages?: boolean;
};

export function resolveOutboundMediaLocalRoots(
  mediaLocalRoots?: readonly string[],
): readonly string[] | undefined {
  // Preserve an explicit empty allowlist as deny-all instead of falling back
  // to default local media roots.
  return mediaLocalRoots === undefined ? undefined : mediaLocalRoots;
}

export function buildOutboundMediaLoadOptions(
  params: OutboundMediaLoadParams = {},
): OutboundMediaLoadOptions {
  const localRoots = resolveOutboundMediaLocalRoots(params.mediaLocalRoots);
  return {
    ...(params.maxBytes !== undefined ? { maxBytes: params.maxBytes } : {}),
    ...(localRoots !== undefined ? { localRoots } : {}),
    ...(params.optimizeImages !== undefined ? { optimizeImages: params.optimizeImages } : {}),
  };
}
