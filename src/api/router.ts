import type { IncomingMessage, ServerResponse } from 'node:http';
import type { z } from 'zod';
import {
  problem,
  PROBLEM_MEDIA_TYPE,
  ProblemError,
  type Problem,
  type ProblemType,
} from './problem.ts';
import type { ApiContext, Route, Scope } from './route.ts';

// Request bodies are small JSON commands.
export const MAX_BODY_BYTES = 1024 * 1024;

export type RouterOptions = {
  // Returns a problem when the request may not use a route with this scope.
  authorize?: (request: IncomingMessage, scope: Scope) => Problem | null;
  context: ApiContext;
  // Unexpected errors, already answered with internal_error.
  onError?: (error: unknown) => void;
  routes: Array<Route>;
  // Checks every response against its schema. Source runs and tests turn it on.
  validateResponses: boolean;
};

type Compiled = { names: Array<string>; pattern: RegExp; route: Route };

function compile(route: Route): Compiled {
  const names: Array<string> = [];
  const source = route.path
    .split('/')
    .map((segment) => {
      const param = /^\{(\w+)\}$/.exec(segment);
      if (param?.[1] !== undefined) {
        names.push(param[1]);
        return '([^/]+)';
      }
      return segment.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
    })
    .join('/');
  return { names, pattern: new RegExp(`^${source}$`), route };
}

function send(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
  mediaType = 'application/json',
): void {
  response.writeHead(status, { 'content-type': mediaType, ...headers });
  response.end(JSON.stringify(body));
}

function sendProblem(
  response: ServerResponse,
  value: Problem,
  headers: Record<string, string> = {},
): void {
  send(response, value.status, value, headers, PROBLEM_MEDIA_TYPE);
}

// Repeated query keys become arrays; schemas that take one value see a string.
function queryObject(search: URLSearchParams): Record<string, string | Array<string>> {
  const result: Record<string, string | Array<string>> = {};
  for (const key of new Set(search.keys())) {
    const values = search.getAll(key);
    result[key] = values.length === 1 ? (values[0] ?? '') : values;
  }
  return result;
}

function fieldErrors(where: string, error: z.ZodError): Array<{ message: string; path: string }> {
  return error.issues.map((issue) => ({
    message: issue.message,
    path: [where, ...issue.path.map(String)].join('.'),
  }));
}

class BodyError extends Error {
  readonly type: ProblemType;

  constructor(type: ProblemType, message: string) {
    super(message);
    this.type = type;
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const mediaType = (request.headers['content-type'] ?? '').split(';')[0]?.trim();
  const chunks: Array<Buffer> = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new BodyError('validation_error', `Body is larger than ${MAX_BODY_BYTES} bytes.`);
    }
    chunks.push(buffer);
  }
  if (size === 0) {
    return undefined;
  }
  if (mediaType !== 'application/json') {
    throw new BodyError('unsupported_media_type', 'Send the body as application/json.');
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new BodyError('validation_error', 'Body is not valid JSON.');
  }
}

export function createRouter(
  options: RouterOptions,
): (request: IncomingMessage, response: ServerResponse) => void {
  const compiled = options.routes.map(compile);
  const onError = options.onError ?? (() => undefined);

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const matches = compiled.flatMap((item) => {
      const found = item.pattern.exec(url.pathname);
      return found === null ? [] : [{ found, item }];
    });
    if (matches.length === 0) {
      sendProblem(response, problem('not_found', `No route for ${url.pathname}.`));
      return;
    }
    const match = matches.find(({ item }) => item.route.method === request.method);
    if (match === undefined) {
      const allow = matches.map(({ item }) => item.route.method).join(', ');
      sendProblem(response, problem('method_not_allowed', `Use ${allow}.`), { allow });
      return;
    }
    const { route } = match.item;

    if (route.scope !== null && options.authorize !== undefined) {
      const denied = options.authorize(request, route.scope);
      if (denied !== null) {
        sendProblem(response, denied);
        return;
      }
    }

    const rawParams = Object.fromEntries(
      match.item.names.map((name, index) => [
        name,
        decodeURIComponent(match.found[index + 1] ?? ''),
      ]),
    );
    let rawBody: unknown;
    if (route.request?.body !== undefined) {
      try {
        rawBody = await readJson(request);
      } catch (error: unknown) {
        if (error instanceof BodyError) {
          sendProblem(response, problem(error.type, error.message));
          return;
        }
        throw error;
      }
    }

    const errors: Array<{ message: string; path: string }> = [];
    const parse = (where: string, schema: z.ZodType | undefined, value: unknown): unknown => {
      if (schema === undefined) {
        return undefined;
      }
      const parsed = schema.safeParse(value);
      if (!parsed.success) {
        errors.push(...fieldErrors(where, parsed.error));
        return undefined;
      }
      return parsed.data;
    };
    const params = parse('params', route.request?.params, rawParams);
    const query = parse('query', route.request?.query, queryObject(url.searchParams));
    const body = parse('body', route.request?.body, rawBody);
    if (errors.length > 0) {
      sendProblem(response, problem('validation_error', 'The request is invalid.', errors));
      return;
    }

    let result;
    try {
      result = await route.handler({
        body,
        context: options.context,
        params: params as Record<string, unknown>,
        query: query as Record<string, unknown>,
        request,
      });
    } catch (error: unknown) {
      if (error instanceof ProblemError) {
        sendProblem(response, error.problem);
        return;
      }
      throw error;
    }

    const declared = route.responses[result.status];
    if (options.validateResponses) {
      const checked = declared?.schema.safeParse(result.body);
      if (checked === undefined || !checked.success) {
        const why =
          checked === undefined ? `status ${result.status} is not declared` : checked.error.message;
        throw new Error(`${route.operationId} response does not match its schema: ${why}`);
      }
    }
    send(response, result.status, result.body, result.headers, declared?.mediaType);
  }

  return (request, response) => {
    handle(request, response).catch((error: unknown) => {
      onError(error);
      if (!response.headersSent) {
        sendProblem(response, problem('internal_error'));
      } else {
        response.end();
      }
    });
  };
}
