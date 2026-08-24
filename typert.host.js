// Hand-written Typert host manifest for the aiQuota Remote.
// The typert-loader imports this via package.json exports["./typert"] and
// registers it into ctx.typert.local, which the Host gateway uses to claim
// and dispatch the "aiQuota/query" endpoint in strict mode.
//
// The result follows the unified display format produced by the host's
// conversion layer:
//   - subscription providers (codex / kimi / opencodeGo): windows[] with
//     usedPercent + remainingPercent + resetsAt
//   - balance provider (deepseek): balances[] with remainingAmount numeric
//     plus string breakdown (total / granted / topped-up)
import { z } from "zod";

const usageWindow = z
  .object({
    name: z.string(),
    usedPercent: z.number().nullable(),
    remainingPercent: z.number().nullable(),
    resetsAt: z.string().nullable(),
    limitWindowSeconds: z.number().nullable(),
  })
  .nullable();

const codexProvider = z.object({
  kind: z.string(),
  status: z.string(),
  error: z.string().nullable(),
  plan: z.string().nullable(),
  windows: z.array(usageWindow),
});

const balanceInfo = z.object({
  currency: z.string(),
  totalBalance: z.string().nullable(),
  grantedBalance: z.string().nullable(),
  toppedUpBalance: z.string().nullable(),
  remainingAmount: z.number().nullable(),
});

const deepseekProvider = z.object({
  kind: z.string(),
  status: z.string(),
  keyConfigured: z.boolean(),
  error: z.string().nullable(),
  available: z.boolean().nullable(),
  balances: z.array(balanceInfo),
});

const opencodeGoProvider = z.object({
  kind: z.string(),
  status: z.string(),
  keyConfigured: z.boolean(),
  error: z.string().nullable(),
  windows: z.array(usageWindow),
});

const resultSchema = z.object({
  fetchedAt: z.string(),
  providers: z.object({
    codex: codexProvider,
    kimi: codexProvider,
    deepseek: deepseekProvider,
    opencodeGo: opencodeGoProvider,
  }),
});

const providersFilter = z.array(z.string()).nullable().optional();

export const TYPERT = {
  package: "dsh-ai-quota",
  face: "host",
  schemas: [],
  invocations: [
    {
      id: "dsh-ai-quota#aiQuota/query",
      service: "aiQuota",
      namespace: "aiQuota",
      method: "query",
      invocation: { kind: "direct" },
      parameters: [
        {
          name: "filter",
          wire: "filter",
          source: "json",
          codec: {
            mode: "strict",
            typeSymbol: "dsh-ai-quota#ProvidersFilter",
            schema: providersFilter,
          },
        },
      ],
      result: {
        mode: "strict",
        typeSymbol: "dsh-ai-quota#AiQuotaResult",
        schema: resultSchema,
      },
    },
    {
      id: "dsh-ai-quota#aiQuota/refresh",
      service: "aiQuota",
      namespace: "aiQuota",
      method: "refresh",
      invocation: { kind: "direct" },
      parameters: [
        {
          name: "filter",
          wire: "filter",
          source: "json",
          codec: {
            mode: "strict",
            typeSymbol: "dsh-ai-quota#ProvidersFilter",
            schema: providersFilter,
          },
        },
      ],
      result: {
        mode: "strict",
        typeSymbol: "dsh-ai-quota#AiQuotaResult",
        schema: resultSchema,
      },
    },
  ],
  model: { services: [], events: [], objects: [] },
};
