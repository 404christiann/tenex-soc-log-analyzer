import { z } from "zod";

/**
 * Route-local Zod schemas (DECISIONS.md §5 "input validation on every
 * endpoint"). These are request-shape validators for params/query that
 * don't belong in `packages/shared` (which holds the log-event/API
 * *response* contracts, not route plumbing like pagination bounds).
 */

export const FileIdParamsSchema = z.object({
  id: z.string().uuid("id must be a valid UUID"),
});
export type FileIdParams = z.infer<typeof FileIdParamsSchema>;

/** `GET /api/logs/:id/events?page=&pageSize=` query params. `page` is 0-based. */
export const EventsQuerySchema = z.object({
  page: z.coerce.number().int().nonnegative().default(0),
  pageSize: z.coerce.number().int().positive().max(1000).default(100),
});
export type EventsQuery = z.infer<typeof EventsQuerySchema>;
