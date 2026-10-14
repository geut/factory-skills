# ADR-003: A factory server owns the controller, and Pi becomes a client

- **Status:** Accepted, lands with the factory server
- **Date:** 2026-10-14
- **Builds on:** [ADR-001](../../ADR.md)

The controller used to live inside the Pi extension, so it ran only while a Pi session was open, and commands could only arrive through `/factory`. A REST API that clients like the dashboard can use to start tickets, reply, and retry needs a process that keeps running whether or not anyone has Pi open. We moved the controller, the action dispatcher, and the run watchers into a factory server, one per factory root, started explicitly with `factory serve` inside a Herdr pane. The Pi extension stops hosting the controller. It sends commands to the server over HTTP and still reads SQLite directly for status, cards, and the widget.

## Considered options

- **Keep the controller in Pi and add an API process next to it** that writes commands into an inbox table. Reads would work without Pi, but actions would not.
- **Pi auto-starts a detached server.** The server's lifetime and environment (PATH, Herdr variables) would then depend on whichever Pi session happened to spawn it.
- **A fallback mode where Pi hosts the controller when no server runs.** That brings back two dispatchers on one database.

## Consequences

- Only one process may dispatch per `.factory` database. The server holds an owner lease row in SQLite with its instance id, URL, and heartbeat. A second server refuses to start while the lease is live, and action leases carry the instance id instead of a fixed owner. Local clients find the server and check that it is alive through the same row. There is no `server.json`.
- Commands return once their transaction commits. Problems found before that, such as an issue that cannot be resolved, come back synchronously. Agent launches happen afterwards, and clients learn about them from state.
- Pi notices changes by polling `events.revision`. It renders cards from runs that finished since its cursor, so the server never pushes messages to Pi.
- The server refuses to start outside a Herdr pane. Its pane's workspace is the factory workspace: each ticket gets its own tab, named after the ticket, which holds its agent panes and its handoff panes. `/factory complete` closes the tab.
- Stopping the server leaves agent panes running. Starting it takes the lease and runs `recover()`, which adopts live panes, requeues orphaned work, and re-arms watchers.
- The move is a hard cut. The first server start adopts an existing database through `recover()`, and there is no compatibility mode in the extension.
- Agents keep their file-based handshake (`subagent_done`, `caller_ping` from `src/runtime/child-handshake.ts`), which never depended on the parent Pi session.
