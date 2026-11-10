# API, job and CLI tests in QA

For a product without a UI, or a criterion about an HTTP response, a job's effect, or a command's output. The test still proves the criterion from the outside: it calls the product the way a client, a scheduler, or a person at a terminal would, and asserts what they would observe.

## Find the project's harness

- **Test client**: the fixture the project's request tests already use, such as Django's `client`, FastAPI's `TestClient(app)`, `supertest(app)`, a Rails request spec, or Go's `httptest`. Read one existing request test and copy its setup.
- **Data**: the factories or seed helpers the suite already has, and how the test database is created (a pytest fixture, `RefreshDatabase`, a transaction per test, a migrated template database). Create the rows a criterion needs through them.
- **Jobs**: how the suite already runs background work synchronously: an eager or inline queue setting, calling the task function directly, or running the scheduled command.
- **CLI**: the project's runner for commands, such as Click's `CliRunner`, `call_command`, or a subprocess with the built binary.

`.factory/CONTEXT.md` (Commands, Test layers, Fixtures and fakes) names these when an earlier ticket found them.

## Assert what a caller observes

- **API**: the status code, the response body fields the criterion names, and the persisted effect: the row written, the row gone. Read the effect through the project's models or a second request, the way a client would see it.
- **Job**: its effect after one synchronous run: the rows it changed, the message it handed to a fake mailer or queue, the file it wrote.
- **CLI**: stdout or stderr, the exit code, and any file it writes.

One criterion, one short test, named after the behavior, such as `test_create_order_returns_201`, in the existing test module for that endpoint, job or command.

## Keep tests isolated

- Each test creates its own data and leaves the database as it found it, through the suite's transaction or truncation fixture.
- Several worktrees can share one database server. Give each run its own database, the way the project's config allows (a per-run name, a template database, the worktree's own `.env`), and keep every test inside it.
- Mock outbound HTTP at the boundary with the project's tool (`responses`, `respx`, `nock`, `msw`, WebMock), and fake third-party services through the suite's existing fakes.

## Run fast

- Write the test first and learn a command's or endpoint's output from its first run.
- Run one test and stop at the first failure: `pytest tests/api/test_orders.py -x -k create`, `npx vitest run src/api/orders.test.ts -t "returns 201"`, `bundle exec rspec spec/requests/orders_spec.rb:12 --fail-fast`.
- Exercise the product through the test client, in-process. When the project's tests need a running server, use the harness's own setup for it, as its existing tests do.

An API, job or CLI criterion has no screen, so its test plan row's screenshot is `none`.
