import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { type Component, type TUI } from '@earendil-works/pi-tui';
import { piAgentDir } from '../actions/review-rules.ts';
import { parseFactoryCommand } from '../controller/parse.ts';
import type { TicketProgress } from '../controller/progress.ts';
import { factoryPaths } from '../controller/service.ts';
import { runsCommands, type TicketStep } from '../controller/steps.ts';
import type { TicketDetail } from '../controller/view.ts';
import { contextLabel } from '../runtime/session-activity.ts';
import { factoryPackage } from '../server/pi-extension.ts';
import { FactoryAgentsView } from './agents-view.ts';
import {
  createFactoryClient,
  type FactoryClient,
  type LiveCommand,
  type PendingFeedbackView,
} from './factory-client.ts';
import { FactoryFeedbackPicker } from './feedback-picker.ts';
import { factoryStatusPayload, factoryStatusRenderer } from './status-message.ts';
import { FactoryTicketView } from './ticket-view.ts';
import {
  renderUpdateFooter,
  updateNoticeRenderer,
  updateNoticeText,
  type UpdateNotice,
} from './update-notice.ts';
import {
  readChildActivity,
  renderFactoryWidget,
  withCommands,
  type WidgetChild,
} from './widget.ts';

// Pi never hosts the controller (ADR-003): it reads the database and sends
// commands to the factory server.
const clients = new Map<string, FactoryClient>();
// How often Pi looks for new events to show.
const POLL_MS = 1000;
let poll: ReturnType<typeof setInterval> | null = null;
let seenRevision = 0;
let seenActions = '';
let latest: ExtensionContext | null = null;
let frame = 0;
let tick: ReturnType<typeof setInterval> | null = null;
let widgetTui: TUI | null = null;
let tickets: Array<TicketProgress> = [];
let steps: Array<TicketStep> = [];
// The commands long steps are running, from the server; see refreshCommands.
let liveCommands = new Map<string, LiveCommand>();
let fetchingCommands = false;
let closeOverlay: (() => void) | null = null;
let publishStatus: (text: string) => void = (text) => {
  latest?.ui.notify(text, 'info');
};
let publishUpdate: (notice: UpdateNotice) => void = (notice) => {
  latest?.ui.notify(updateNoticeText(notice), 'info');
};
// The update announcement this session has seen, so a session posts the card
// only for a release found while it runs, and the footer line it shows.
let seenAnnounced: string | null = null;
let shownFooter: string | undefined;

// Posts the card for a newly announced release and keeps the footer line.
function refreshUpdate(service: FactoryClient): void {
  const { announcedAt, update } = service.updateState();
  if (announcedAt !== seenAnnounced) {
    seenAnnounced = announcedAt;
    if (announcedAt !== null && update !== null && !update.later) {
      publishUpdate(update);
    }
  }
  const ctx = latest;
  if (ctx === null || !ctx.hasUI) {
    return;
  }
  const footer =
    update === null
      ? undefined
      : renderUpdateFooter({ later: update.later, latest: update.latest, theme: ctx.ui.theme });
  if (footer !== shownFooter) {
    shownFooter = footer;
    ctx.ui.setStatus('factory-update', footer);
  }
}

function widgetChildren(service: FactoryClient): Array<WidgetChild> {
  const registry = latest?.modelRegistry;
  return service.runningChildren().map((row) => {
    const observed = readChildActivity(row.sessionFile);
    const slash = row.model.indexOf('/');
    const provider = observed.provider ?? (slash === -1 ? null : row.model.slice(0, slash));
    const modelId = observed.model ?? (slash === -1 ? row.model : row.model.slice(slash + 1));
    const contextWindow =
      registry === undefined || provider === null || modelId.length === 0
        ? null
        : (registry.find(provider, modelId)?.contextWindow ?? null);
    return {
      ...row,
      activity: observed.activity,
      context: contextLabel(observed.contextTokens, contextWindow),
      toolUses: observed.toolUses,
    };
  });
}

function stopTick(): void {
  if (tick === null) {
    return;
  }
  clearInterval(tick);
  tick = null;
}

function refreshWidget(service: FactoryClient): void {
  const ctx = latest;
  if (ctx === null || !ctx.hasUI) {
    return;
  }
  // Progress is read on activity, not on every spinner frame.
  tickets = service.progress();
  steps = service.controllerSteps();
  // A controller step keeps the spinner and its elapsed time moving too.
  const running =
    widgetChildren(service).length > 0 || steps.some((item) => item.step.state === 'running');
  if (!running && tickets.length === 0) {
    ctx.ui.setWidget('factory-agents', undefined);
    stopTick();
    return;
  }
  ctx.ui.setWidget(
    'factory-agents',
    (tui, theme) => {
      widgetTui = tui;
      const component: Component = {
        invalidate() {
          return undefined;
        },
        render(width) {
          return renderFactoryWidget({
            children: widgetChildren(service),
            frame,
            now: Date.now(),
            steps: withCommands(steps, liveCommands),
            theme,
            tickets,
            width,
          });
        },
      };
      return component;
    },
    { placement: 'aboveEditor' },
  );
  if (!running) {
    stopTick();
    return;
  }
  if (tick !== null) {
    return;
  }
  tick = setInterval(() => {
    frame += 1;
    widgetTui?.requestRender();
  }, 80);
}

// Asks the server which commands long steps are running, once a second and
// only while such a step runs: the database does not keep them. A server
// that does not answer leaves the steps without their commands.
function refreshCommands(service: FactoryClient): void {
  if (fetchingCommands) {
    return;
  }
  if (!steps.some((item) => runsCommands(item.step))) {
    if (liveCommands.size > 0) {
      liveCommands = new Map();
      widgetTui?.requestRender();
    }
    return;
  }
  fetchingCommands = true;
  void service
    .stepCommands()
    .then((found) => {
      liveCommands = found;
      widgetTui?.requestRender();
    })
    .finally(() => {
      fetchingCommands = false;
    });
}

function serviceFor(cwd: string): FactoryClient {
  const { factoryRoot } = factoryPaths(cwd);
  const existing = clients.get(factoryRoot);
  if (existing !== undefined) {
    return existing;
  }
  const created = createFactoryClient({ factoryRoot });
  clients.set(factoryRoot, created);
  return created;
}

// Shows the cards the server posted since the last look, and refreshes the
// widget when anything changed.
function watch(service: FactoryClient): void {
  if (poll !== null) {
    clearInterval(poll);
  }
  seenRevision = service.revision();
  seenActions = service.actionsVersion();
  // A release announced before this session started shows in the footer
  // only; the session that was running then posted its card.
  seenAnnounced = service.updateState().announcedAt;
  shownFooter = undefined;
  refreshUpdate(service);
  refreshWidget(service);
  poll = setInterval(() => {
    refreshCommands(service);
    refreshUpdate(service);
    const revision = service.revision();
    // A controller step starts and ends with no event, only an action change.
    const actions = service.actionsVersion();
    if (revision === seenRevision && actions === seenActions) {
      return;
    }
    for (const { card } of service.cardsSince(seenRevision)) {
      publishStatus(card);
    }
    seenRevision = revision;
    seenActions = actions;
    refreshWidget(service);
  }, POLL_MS);
  poll.unref();
}

async function toggleAgents(ctx: ExtensionContext): Promise<void> {
  if (closeOverlay !== null) {
    closeOverlay();
    return;
  }
  if (ctx.mode !== 'tui' || !ctx.hasUI) {
    return;
  }
  const service = serviceFor(ctx.cwd);
  let closed = false;
  await ctx.ui.custom<undefined>(
    (tui, theme, _keybindings, done) => {
      const finish = (): void => {
        if (closed) {
          return;
        }
        closed = true;
        closeOverlay = null;
        done(undefined);
      };
      closeOverlay = finish;
      return new FactoryAgentsView(() => widgetChildren(service), theme, tui, finish);
    },
    {
      overlay: true,
      overlayOptions: { anchor: 'center', margin: 0, maxHeight: '100%', width: '100%' },
    },
  );
  closeOverlay = null;
}

async function openTicket(ctx: ExtensionContext, load: () => TicketDetail | null): Promise<void> {
  if (ctx.mode !== 'tui' || !ctx.hasUI) {
    return;
  }
  if (closeOverlay !== null) {
    closeOverlay();
  }
  let closed = false;
  await ctx.ui.custom<undefined>(
    (tui, theme, _keybindings, done) => {
      const finish = (): void => {
        if (closed) {
          return;
        }
        closed = true;
        closeOverlay = null;
        done(undefined);
      };
      closeOverlay = finish;
      return new FactoryTicketView(load, theme, tui, finish);
    },
    {
      overlay: true,
      overlayOptions: { anchor: 'center', margin: 0, maxHeight: '100%', width: '100%' },
    },
  );
  closeOverlay = null;
}

// Opens the picker; resolves with the refs to start a round on, or `false`
// when the operator closed it.
async function pickFeedback(
  ctx: ExtensionContext,
  listed: PendingFeedbackView,
  note: string | null,
): Promise<{ only: Array<string> | null } | false> {
  if (closeOverlay !== null) {
    closeOverlay();
  }
  let closed = false;
  const picked = await ctx.ui.custom<{ only: Array<string> | null } | false>(
    (tui, theme, _keybindings, done) => {
      const finish = (choice: { only: Array<string> | null } | false): void => {
        if (closed) {
          return;
        }
        closed = true;
        closeOverlay = null;
        done(choice);
      };
      closeOverlay = () => finish(false);
      return new FactoryFeedbackPicker({
        closeView: () => finish(false),
        start: (choice) => finish(choice),
        state: {
          candidates: listed.candidates,
          displayRef: listed.displayRef,
          note,
          pullRequestUrl: listed.pullRequestUrl,
          skipped: listed.skipped.length,
          truncated: listed.truncated,
        },
        theme,
        tui,
      });
    },
    {
      overlay: true,
      overlayOptions: { anchor: 'center', margin: 0, maxHeight: '100%', width: '100%' },
    },
  );
  closeOverlay = null;
  return picked ?? false;
}

// True in the copy the factory binary installs into Pi's agent directory.
declare const FACTORY_BUNDLED_EXTENSION: boolean | undefined;

export default function factoryExtension(pi: ExtensionAPI): void {
  if (process.env['FACTORY_CHILD'] === '1') {
    return;
  }
  // The binary's copy is global to the machine. Where Pi also loads
  // factory-skills from a package (a pinned install, or a checkout someone is
  // working on), that copy is the one meant here, so this one steps aside.
  if (
    typeof FACTORY_BUNDLED_EXTENSION === 'boolean' &&
    FACTORY_BUNDLED_EXTENSION &&
    factoryPackage({ agentDir: piAgentDir(process.env), cwd: process.cwd() }) !== null
  ) {
    return;
  }
  publishStatus = (text) => {
    const status = factoryStatusPayload(text);
    pi.sendMessage(
      {
        content: status.content,
        customType: 'factory-status',
        details: status.details,
        display: true,
      },
      { triggerTurn: false },
    );
  };
  publishUpdate = (notice) => {
    pi.sendMessage(
      {
        content: updateNoticeText(notice),
        customType: 'factory-update',
        details: notice,
        display: true,
      },
      { triggerTurn: false },
    );
  };
  pi.registerMessageRenderer('factory-status', factoryStatusRenderer);
  pi.registerMessageRenderer('factory-update', updateNoticeRenderer);
  pi.registerCommand('factory', {
    description: 'Start or continue a factory ticket',
    handler: async (args, ctx) => {
      latest = ctx;
      const parsed = parseFactoryCommand(args);
      if (parsed.kind === 'agents') {
        await toggleAgents(ctx);
        return;
      }
      if (parsed.kind === 'ticket') {
        const service = serviceFor(ctx.cwd);
        const detail = service.ticketDetail(parsed.ref);
        if (typeof detail === 'string') {
          publishStatus(detail);
          return;
        }
        await openTicket(ctx, () => {
          const next = service.ticketDetail(parsed.ref);
          return typeof next === 'string' ? null : next;
        });
        return;
      }
      if (parsed.kind === 'update' && parsed.mode !== 'install') {
        const service = serviceFor(ctx.cwd);
        const reply = await service.update(parsed.mode);
        if (reply.kind === 'notice') {
          publishUpdate(reply.notice);
        } else {
          publishStatus(reply.text);
        }
        // The reply already showed what the check found.
        seenAnnounced = service.updateState().announcedAt;
        refreshUpdate(service);
        return;
      }
      // In the terminal, --list opens the picker; elsewhere it posts the card.
      if (parsed.kind === 'feedback' && parsed.list && ctx.mode === 'tui' && ctx.hasUI) {
        const service = serviceFor(ctx.cwd);
        const listed = await service.pendingFeedback(parsed.ref);
        if (typeof listed === 'string') {
          publishStatus(listed);
          return;
        }
        const picked = await pickFeedback(ctx, listed, parsed.note);
        if (picked === false) {
          return;
        }
        publishStatus(await service.command({ ...parsed, list: false, only: picked.only }));
        refreshWidget(service);
        return;
      }
      const service = serviceFor(ctx.cwd);
      publishStatus(await service.command(parsed));
      refreshWidget(service);
    },
  });

  try {
    pi.registerShortcut('alt+s', {
      description: 'Toggle factory agents',
      handler: (ctx) => {
        latest = ctx;
        void toggleAgents(ctx);
      },
    });
  } catch {
    // Alt+S is already taken; /factory agents stays available.
  }

  pi.on('session_start', (_event, ctx) => {
    latest = ctx;
    watch(serviceFor(ctx.cwd));
  });
}
