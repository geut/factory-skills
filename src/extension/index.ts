import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { type Component, type TUI } from '@earendil-works/pi-tui';
import { parseFactoryCommand } from '../controller/parse.ts';
import { createFactoryService, factoryPaths, type FactoryService } from '../controller/service.ts';
import { contextLabel } from '../runtime/session-activity.ts';
import { FactoryAgentsView } from './agents-view.ts';
import { factoryStatusPayload, factoryStatusRenderer } from './status-message.ts';
import { readChildActivity, renderFactoryWidget, type WidgetChild } from './widget.ts';

const services = new Map<string, FactoryService>();
let latest: ExtensionContext | null = null;
let frame = 0;
let tick: ReturnType<typeof setInterval> | null = null;
let widgetTui: TUI | null = null;
let closeOverlay: (() => void) | null = null;
let publishStatus: (text: string) => void = (text) => {
  latest?.ui.notify(text, 'info');
};

function widgetChildren(service: FactoryService): Array<WidgetChild> {
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

function refreshWidget(service: FactoryService): void {
  const ctx = latest;
  if (ctx === null || !ctx.hasUI) {
    return;
  }
  if (widgetChildren(service).length === 0) {
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
            theme,
            width,
          });
        },
      };
      return component;
    },
    { placement: 'aboveEditor' },
  );
  if (tick !== null) {
    return;
  }
  tick = setInterval(() => {
    frame += 1;
    widgetTui?.requestRender();
  }, 80);
}

function serviceFor(cwd: string): FactoryService {
  const paths = factoryPaths(cwd);
  const existing = services.get(paths.factoryRoot);
  if (existing !== undefined) {
    return existing;
  }
  const created = createFactoryService({
    ...paths,
    notify: (message) => {
      publishStatus(message);
    },
    onActivity: () => {
      refreshWidget(created);
    },
  });
  services.set(paths.factoryRoot, created);
  return created;
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

export default function factoryExtension(pi: ExtensionAPI): void {
  if (process.env['FACTORY_CHILD'] === '1') {
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
  pi.registerMessageRenderer('factory-status', factoryStatusRenderer);
  pi.registerCommand('factory', {
    description: 'Start or continue a factory ticket',
    handler: async (args, ctx) => {
      latest = ctx;
      if (parseFactoryCommand(args).kind === 'agents') {
        await toggleAgents(ctx);
        return;
      }
      publishStatus(await serviceFor(ctx.cwd).command(args));
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
    void serviceFor(ctx.cwd).recover();
  });
}
