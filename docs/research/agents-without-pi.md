# Can the controller launch and watch agents without a parent Pi session?

Research for geut/factory-skills#15 (map #14). Facts only, no design decision. Code refs are at commit `f764b00`.

## Short answer

Yes, mostly. The launch, watch, and recover path in `src/runtime/` and `src/controller/` runs on plain Node APIs: `child_process.spawn('herdr', …)`, `fs`, `net`, and `node:sqlite`. It imports nothing from Pi. The coupling to a parent Pi session lives in four places:

1. **Hosting.** The Pi extension is the only thing that creates the controller, delivers notifications, and calls `recover()`.
2. **Pane placement.** Panes open as a split of `HERDR_PANE_ID`, which Herdr injects only into processes running inside a Herdr pane.
3. **Event socket discovery.** The code reads only `HERDR_SOCKET_PATH`, and without it falls back to polling.
4. **Single-owner assumptions.** The in-memory watchers and the fixed `lease_owner` assume exactly one controller process.

The child side does not need a parent session. Each child is its own `pi` process, and it reports back through sidecar files, not through a parent model.

## Two different "Pi" roles

- **Parent Pi.** Pi loads `src/extension/index.ts` as an extension (`package.json` `pi.extensions`). It hosts the controller in-process.
- **Child Pi.** Each stage runs as a separate `pi --session <file> -e child-handshake.ts …` process inside a Herdr pane (`src/runtime/pi-herdr.ts:222-231`). This is the agent itself. Removing the parent does not remove it.

## What the launch/watch/recover path depends on

### Launch (`openPane`, `src/runtime/pi-herdr.ts:591-636`)

- `openPane` writes `<session>.prompt` and `<session>.sh`, then runs `herdr plugin pane open --plugin pi-herdr-subagents --entrypoint argv --placement split --target-pane <id> --direction right …` (`pi-herdr.ts:179-204`, `613-615`). It then runs `herdr pane rename` and `herdr pane report-metadata` (`623-628`).
- `targetPaneId` defaults to `process.env.HERDR_PANE_ID` (`pi-herdr.ts:538`), and the code throws `HERDR_PANE_ID is required to launch a factory child` when it is empty (`592-594`). Handoff panes have the same guard (`667-669`).
- The session file path is chosen by the controller, not by Pi: `<factoryRoot>/sessions/<sessionId>.jsonl` (`src/actions/dispatch.ts:184-185`). It is passed to the child as `--session <path>` (`pi-herdr.ts:227`).
- `piBin` defaults to `'pi'` and `freshBin` to `FACTORY_FRESH_BIN` or `'fresh'` (`pi-herdr.ts:536-537`). Upstream says the plugin dispatcher runs non-interactive, non-login bash and recommends absolute binary paths ([pi-herdr-subagents README][phs]). A bare `pi` therefore depends on the PATH that the Herdr server hands to the dispatcher, not on the caller's PATH.

### Child handshake (`src/runtime/child-handshake.ts`)

- This file is a Pi extension loaded into the **child** with `-e` (`pi-herdr.ts:206-208`, `227`). It registers the `subagent_done` and `caller_ping` tools (`child-handshake.ts:98-124`). Each tool writes `<PI_SUBAGENT_SESSION>.exit` as JSON and calls `process.exit(0)` (`71-88`, `102-103`, `114-119`).
- The launch script sets `PI_SUBAGENT_SESSION`, `PI_SUBAGENT_AUTO_EXIT=1`, and `FACTORY_CHILD=1` (`pi-herdr.ts:224-226`). It writes `<session>.exitcode` as `"<code> <runId>"` after `pi` exits (`228-229`).
- The `agent_end` handler auto-exits with a `done` sidecar. Failed turns trigger nudges, and the child exits with code 1 after three nudges (`child-handshake.ts:126-147`).
- `PI_SUBAGENT_NAME` is optional and falls back to `'factory'` (`90-93`).
- Nothing here reads parent state. The handshake is file-based end to end.

### Skills and prompts

- Stage skills tell the model to call `subagent_done` and `caller_ping` (for example `skills/factory-plan/SKILL.md:25,62`, `skills/factory-review/SKILL.md:28`). `src/stages/prompt.ts:3-14` lists both tools as handshake tools.
- The tools are defined by the child handshake extension, not by a parent. `factory-plan/SKILL.md:25` says the *controller* persists the question and resumes the session after an answer. No parent model is involved.

### `FACTORY_CHILD`

- `FACTORY_CHILD` is set in child and handoff pane scripts (`pi-herdr.ts:226`, `248`). Its only reader is `factoryExtension`, which returns early when it is `'1'` (`src/extension/index.ts:185-187`).
- It exists so a child Pi that auto-discovers the `factory-skills` package does not start a second controller. It does not change how the controller launches or watches children.

### Watch (`observe`, `pi-herdr.ts:695-754`)

- Polling: `setInterval(check, pollMs)` with `pollMs` defaulting to 5000 ms (`520`, `743`). `check` reads the session JSONL, `.exitcode`, and `.exit` from disk and classifies them (`712-742`, classification at `115-177`).
- Events: `connectHerdrEvents` opens a Unix socket to `HERDR_SOCKET_PATH`, sends `events.subscribe` for `pane.exited` and `pane.closed`, and reconnects with backoff (`src/runtime/herdr-events.ts:160-261`).
  - If `HERDR_SOCKET_PATH` is empty, events are disabled and only polling runs (`pi-herdr.ts:550-554`).
  - When events are off, a closed pane with no sidecars never classifies as `pane_killed`, because `trigger` stays `'sidecar'` (`724`). The run stays pending until `recover()` runs.
- Output and usage are parsed from the session JSONL in Pi's format (`usageFromSession` at `329-362`, `lastAssistantText` in `src/runtime/session-activity.ts:73`). A plain Node reader can do this. It depends on Pi's session format, not on a running Pi.
- Watchers live in an in-memory `Map` per runtime instance (`pi-herdr.ts:540`, `697`). They do not survive process exit, and two processes would double-watch.

### Recover (`recover`, `src/controller/service.ts:210-237`)

- `recover` calls `runtime.reconcile`. For each active run, `reconcile` reads the sidecars and, when they are inconclusive, runs `herdr pane get <paneId>`. A zero exit code means `still_running` and a nonzero one means `missing` (`pi-herdr.ts:756-795`). After that, `recover` requeues orphaned validations and panes, drains the action queue, and re-arms watchers (`service.ts:229-236`).
- **Its only caller is Pi's `session_start` hook** (`src/extension/index.ts:239-242`). Without a parent Pi, nothing calls it.

### Resume (`resume`, `pi-herdr.ts:638-664`)

- `resume` runs `herdr pane process-info --pane <id>` to decide whether the previous pane is live (`258-260`, `289-308`). If it is, `resume` sends the next prompt with `herdr agent prompt <pane> <prompt>` (`262-264`, `643`). Otherwise it closes the pane and opens a new one, which hits the same `HERDR_PANE_ID` guard.

### Interrupt

- `interrupt` is a no-op (`pi-herdr.ts:693`).

### Controller hosting (`src/extension/index.ts`)

- `createFactoryService` is called only from `serviceFor` in the extension (`index.ts:105-122`). The service has no Pi imports: `service.ts:1-54` imports `node:sqlite`, `fs`, `path`, and in-repo modules.
- `notify` is wired to `pi.sendMessage` with a custom `factory-status` message (`index.ts:113-115`, `188-199`). `onActivity` drives a Pi TUI widget (`116-118`, `56-103`). Both are optional (`service.ts:111-112`).
- Commands (`start`, `reply`, `retry`, `complete`, `status`) arrive only through the `/factory` Pi command (`index.ts:201-225`), but `FactoryService.command(args)` takes a plain string (`service.ts:403`).
- `factoryPaths(cwd)` takes `cwd` from Pi's `ctx.cwd`, or uses `FACTORY_ROOT` when it is set (`service.ts:489-497`).
- The widget's model context window comes from `ctx.modelRegistry` (`index.ts:29-38`). This is display only.

### Single-owner assumptions in state

- `claimNextAction` leases with the hard-coded `lease_owner = 'factory-controller'` and a 30 s lease (`src/controller/store.ts:1615-1640`).
- The in-process guards are per-process: the `dispatching`/`rerun` flags (`service.ts:116-117`), `liveValidations` (`115`), and the `watchers` map (`pi-herdr.ts:540`).
- With both a factory server and a Pi parent loading the extension, the same `.factory` DB would have two dispatchers and two sets of watchers.

## Can Herdr panes be spawned, observed, and reconciled from a plain Node process?

From Herdr's docs (the `herdr` binary is not installed in this sandbox, so none of this was run):

- **Server and socket.** The CLI and integrations talk to a local socket. The default path is `~/.config/herdr/herdr.sock`, and named sessions use `~/.config/herdr/sessions/<name>/herdr.sock`. Resolution order is `--session`, then `HERDR_SOCKET_PATH`, then `HERDR_SESSION`, then the default. The protocol is newline-delimited JSON, and no authentication is described ([Socket API][sock]). `herdr server` runs a headless server "for supervised or service-style setups" ([CLI reference][cli]).
- **Spawning without a caller pane.**
  - `herdr workspace create --cwd … --label … --no-focus` returns `.result.root_pane.pane_id`. `tab create` returns a root pane too, but it fails without an active workspace unless `--workspace` is given. `pane split <pane_id>` takes an explicit target and, when the target is omitted, splits `HERDR_PANE_ID` or else the focused pane ([CLI reference][cli], [Agent automation][auto]).
  - `plugin pane open` accepts `--placement overlay|popup|split|tab|zoomed`, `--workspace ID`, and an optional `--target-pane` ([CLI reference][cli]).
  - A Node process outside Herdr can therefore create a workspace, take its root pane id, and split from it. The docs do not say which `--target-pane` a `split` placement uses when the flag is omitted. **Unverified.**
- **Observing.** `events.subscribe` with `pane.exited` and `pane.closed` works over the same socket ([Socket API][sock]). `herdr-events.ts` already uses plain `node:net`; it only needs a socket path. Upstream notes that `pane.exited` carries no exit code, which is why `.exitcode` exists ([pi-herdr-subagents README][phs]).
- **Reconciling.** `pane get`, `pane list [--workspace]`, and `pane process-info --pane ID` take explicit ids ([CLI reference][cli]), so they work from any process that can reach the socket.
- **Plugin dependency.** The `pi-herdr-subagents` Herdr plugin and its `argv` entrypoint must be installed in the Herdr server (`pi-herdr.ts:185-191`). Upstream also documents the Pi-side `pi-herdr-subagents` extension, which activates only when `HERDR_ENV`, `HERDR_PANE_ID`, and `HERDR_SOCKET_PATH` are present ([pi-herdr-subagents README][phs]). Factory does not use that extension. It uses only the plugin's generic `argv` launcher.

## Pi alternatives to a pane (for reference only)

Pi documents non-TUI ways to run an agent: `--print`, `--mode json` (JSONL events, then exit), `--mode rpc` (long-lived JSONL command/event stream), and an embeddable SDK (`docs/cli-integration.md:9-16`, `docs/rpc.md`, `docs/sdk.md` in `@earendil-works/pi-coding-agent` 1.0.4). The current runtime uses none of them. It runs interactive `pi` inside a Herdr pane and watches files.

## Blockers and what removing each takes

| # | Blocker | Where | What removing it takes |
|---|---|---|---|
| 1 | `recover()` runs only from Pi `session_start` | `src/extension/index.ts:239-242` | The host process calls `service.recover()` at startup. The function itself has no Pi dependency (`service.ts:210-237`). |
| 2 | The controller is constructed only by the Pi extension, so commands arrive only via `/factory` | `index.ts:105-122`, `201-225` | Call `createFactoryService({ codeRoot, factoryRoot, notify, onActivity })` from Node and route commands to `service.command(string)` (`service.ts:95-107`, `403`). `notify` and `onActivity` are optional callbacks. |
| 3 | `HERDR_PANE_ID` is required to open any pane (split placement) | `pi-herdr.ts:538`, `592-594`, `667-669`, `193-197` | Pass `targetPaneId` explicitly (the option already exists, `pi-herdr.ts:533`), using a pane the host owns, such as the root pane from `herdr workspace create`. The alternative is to change `herdrPaneArgs` to a placement or `--workspace` that needs no target. Whether `plugin pane open` works without `--target-pane` is unverified. |
| 4 | The event stream needs `HERDR_SOCKET_PATH`, otherwise watching is poll-only and a killed pane with no sidecars is not detected until recover | `pi-herdr.ts:550-554`, `724` | Pass `socketPath` (the option exists, `pi-herdr.ts:532`) or resolve Herdr's default `~/.config/herdr/herdr.sock` or the named-session path ([Socket API][sock]). |
| 5 | `herdr` and `pi` are resolved by bare name, and `pi` resolves inside the Herdr dispatcher's non-login bash | `pi-herdr.ts:421`, `536`, `227` | Set `piBin` to an absolute path (the option exists, `pi-herdr.ts:529`), and make sure `herdr` is on the host process PATH. Upstream recommends absolute paths ([pi-herdr-subagents README][phs]). |
| 6 | Two controllers on one `.factory` DB: a fixed `lease_owner` and per-process watchers and dispatch flags | `store.ts:1634`, `service.ts:115-117`, `pi-herdr.ts:540` | Make sure only one process hosts the service, for example by having the Pi extension stop creating it. The other option is to give leases a real owner and fence watchers across processes. The `FACTORY_CHILD` early return (`index.ts:185`) only guards children, not a human's own Pi session. |
| 7 | Parent-only UI: the status renderer, widget, overlays, and `modelRegistry` context window | `index.ts:28-46`, `56-103`, `124-182`, `188-200` | Not on the launch, watch, or recover path. A server needs its own surface for `notify`, progress, and `runningChildren()` (`service.ts:85-93`). |
| 8 | `interrupt` is a no-op | `pi-herdr.ts:693` | It has nothing to do with the parent. If the server needs it, it has to be implemented, for example with `herdr pane close` or `agent send-keys` ([Agent automation][auto]). |

**Not blockers:**

- `child-handshake.ts`, `subagent_done`, and `caller_ping` are child-side and file-based.
- `FACTORY_CHILD` only suppresses the extension in children.
- Session JSONL paths are controller-chosen files under `.factory/sessions` and are parsed with plain `fs`.
- `reconcile` uses `herdr pane get` with an explicit pane id.

## Sources

- This repo at `f764b00`: the files cited inline.
- `@earendil-works/pi-coding-agent` 1.0.4 docs in `node_modules`: `cli.md`, `cli-integration.md`, `rpc.md`, `sdk.md`, `session-format.md`, `extensions.md`.
- [Herdr CLI reference][cli], [Herdr Socket API][sock], [Herdr agent automation][auto].
- [pi-herdr-subagents README][phs].

[cli]: https://herdr.dev/docs/cli-reference/
[sock]: https://herdr.dev/docs/socket-api/
[auto]: https://herdr.dev/docs/agent-automation/
[phs]: https://github.com/modem-dev/pi-herdr-subagents
