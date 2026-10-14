# Producing an OpenAPI 3.1 document from Zod with plain node:http

Research for [#19](https://github.com/geut/factory-skills/issues/19), a child of map [#14](https://github.com/geut/factory-skills/issues/14). This note collects facts and trade-offs. It does not make a decision.

Researched 2026-10-14 on Node v24.11.1. The versions checked were zod 4.6.7, zod-openapi 6.0.2, @asteasolutions/zod-to-openapi 9.1.0, openapi-typescript 7.13.0, openapi-fetch 0.17.0, @hey-api/openapi-ts 0.99.0 and @redocly/cli 2.x. A throwaway prototype ran every candidate under Node's type stripping. Claims marked **(verified)** come from running that prototype.

## Constraints from this repo

- `package.json` is `"type": "module"` with `engines.node >= 24`. The repo has no build step: `node src/...ts` runs files directly.
- `tsconfig.json` already sets `erasableSyntaxOnly`, `verbatimModuleSyntax`, `allowImportingTsExtensions` and `noEmit`. The [Node TypeScript docs](https://nodejs.org/docs/latest-v24.x/api/typescript.html) recommend these settings.
- The repo has no runtime dependencies today. The devDependencies are only tooling.

## Node 24 type stripping: what matters for library choice

Source: [Node 24 `typescript` docs](https://nodejs.org/docs/latest-v24.x/api/typescript.html).

- Type stripping is on by default since v23.6.0 and is marked Stable in v24.12.0.
- Syntax that needs code generation is rejected unless you pass `--experimental-transform-types`. That covers `enum`, `namespace` with runtime code, parameter properties and import aliases. Decorators are a parse error.
- Node "refuses to handle TypeScript files inside folders under a `node_modules` path". A dependency must therefore ship JavaScript, which all four candidates do. The rule matters only for TS-source-only packages.
- Imports need file extensions, and type-only imports need `import type`. Node ignores `tsconfig` `paths`, so use `#` subpath imports instead.
- Module augmentation such as `declare module 'zod'` is type-only and erasable. The `.meta()` typing that zod-openapi adds therefore works.

## node:http gives no validation

[node:http](https://nodejs.org/docs/latest-v24.x/api/http.html) splits a message into headers and body, but "does not parse the actual headers or the body". Our own code has to do all of the following:

- read the request stream and `JSON.parse` it
- pick the route and extract path parameters
- run Zod `safeParse` on params, query and body
- serialize the response

SSE needs nothing beyond `res.writeHead(200, { 'content-type': 'text/event-stream', ... })` and `res.flushHeaders()`.

### Request and response validation with Zod 4

All three options share this part, because it is plain Zod:

- **Request:** `Schema.safeParse(input)` returns `{ success, data | error }`. `z.prettifyError(err)` gives a readable string, and `z.treeifyError(err)` gives a nested structure that suits a 400 body. Example output **(verified)**: `{"errors":[],"properties":{"n":{"errors":["Invalid input: expected number, received string"]}}}`.
- **Response:** you can parse the outgoing value against the response schema. Common options are to always parse, to parse only in tests or dev, or to rely on types alone. The cost is one extra parse per response. The benefit is catching drift between handler output and the documented contract.
- **Input and output differ.** A schema with `.transform()` or `.pipe()` has a different input type and output type. Request schemas must be documented as _input_ and response schemas as _output_. Both libraries below do this automatically: zod-openapi documents request params and bodies as input, and response bodies and headers as output. With native `z.toJSONSchema` you pass `io: 'input'` yourself.
- **Example: `additionalProperties`.** `z.object()` renders `additionalProperties: false` in output mode but not in input mode **(verified)**. zod-openapi's README warns that "the rendered input and output schemas of a simple Zod schema will differ". When one registered schema is used in both directions, zod-openapi emits two components, the second named `<id>Output`.
- **Example: transforms.** For `z.string().transform(Number).pipe(z.number())` the output schema is `{type:"number"}` and the input schema is `{type:"string"}` **(verified)**.

## Option A: native `z.toJSONSchema` plus a hand-written document builder

Source: [Zod 4 JSON Schema docs](https://zod.dev/json-schema) and [metadata/registries](https://zod.dev/metadata).

**What Zod provides:**

- `z.toJSONSchema(schema, opts)` takes `target` (default `draft-2020-12`, also `draft-07`, `draft-04`, `openapi-3.0`), `io` (`output` by default, or `input`), `unrepresentable` (`throw` by default, or `any`), `cycles`, `reused` (`inline` or `ref`), `override`, `metadata` (a registry) and `uri`.
- OpenAPI 3.1 Schema Objects use JSON Schema 2020-12, so the default target fits without translation. `openapi-3.0` also exists and renders `nullable: true` **(verified)**.
- `.meta({ id, description, example, ... })` writes into `z.globalRegistry`. Schemas with an `id` become `$defs` with `$ref`s **(verified)**.
- Passing a registry, as in `z.toJSONSchema(z.globalRegistry, { uri: id => '#/components/schemas/' + id })`, returns `{ schemas: { Ticket: {...} } }`. That is close to `components.schemas` **(verified)**. Each entry still carries `$schema` and `$id`, which you would strip before putting them under `components`.
- `z.date()`, `bigint`, `map`, `set`, `transform`, `custom` and similar types throw by default ("Date cannot be represented in JSON Schema", **verified**). Wire types have to be JSON-shaped, for example `z.iso.datetime()` instead of `z.date()`, or you handle them through `override` or `unrepresentable`.

**What we would write ourselves:**

- the OpenAPI document skeleton
- turning a `z.object` of path, query or header params into `parameters[]` entries with `in`, `name` and `required`
- `requestBody` and `responses` wrappers
- choosing `io` for each position
- collecting and de-duplicating components, and naming input/output pairs
- the SSE media type entry

zod-openapi solves exactly this set of problems, in about 200 KB unpacked.

**Trade-offs:**

- (+) No new dependency beyond `zod`.
- (+) Full control over the document.
- (+) The schema conversion is Zod's own, so it never lags Zod releases.
- (−) The parameter, component and input/output edge cases become our code and our tests.
- (−) The schema conversion is Zod's own, but the code that assembles the document and handles input/output is ours.

## Option B: `zod-openapi`

Source: [samchungy/zod-openapi](https://github.com/samchungy/zod-openapi) README v6.0.2.

- **ESM and dependencies:** has a real `exports` map with `import` pointing to `./lib/index.mjs`, so it is native ESM. Its only peer dependency is `zod ^4`, with no runtime dependencies. Unpacked size is about 195 KB.
- **Built on Zod's converter:** its build imports `toJSONSchema` and `globalRegistry` from `zod/v4`, so schema conversion is Zod's own code **(verified by reading `lib/*.mjs`)**.
- **Metadata:** uses Zod's native `.meta()` with "no monkey patching". It adds the keys `id`, `param`, `header`, `override`, `outputId` and `unusedIO`. To get typed `.meta()` keys, you import `zod-openapi` or add a `/// <reference types>`.
- **Document shape:** `createDocument({ openapi, info, paths })`. Operations take `requestParams: { path, query, header, cookie }` as `z.object`s, plus `requestBody` and `responses` with Zod schemas directly under `content[mediaType].schema`. Components are registered automatically from `.meta({ id })`.
- **Input/output handling:** done automatically, with `outputIdSuffix` defaulting to `Output`.
- **Versions:** the README lists `3.1.0` as the minimum version. The types also accept `'3.2.0'`, and `ZodOpenApiMediaTypeObject` has `itemSchema?: $ZodType | SchemaObject | ReferenceObject`.
- **Prototype result:** ran unmodified under `node file.ts` and produced a 3.1.0 document with `Reply`, `Ticket` and `RevisionEvent` components **(verified)**.
- **Pitfall:** it emits `itemSchema` even when `openapi: '3.1.0'`. Redocly then reports `struct` error "Property `itemSchema` is not expected here" **(verified)**. The library does not stop you from writing 3.2-only fields into a 3.1 document.

**Trade-offs:**

- (+) The smallest correct path.
- (+) ESM with no transitive dependencies.
- (+) Uses Zod's own conversion.
- (+) Parameters and input/output are handled for us.
- (−) Adds one runtime or dev dependency. It is a single-maintainer project (samchungy), though it is used through `fastify-zod-openapi` and others.

## Option C: `@asteasolutions/zod-to-openapi`

Source: [asteasolutions/zod-to-openapi](https://github.com/asteasolutions/zod-to-openapi) README v9.1.0.

- **No `exports` map.** It has `"main": "dist/index.cjs"` and `"module": "dist/index.mjs"`. Node ignores `module`, so `import` from Node loads the **CJS** build through interop **(verified: `require.cache` shows `dist/index.cjs`)**. It still works from ESM, because Zod's global registry lives on `globalThis.__zod_globalRegistry` and is shared across instances.
- **Dependencies:** one runtime dependency, `openapi3-ts`. About 229 KB unpacked.
- **Its own Zod walker:** it walks `schema._zod.def` itself rather than calling `z.toJSONSchema`. Its output can therefore differ from Zod's, and it ships a list of supported types and "known issues".
- **API:** `OpenAPIRegistry` with `register`, `registerPath`, `registerParameter` and `registerWebhook`, plus `OpenApiGeneratorV3`, `V31` and `V32` with `generateDocument(config)`.
- **Metadata:** since v8, `.meta({ id, ... })` works without patching. `extendZodWithOpenApi(z)`, which adds a `.openapi()` method to Zod's prototype, is still needed for two cases: `.extend()` that renders as `allOf` against a registered parent, and parameter-level `param` metadata.
- **SSE:** `OpenApiGeneratorV32` supports `itemSchema` for `text/event-stream`, and the README shows an example. It emitted `itemSchema: { $ref: '#/components/schemas/RevisionEvent' }` **(verified)**.

**Trade-offs:**

- (+) An explicit registry and route list. This can double as the router table.
- (+) A separate generator class per version (3.0, 3.1, 3.2) keeps 3.2 fields out of a 3.1 document.
- (−) CJS under Node, plus a transitive dependency.
- (−) A second schema converter that can drift from Zod's own.
- (−) `extendZodWithOpenApi` monkey-patches Zod for the advanced cases.

## Describing SSE in OpenAPI

Sources: [OAS 3.1.1](https://spec.openapis.org/oas/v3.1.1.html) and [OAS 3.2.0 §4.14.3.1 Sequential Media Types, §4.14.4 Special Considerations for Server-Sent Events, §4.14.6.3 example](https://spec.openapis.org/oas/v3.2.0.html#sequential-media-types).

- **OpenAPI 3.1.x has no SSE model.** The 3.1.1 spec never mentions `text/event-stream` or `itemSchema` **(verified by searching the spec HTML)**. In 3.1, `content['text/event-stream'].schema` describes the whole body, which is just a string. The usual workarounds are:
  - `schema: { type: string }` plus a `description`
  - putting the event payload schema under `schema`, which is spec-incorrect but understood by some generators
  - an `x-` extension field
- **OpenAPI 3.2.0 adds `itemSchema`** on the Media Type Object. Here is what it says:
  - It "MUST be applied to each item in the stream" for sequential media types, and `text/event-stream` is listed among them.
  - For SSE, the schema applies to the _parsed_ event, with fields `data`, `event`, `id` and `retry`.
  - The spec gives a generic Event schema (`required: [data]`, `retry` an integer ≥ 0).
  - JSON carried in `data` is described with `contentMediaType: application/json` and `contentSchema`. The spec notes that `contentSchema` "is not automatically validated by default".
- **Tooling reality** **(verified)**:
  - **Redocly lint:**
    - Accepts `itemSchema` in a 3.2.0 document.
    - Rejects it in a 3.1.0 document.
  - **openapi-typescript 7.13:**
    - Its README says "Supports OpenAPI 3.0 and 3.1".
    - Ignores `itemSchema`: the SSE response becomes `"text/event-stream": string` (3.1 with a string schema) or `unknown` (3.2 with only `itemSchema`).
    - Still emits each event component under `components['schemas']`, so a client can import the payload type by name.
  - **@hey-api/openapi-ts 0.99:**
    - Detects `text/event-stream` and generates an SSE method (`client.sse.get(...)` returning `ServerSentEventsResult`).
    - Takes the event type from `schema`, not `itemSchema`: it typed it `string` for 3.1 and `unknown` for 3.2-only.
- **What this means:** a decision is needed between three options:
  1. Emit 3.1, model the event payloads as named components, and hand-type the SSE client.
  2. Emit 3.2, which is spec-correct with `itemSchema`, while today's TS generators do not use it.
  3. Emit 3.1 with the event schema under `schema`, which generators use but which is spec-wrong.

## CI drift check

The committed document has to match what the code generates. Two shapes fit this repo:

1. **Generate, then diff.** A script such as `node src/server/openapi.ts > openapi.json`, then `git diff --exit-code openapi.json` in `.github/workflows/ci.yml`.
   - Simple, and the error points straight at the file.
   - Output must be deterministic: stable key order and `JSON.stringify(doc, null, 2) + '\n'`.
   - asteasolutions has a `sortComponents: 'alphabetically'` option. zod-openapi chose its own order, which was not alphabetical in the prototype.
   - The file must also pass `oxfmt --check`, or be excluded from it.
   - The CI `paths` filter must include the document and the schema sources.
2. **A `node:test` file snapshot.** This matches the existing `STORIES_UPDATE=1` pattern in `src/stories/stories.test.ts`.
   - `t.assert.fileSnapshot(doc, 'openapi.json', { serializers: [v => JSON.stringify(v, null, 2) + '\n'] })` fails when the document is missing or different. `node --test --test-update-snapshots` rewrites it **(verified on Node 24.11: the written file was byte-identical to the generator output)**.
   - Snapshot testing has been non-experimental since v23.4.0 ([node:test docs](https://nodejs.org/docs/latest-v24.x/api/test.html#snapshot-testing)).
   - It runs under the existing `npm test` step, so no extra CI step is needed.

Optional extras:

- Lint the document with `@redocly/cli lint`. This is a large dev dependency: the recommended ruleset flags missing `summary`, `security` and `servers`, so it needs a config.
- Check breaking changes against `main` with an OpenAPI diff tool.

## SvelteKit client generation

- **[openapi-typescript](https://github.com/openapi-ts/openapi-typescript):**
  - Run `npx openapi-typescript ./openapi.json -o src/lib/api.d.ts`. It is ESM, with peer dependency `typescript ^5`.
  - Produces `paths`, `components` and `operations` types only, with no runtime code **(verified)**.
  - The dashboard can read `openapi.json` from this repo through a raw GitHub URL, a git submodule, or a published package. The tool accepts a URL or a local path.
- **[openapi-fetch](https://openapi-ts.dev/openapi-fetch/):**
  - The paired runtime, `createClient<paths>({ baseUrl, fetch })`, with one dependency.
  - The `fetch` option accepts a custom fetch, so SvelteKit's `load` `fetch` can be passed in.
  - Supports `parseAs: 'stream'`, which returns `Response['body']` for the SSE endpoint. Parsing the events (or using `EventSource`) and typing them from `components['schemas']` stays hand-written.
- **[@hey-api/openapi-ts](https://heyapi.dev/):**
  - Generates a fuller SDK including a typed SSE helper.
  - About 2.9 MB with 10 dependencies.
  - Its SSE typing reads `schema` rather than `itemSchema` (see above).

## Summary of trade-offs

|                                    | Native `z.toJSONSchema` | zod-openapi 6                    | @asteasolutions/zod-to-openapi 9  |
| ---------------------------------- | ----------------------- | -------------------------------- | --------------------------------- |
| Extra deps                         | none                    | 1 (no transitive deps)           | 1 (+ `openapi3-ts`)               |
| Module format under Node           | ESM (zod)               | ESM (`exports` → `.mjs`)         | CJS (`main`, no `exports`)        |
| Schema converter                   | Zod                     | Zod                              | own walker over `_zod.def`        |
| Params / input-output / components | hand-written            | automatic                        | automatic                         |
| Monkey patching                    | no                      | no                               | optional (`extendZodWithOpenApi`) |
| 3.2 `itemSchema` for SSE           | hand-written            | yes (also leaks into 3.1 output) | yes (V32 generator only)          |
| Runs under Node 24 type stripping  | yes (verified)          | yes (verified)                   | yes (verified)                    |

## Open questions for the decision ticket

- OpenAPI 3.1 or 3.2? That depends on whether a spec-correct SSE description matters more than generator support.
- Should responses be validated at runtime always, only in tests, or never?
- Should the drift check be a snapshot test or generate-and-diff?
- How does the dashboard repo get `openapi.json`: from a URL, a submodule, or a package?
