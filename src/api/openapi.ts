import { createDocument, type ZodOpenApiPathsObject } from 'zod-openapi';
import { EventPayload } from './events.ts';
import { Problem, PROBLEM_MEDIA_TYPE } from './problem.ts';
import type { Route } from './route.ts';

// The API contract version. Breaking changes move to a new path prefix.
export const API_VERSION = '1.0.0';

// Builds the OpenAPI 3.1 document from the same route list the router serves,
// so the document cannot describe a route that does not exist.
export function buildOpenApiDocument(routes: Array<Route>): Record<string, unknown> {
  const paths: ZodOpenApiPathsObject = {};
  for (const route of routes) {
    const responses = Object.fromEntries(
      Object.entries(route.responses).map(([status, response]) => [
        status,
        {
          content: { [response.mediaType ?? 'application/json']: { schema: response.schema } },
          description: response.description,
        },
      ]),
    );
    const operation = {
      operationId: route.operationId,
      ...(route.request?.params === undefined &&
      route.request?.query === undefined &&
      route.request?.headers === undefined
        ? {}
        : {
            requestParams: {
              ...(route.request.headers === undefined ? {} : { header: route.request.headers }),
              ...(route.request.params === undefined ? {} : { path: route.request.params }),
              ...(route.request.query === undefined ? {} : { query: route.request.query }),
            },
          }),
      ...(route.request?.body === undefined
        ? {}
        : {
            requestBody: {
              content: { 'application/json': { schema: route.request.body } },
              // A body schema that accepts nothing makes the body optional.
              required: !route.request.body.safeParse(undefined).success,
            },
          }),
      responses: {
        ...responses,
        default: {
          content: { [PROBLEM_MEDIA_TYPE]: { schema: Problem } },
          description: 'A problem: the request was refused or failed.',
        },
      },
      // Bearer tokens carry a scope; `act` includes `read`.
      security: route.scope === null ? [] : [{ bearer: [route.scope] }],
      summary: route.summary,
      ...(route.tags === undefined ? {} : { tags: route.tags }),
    };
    paths[route.path] = { ...paths[route.path], [route.method.toLowerCase()]: operation };
  }
  return createDocument({
    components: {
      // OpenAPI 3.1 cannot type an event stream's items, so the payload is a
      // named schema clients import by name.
      schemas: { EventPayload },
      securitySchemes: {
        bearer: {
          description:
            'An API client token from `factory token create <name> --scope read|act`. Routes list the scope they need; `act` includes `read`.',
          scheme: 'bearer',
          type: 'http',
        },
      },
    },
    info: {
      description:
        'The factory server API. Reads need a `read` token, commands an `act` token. Errors are RFC 9457 problem details.',
      title: 'Factory API',
      version: API_VERSION,
    },
    openapi: '3.1.0',
    paths,
  }) as unknown as Record<string, unknown>;
}
