import { z } from "zod";

/**
 * Retry counts keyed by normalized failover reason ids.
 *
 * Keys intentionally use snake_case to match failover reason naming
 * (`rate_limit`, `auth_failure`, etc.) used across runtime error classification.
 */
export const FailoverRetriesSchema = z
  .object({
    default: z.number().int().min(0).max(10).optional(),
    rate_limit: z.number().int().min(0).max(10).optional(),
    overloaded: z.number().int().min(0).max(10).optional(),
    auth_failure: z.number().int().min(0).max(10).optional(),
  })
  .strict()
  .optional();
