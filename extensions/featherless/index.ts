import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";
import { buildSingleProviderApiKeyCatalog } from "openclaw/plugin-sdk/provider-catalog";
import { applyFeatherlessConfig, FEATHERLESS_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildFeatherlessProvider } from "./provider-catalog.js";

const PROVIDER_ID = "featherless";

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "Featherless Provider",
  description: "Bundled Featherless provider plugin",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Featherless",
      docsPath: "/providers/featherless",
      envVars: ["FEATHERLESS_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "Featherless AI API key",
          hint: "API key",
          optionKey: "featherlessApiKey",
          flagName: "--featherless-api-key",
          envVar: "FEATHERLESS_API_KEY",
          promptMessage: "Enter Featherless AI API key",
          defaultModel: FEATHERLESS_DEFAULT_MODEL_REF,
          expectedProviders: ["featherless"],
          applyConfig: (cfg) => applyFeatherlessConfig(cfg),
          wizard: {
            choiceId: "featherless-api-key",
            choiceLabel: "Featherless AI API key",
            groupId: "featherless",
            groupLabel: "Featherless AI",
            groupHint: "API key",
          },
        }),
      ],
      catalog: {
        order: "simple",
        run: (ctx) =>
          buildSingleProviderApiKeyCatalog({
            ctx,
            providerId: PROVIDER_ID,
            buildProvider: buildFeatherlessProvider,
          }),
      },
    });
  },
});
