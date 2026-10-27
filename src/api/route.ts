import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { z } from 'zod';
import type { BacklogResult, FactoryCommands } from '../controller/service.ts';
import type { Actor } from '../domain.ts';
import type { PullRequestInfo } from '../ports/code-host.ts';
import type { EventHub } from '../server/events.ts';

// What a route may ask for while it handles a request.
export type ApiContext = {
  // The tracker's backlog, cached; null where the server has none.
  backlog: ((refresh: boolean) => BacklogResult) | null;
  commands: FactoryCommands;
  // The server's connection; read routes only read it.
  db: DatabaseSync | null;
  events: EventHub | null;
  instanceId: string;
  openapi: () => Record<string, unknown>;
  // The code host side of webhooks; null where the server has none.
  webhooks: Webhooks | null;
};

export type Webhooks = {
  // Updates the ticket of a pull request the code host reported changed, and
  // returns its key, or null when no ticket has that pull request.
  pullRequestChanged: (pullRequest: PullRequestInfo) => string | null;
  // The configured webhook secret, or null when webhooks are off.
  secret: () => string | null;
  verify: (headers: Record<string, string | undefined>, rawBody: Buffer, secret: string) => boolean;
};

// `read` routes only look; `act` routes change tickets and include `read`.
// A route without a scope needs no token.
export const SCOPES = ['act', 'read'] as const;
export type Scope = (typeof SCOPES)[number];

// Who a scoped request comes from, and what its token may do.
export type Authorized = { actor: Actor; tokenScope: Scope };

export type Method = 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT';

export type RouteResponse = {
  description: string;
  // Defaults to application/json.
  mediaType?: string;
  schema: z.ZodType;
};

type Output<T> = T extends z.ZodType ? z.output<T> : undefined;

export type RouteInput<
  P extends z.ZodObject | undefined,
  Q extends z.ZodObject | undefined,
  B extends z.ZodType | undefined,
  H extends z.ZodObject | undefined = undefined,
> = {
  // The API client behind the request; null on routes that need no token.
  actor: Actor | null;
  body: Output<B>;
  context: ApiContext;
  headers: Output<H>;
  params: Output<P>;
  query: Output<Q>;
  // The body's bytes, for routes that ask for them with `raw`.
  rawBody: Buffer | null;
  request: IncomingMessage;
  // What the request's token may do; null on routes that need no token.
  tokenScope: Scope | null;
};

// A JSON answer, or a stream that writes the response itself, such as SSE.
export type RouteResult =
  | {
      body: unknown;
      headers?: Record<string, string>;
      status: number;
    }
  | { stream: (response: ServerResponse) => void };

export type RouteDefinition<
  P extends z.ZodObject | undefined,
  Q extends z.ZodObject | undefined,
  B extends z.ZodType | undefined,
  H extends z.ZodObject | undefined = undefined,
> = {
  handler: (input: RouteInput<P, Q, B, H>) => Promise<RouteResult> | RouteResult;
  method: Method;
  operationId: string;
  // An OpenAPI path template such as /v1/tickets/{key}.
  path: string;
  // Header names are lowercase.
  request?: { body?: B; headers?: H; params?: P; query?: Q; raw?: boolean };
  // Every status the handler returns. Problems are documented for every route.
  responses: Record<number, RouteResponse>;
  scope: Scope | null;
  summary: string;
  tags?: Array<string>;
};

// A route with its schema types erased, as the router and the document see it.
export type Route = Omit<
  RouteDefinition<undefined, undefined, undefined>,
  'handler' | 'request'
> & {
  handler: (
    input: RouteInput<z.ZodObject, z.ZodObject, z.ZodType, z.ZodObject>,
  ) => Promise<RouteResult> | RouteResult;
  request?: {
    body?: z.ZodType;
    headers?: z.ZodObject;
    params?: z.ZodObject;
    query?: z.ZodObject;
    // The handler gets the body as bytes, unparsed, such as for a signature check.
    raw?: boolean;
  };
};

export function defineRoute<
  P extends z.ZodObject | undefined = undefined,
  Q extends z.ZodObject | undefined = undefined,
  B extends z.ZodType | undefined = undefined,
  H extends z.ZodObject | undefined = undefined,
>(route: RouteDefinition<P, Q, B, H>): Route {
  return route as unknown as Route;
}
