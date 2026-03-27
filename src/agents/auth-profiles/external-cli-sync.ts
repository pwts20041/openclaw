import {
  readClaudeCliCredentialsCached,
  readCodexCliCredentialsCached,
  readMiniMaxCliCredentialsCached,
} from "../cli-credentials.js";
import {
  EXTERNAL_CLI_SYNC_TTL_MS,
  OPENAI_CODEX_DEFAULT_PROFILE_ID,
  MINIMAX_CLI_PROFILE_ID,
  log,
} from "./constants.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

const ANTHROPIC_DEFAULT_PROFILE_ID = "anthropic:default";

type ExternalCliSyncOptions = {
  log?: boolean;
};

type ExternalCliSyncProvider = {
  profileId: string;
  provider: string;
  readCredentials: () => OAuthCredential | null;
};

function areOAuthCredentialsEquivalent(
  a: OAuthCredential | undefined,
  b: OAuthCredential,
): boolean {
  if (!a) {
    return false;
  }
  if (a.type !== "oauth") {
    return false;
  }
  return (
    a.provider === b.provider &&
    a.access === b.access &&
    a.refresh === b.refresh &&
    a.expires === b.expires &&
    a.email === b.email &&
    a.enterpriseUrl === b.enterpriseUrl &&
    a.projectId === b.projectId &&
    a.accountId === b.accountId
  );
}

function hasNewerStoredOAuthCredential(
  existing: OAuthCredential | undefined,
  incoming: OAuthCredential,
): boolean {
  return Boolean(
    existing &&
    existing.provider === incoming.provider &&
    Number.isFinite(existing.expires) &&
    (!Number.isFinite(incoming.expires) || existing.expires > incoming.expires),
  );
}

export function shouldReplaceStoredOAuthCredential(
  existing: OAuthCredential | undefined,
  incoming: OAuthCredential,
): boolean {
  if (!existing || existing.type !== "oauth") {
    return true;
  }
  if (areOAuthCredentialsEquivalent(existing, incoming)) {
    return false;
  }
  return !hasNewerStoredOAuthCredential(existing, incoming);
}

function clearProfileFailureState(store: AuthProfileStore, profileId: string): boolean {
  const stats = store.usageStats?.[profileId];
  if (!stats) {
    return false;
  }
  const hadFailureState =
    typeof stats.cooldownUntil === "number" ||
    typeof stats.disabledUntil === "number" ||
    stats.disabledReason !== undefined ||
    (typeof stats.errorCount === "number" && stats.errorCount !== 0) ||
    stats.failureCounts !== undefined;
  if (!hadFailureState) {
    return false;
  }
  stats.cooldownUntil = undefined;
  stats.disabledUntil = undefined;
  stats.disabledReason = undefined;
  stats.errorCount = 0;
  stats.failureCounts = undefined;
  return true;
}

const EXTERNAL_CLI_SYNC_PROVIDERS: ExternalCliSyncProvider[] = [
  {
    profileId: ANTHROPIC_DEFAULT_PROFILE_ID,
    provider: "anthropic",
    readCredentials: () => {
      const creds = readClaudeCliCredentialsCached({ ttlMs: EXTERNAL_CLI_SYNC_TTL_MS });
      return creds?.type === "oauth" ? creds : null;
    },
  },
  {
    profileId: MINIMAX_CLI_PROFILE_ID,
    provider: "minimax-portal",
    readCredentials: () => readMiniMaxCliCredentialsCached({ ttlMs: EXTERNAL_CLI_SYNC_TTL_MS }),
  },
  {
    profileId: OPENAI_CODEX_DEFAULT_PROFILE_ID,
    provider: "openai-codex",
    readCredentials: () => readCodexCliCredentialsCached({ ttlMs: EXTERNAL_CLI_SYNC_TTL_MS }),
  },
];

/** Sync external CLI credentials into the store for a given provider. */
function syncExternalCliCredentialsForProvider(
  store: AuthProfileStore,
  providerConfig: ExternalCliSyncProvider,
  options: ExternalCliSyncOptions,
): boolean {
  const { profileId, provider, readCredentials } = providerConfig;
  const existing = store.profiles[profileId];
  const creds = readCredentials();
  if (!creds) {
    return false;
  }

  const existingOAuth = existing?.type === "oauth" ? existing : undefined;

  // Freshness guard: never overwrite store credentials that are newer than
  // what the external CLI has. This prevents a stale Keychain entry from
  // downgrading credentials that the gateway already refreshed successfully.
  if (hasNewerStoredOAuthCredential(existingOAuth, creds)) {
    if (options.log !== false && existingOAuth) {
      log.debug(`kept newer stored ${provider} credentials over external cli sync`, {
        profileId,
        storedExpires: new Date(existingOAuth.expires).toISOString(),
        externalExpires: Number.isFinite(creds.expires)
          ? new Date(creds.expires).toISOString()
          : null,
      });
    }
    // Store has fresher credentials; only clear failure state if needed.
    const clearedFailureState = clearProfileFailureState(store, profileId);
    return clearedFailureState;
  }

  const credentialChanged = !areOAuthCredentialsEquivalent(existingOAuth, creds);
  const clearedFailureState = clearProfileFailureState(store, profileId);
  if (!credentialChanged && !clearedFailureState) {
    return false;
  }

  store.profiles[profileId] = creds;
  if (options.log !== false) {
    log.info(`synced ${provider} credentials from external cli`, {
      profileId,
      expires: new Date(creds.expires).toISOString(),
    });
  }
  return true;
}

/**
 * Sync OAuth credentials from external CLI tools (Claude CLI, MiniMax CLI, Codex CLI)
 * into the store. Also clears stale failure/lockout state when fresh credentials arrive.
 *
 * Returns true if any credentials were updated.
 */
export function syncExternalCliCredentials(
  store: AuthProfileStore,
  options: ExternalCliSyncOptions = {},
): boolean {
  let mutated = false;

  for (const provider of EXTERNAL_CLI_SYNC_PROVIDERS) {
    if (syncExternalCliCredentialsForProvider(store, provider, options)) {
      mutated = true;
    }
  }

  return mutated;
}
