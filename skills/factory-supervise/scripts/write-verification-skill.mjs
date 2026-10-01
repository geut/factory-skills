#!/usr/bin/env node
/**
 * Write a project-local verification skill under <factory-root>/skills/verify-<repo>/.
 * The agent still has to prove one mapped feature before treating the skill as ready.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

function repoName(codeRoot) {
  return path.basename(codeRoot).replace(/[^\w.-]+/g, "-");
}

function readPackage(codeRoot) {
  const file = path.join(codeRoot, "package.json");
  if (!existsSync(file)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function detect(codeRoot) {
  const pkg = readPackage(codeRoot);
  const scripts = pkg?.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
  const hasPnpm = existsSync(path.join(codeRoot, "pnpm-lock.yaml"));
  const pm = hasPnpm ? "pnpm" : existsSync(path.join(codeRoot, "package-lock.json")) ? "npm" : "pnpm";
  const dev = typeof scripts.dev === "string" ? scripts.dev : null;
  const web = Boolean(dev && /vite|next|svelte|astro|webpack|serve/i.test(dev));
  return { pm, dev, web, scripts };
}

export function renderVerificationSkill({ codeRoot, factoryRoot, repo }) {
  const found = detect(codeRoot);
  const name = repo || repoName(codeRoot);
  const launch = found.dev
    ? found.pm === "npm"
      ? "npm run dev"
      : `${found.pm} dev`
    : 'echo "no dev script found; set the launch command before using this skill"';
  const skill = `---
name: verify-${name}
description: Drive ${name} the way a user does and capture evidence. Use before marking a task ready for review and before ticket wrap-up.
---

# Verify ${name}

Factory root: \`${factoryRoot}\`. Code root: \`${codeRoot}\`. Run this from the ticket worktree, never from a shared checkout.

## Launch

${found.dev ? `Start the app with \`${launch}\` on a free port owned by this worktree. Do not reuse a server started outside the worktree.` : "This repository has no detected dev server. Launch the real artifact this task changes and record the exact command."}

Ready means the process answers on its own port, or a CLI/TUI prints its ready prompt. Record the pid and port.

## Doctor

Confirm the process is the one this worktree started, the port is free of other checkouts, and required env (database URL, auth) points at scratch state. Stop if doctor fails.

## Drive

Exercise the user-visible path named in the task acceptance criteria. Prefer routes, labels, and commands from this repo. Do not call internal setters or test-only endpoints.

${found.web ? `For browser proof, give this worktree its own Surf session:

\`\`\`sh
export SURF_SESSION="${name}-$(basename "$PWD")"
surf session.ensure "$SURF_SESSION" about:blank
surf go "$URL"
surf wait.ready
surf read
\`\`\`

Capture desktop and narrow viewports, read the rendered text, check \`surf console\` and \`surf network.stats\`, and use \`--auto-capture\` on failure-prone waits. Run \`surf smoke --urls "$URL" --screenshot <evidence-dir>\` when the page is the proof.` : "Capture the command, exit code, and the resulting files or output. A compile or typecheck is not proof."}

## Evidence

Write \`${factoryRoot}/evidence/<ticket>/<task>/manifest.json\`:

\`\`\`json
{
  "ticket": "<ticket>",
  "task": "<task>",
  "criteria": [
    { "id": "AC1", "command": "<exact command>", "cwd": "<worktree>", "exitCode": 0, "artifact": "<path>" }
  ],
  "verifiedAt": "<UTC timestamp>"
}
\`\`\`

Proof artifacts stay in that evidence directory. Cleanup must not delete them.

## Cleanup

Stop only the process this run started. Close the Surf session this run created. Leave the evidence directory in place.
`;
  const feature = `# ${name}

## Sub-features

- Primary path detected from the repository. Add one file per user-facing feature.

## How to get to it (user POV)

${found.web ? "Open the worktree dev server in its own Surf session." : "Run the repository's documented command from the worktree."}

## Driving it with the harness

Use the Launch and Drive sections in \`SKILL.md\`. One successful drive of this feature is required before the skill is registered.

## Gotchas

- Do not reuse another checkout's port or database.
- Do not treat a green typecheck as proof the user path works.
`;
  return {
    dir: path.join(factoryRoot, "skills", `verify-${name}`),
    files: {
      "SKILL.md": skill,
      "features/README.md": `# Features\n\n- [primary](primary.md)\n`,
      "features/primary.md": feature,
    },
    web: found.web,
    command: found.dev ? launch : null,
  };
}

function main() {
  const { values } = parseArgs({
    options: {
      "code-root": { type: "string" },
      "factory-root": { type: "string" },
      repo: { type: "string" },
    },
  });
  if (!values["code-root"] || !values["factory-root"]) {
    throw new Error("--code-root and --factory-root are required");
  }
  const rendered = renderVerificationSkill({
    codeRoot: path.resolve(values["code-root"]),
    factoryRoot: path.resolve(values["factory-root"]),
    repo: values.repo,
  });
  for (const [rel, contents] of Object.entries(rendered.files)) {
    const dest = path.join(rendered.dir, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, contents);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, dir: rendered.dir, web: rendered.web, command: rendered.command }, null, 2)}\n`);
}

if (process.argv[1] && process.argv[1].endsWith("write-verification-skill.mjs")) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
