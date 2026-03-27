import { describe, expect, it, vi } from "vitest";

const loadPluginManifestRegistry = vi.hoisted(() => vi.fn());

vi.mock("./manifest-registry.js", () => ({
  loadPluginManifestRegistry,
}));

import {
  resolveManifestDeprecatedProviderAuthChoice,
  resolveManifestProviderAuthChoice,
  resolveManifestProviderAuthChoices,
  resolveManifestProviderOnboardAuthFlags,
} from "./provider-auth-choices.js";

describe("provider auth choice manifest helpers", () => {
  it("flattens manifest auth choices", () => {
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "openai",
          providerAuthChoices: [
            {
              provider: "openai",
              method: "api-key",
              choiceId: "openai-api-key",
              choiceLabel: "OpenAI API key",
              onboardingScopes: ["text-inference"],
              optionKey: "openaiApiKey",
              cliFlag: "--openai-api-key",
              cliOption: "--openai-api-key <key>",
            },
          ],
        },
      ],
    });

    expect(resolveManifestProviderAuthChoices()).toEqual([
      {
        pluginId: "openai",
        providerId: "openai",
        methodId: "api-key",
        choiceId: "openai-api-key",
        choiceLabel: "OpenAI API key",
        onboardingScopes: ["text-inference"],
        optionKey: "openaiApiKey",
        cliFlag: "--openai-api-key",
        cliOption: "--openai-api-key <key>",
      },
    ]);
    expect(resolveManifestProviderAuthChoice("openai-api-key")?.providerId).toBe("openai");
  });

  it("deduplicates flag metadata by option key + flag", () => {
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "moonshot",
          providerAuthChoices: [
            {
              provider: "moonshot",
              method: "api-key",
              choiceId: "moonshot-api-key",
              choiceLabel: "Kimi API key (.ai)",
              optionKey: "moonshotApiKey",
              cliFlag: "--moonshot-api-key",
              cliOption: "--moonshot-api-key <key>",
              cliDescription: "Moonshot API key",
            },
            {
              provider: "moonshot",
              method: "api-key-cn",
              choiceId: "moonshot-api-key-cn",
              choiceLabel: "Kimi API key (.cn)",
              optionKey: "moonshotApiKey",
              cliFlag: "--moonshot-api-key",
              cliOption: "--moonshot-api-key <key>",
              cliDescription: "Moonshot API key",
            },
          ],
        },
      ],
    });

    expect(resolveManifestProviderOnboardAuthFlags()).toEqual([
      {
        optionKey: "moonshotApiKey",
        authChoice: "moonshot-api-key",
        cliFlag: "--moonshot-api-key",
        cliOption: "--moonshot-api-key <key>",
        description: "Moonshot API key",
      },
    ]);
  });

  it("keeps distinct onboarding flags for a shared manifest auth choice", () => {
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "oracle",
          providerAuthChoices: [
            {
              provider: "oracle",
              method: "oci-config",
              choiceId: "oracle-oci-config",
              choiceLabel: "OCI config file",
              optionKey: "oracleConfigFile",
              cliFlag: "--oracle-config-file",
              cliOption: "--oracle-config-file <path>",
              cliDescription: "Path to OCI config file",
            },
            {
              provider: "oracle",
              method: "oci-config",
              choiceId: "oracle-oci-config",
              choiceLabel: "OCI config file",
              optionKey: "oracleProfile",
              cliFlag: "--oracle-profile",
              cliOption: "--oracle-profile <name>",
              cliDescription: "OCI profile name",
            },
            {
              provider: "oracle",
              method: "oci-config",
              choiceId: "oracle-oci-config",
              choiceLabel: "OCI config file",
              optionKey: "oracleCompartmentId",
              cliFlag: "--oracle-compartment-id",
              cliOption: "--oracle-compartment-id <ocid>",
              cliDescription: "OCI compartment OCID",
            },
          ],
        },
      ],
    });

    expect(resolveManifestProviderOnboardAuthFlags()).toEqual([
      {
        optionKey: "oracleConfigFile",
        authChoice: "oracle-oci-config",
        cliFlag: "--oracle-config-file",
        cliOption: "--oracle-config-file <path>",
        description: "Path to OCI config file",
      },
      {
        optionKey: "oracleProfile",
        authChoice: "oracle-oci-config",
        cliFlag: "--oracle-profile",
        cliOption: "--oracle-profile <name>",
        description: "OCI profile name",
      },
      {
        optionKey: "oracleCompartmentId",
        authChoice: "oracle-oci-config",
        cliFlag: "--oracle-compartment-id",
        cliOption: "--oracle-compartment-id <ocid>",
        description: "OCI compartment OCID",
      },
    ]);
  });

  it("resolves deprecated auth-choice aliases through manifest metadata", () => {
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "minimax",
          providerAuthChoices: [
            {
              provider: "minimax",
              method: "api-global",
              choiceId: "minimax-global-api",
              deprecatedChoiceIds: ["minimax", "minimax-api"],
            },
          ],
        },
      ],
    });

    expect(resolveManifestDeprecatedProviderAuthChoice("minimax")?.choiceId).toBe(
      "minimax-global-api",
    );
    expect(resolveManifestDeprecatedProviderAuthChoice("minimax-api")?.choiceId).toBe(
      "minimax-global-api",
    );
    expect(resolveManifestDeprecatedProviderAuthChoice("openai")).toBeUndefined();
  });
});
