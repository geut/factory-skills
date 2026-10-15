import { z } from 'zod';

// RFC 9457 problem details. `type` is a stable code clients switch on; the
// codes, their statuses, and their titles live here so every route agrees.
export const problemTypes = {
  insufficient_scope: { status: 403, title: 'Insufficient scope' },
  internal_error: { status: 500, title: 'Internal error' },
  invalid_state: { status: 409, title: 'Invalid state' },
  method_not_allowed: { status: 405, title: 'Method not allowed' },
  not_found: { status: 404, title: 'Not found' },
  not_waiting_for_reply: { status: 409, title: 'Not waiting for a reply' },
  ticket_not_found: { status: 404, title: 'Ticket not found' },
  tracker_unavailable: { status: 502, title: 'Tracker unavailable' },
  umbrella_issue: { status: 422, title: 'Umbrella issue' },
  unauthorized: { status: 401, title: 'Unauthorized' },
  unsupported_media_type: { status: 415, title: 'Unsupported media type' },
  validation_error: { status: 400, title: 'Validation error' },
} as const;

export type ProblemType = keyof typeof problemTypes;

const typeCodes = Object.keys(problemTypes) as [ProblemType, ...Array<ProblemType>];

export const FieldError = z
  .object({
    message: z.string(),
    path: z
      .string()
      .meta({ description: 'Where the problem is, such as `body.ref` or `query.stage`.' }),
  })
  .meta({ id: 'FieldError' });

export const Problem = z
  .object({
    detail: z.string().optional(),
    errors: z.array(FieldError).optional(),
    status: z.int().min(100).max(599),
    title: z.string(),
    type: z.enum(typeCodes).meta({ description: 'A stable code clients can switch on.' }),
  })
  .meta({ description: 'An RFC 9457 problem details object.', id: 'Problem' });

export type Problem = z.infer<typeof Problem>;

export const PROBLEM_MEDIA_TYPE = 'application/problem+json';

export function problem(
  type: ProblemType,
  detail?: string,
  errors?: Array<z.infer<typeof FieldError>>,
): Problem {
  const { status, title } = problemTypes[type];
  return {
    ...(detail === undefined ? {} : { detail }),
    ...(errors === undefined ? {} : { errors }),
    status,
    title,
    type,
  };
}

// A handler throws this to answer with a problem instead of its response.
export class ProblemError extends Error {
  readonly problem: Problem;

  constructor(type: ProblemType, detail?: string, errors?: Array<z.infer<typeof FieldError>>) {
    super(detail ?? problemTypes[type].title);
    this.name = 'ProblemError';
    this.problem = problem(type, detail, errors);
  }
}
