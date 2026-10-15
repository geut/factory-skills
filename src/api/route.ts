import type { IncomingMessage } from 'node:http';
import type { z } from 'zod';
import type { Actor } from '../domain.ts';

// What a route may ask for while it handles a request. Later routes add the
// controller service and the database here.
export type ApiContext = {
  instanceId: string;
  openapi: () => Record<string, unknown>;
};

// `read` routes only look; `act` routes change tickets and include `read`.
// A route without a scope needs no token.
export type Scope = 'act' | 'read';

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
> = {
  // The API client behind the request; null on routes that need no token.
  actor: Actor | null;
  body: Output<B>;
  context: ApiContext;
  params: Output<P>;
  query: Output<Q>;
  request: IncomingMessage;
};

export type RouteResult = {
  body: unknown;
  headers?: Record<string, string>;
  status: number;
};

export type RouteDefinition<
  P extends z.ZodObject | undefined,
  Q extends z.ZodObject | undefined,
  B extends z.ZodType | undefined,
> = {
  handler: (input: RouteInput<P, Q, B>) => Promise<RouteResult> | RouteResult;
  method: Method;
  operationId: string;
  // An OpenAPI path template such as /v1/tickets/{key}.
  path: string;
  request?: { body?: B; params?: P; query?: Q };
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
    input: RouteInput<z.ZodObject, z.ZodObject, z.ZodType>,
  ) => Promise<RouteResult> | RouteResult;
  request?: { body?: z.ZodType; params?: z.ZodObject; query?: z.ZodObject };
};

export function defineRoute<
  P extends z.ZodObject | undefined = undefined,
  Q extends z.ZodObject | undefined = undefined,
  B extends z.ZodType | undefined = undefined,
>(route: RouteDefinition<P, Q, B>): Route {
  return route as unknown as Route;
}
