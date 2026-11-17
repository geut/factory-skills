# ADR-004: The factory, not an agent, shapes what it says outside

- **Status:** Accepted
- **Date:** 2026-11-17

Everything the factory writes where other people read it is posted through its owner's accounts: tracker comments, checklist ticks, the pull request, and commit messages. Until now, agents wrote much of it freely. The wrap-up agent wrote the pull request body and nothing checked it, and the planner was allowed to comment on the issue. So the owner could not control how much the factory said or how it sounded. We decided that the factory decides the shape and length of its outward communication from two settings in FACTORY.json: **verbosity** (`minimal`, `standard`, `full`) and **voice** (`factory` or `developer`, with a free-text **tone** for the latter). Agents only write prose inside sections the factory has already validated. This follows the rule behind the factory's rounds: ask LLMs for as little as possible, and keep what must be exact deterministic.

## Consequences

- **The pull request body.** When the project defines a PR format (PR instructions in its agent instructions, or a single pull request template file, read at the ticket's base commit), the wrap-up agent writes the body in that format and nothing else, at every verbosity level. The factory checks a template's headings, but cannot check prose instructions. With no project format, the factory assembles the body from the handoff for each level, and the agent passes it through with `--body-file`. The body is written once, when the pull request opens.
- **The factory writes to the code host.** Until now it only read the code host. A feedback round no longer edits the body; the factory posts a round comment, assembled from the round's commit and review's verdict on each item. It goes through the outbox after wrap-up passes, with a hidden marker so a retry replaces it and the next round does not read it as feedback. Thread replies will reuse this path.
- **Tracker comments use fixed wording for each voice.** Tone never rewrites them; it only steers text an agent writes. Statuses and pause questions are posted at every level, since they keep the board accurate and unblock the ticket.
- **The planner no longer comments on the issue.** It asks through a pause.
- **FACTORY.json stays the only source of the settings.** `PUT /v1/factory/communication` (scope `act`) rewrites its `communication` block in place, so the file and the API never disagree. As with every FACTORY.json setting, a change applies to tickets started after it.

## Considered options

- **Length and style rules in the prompts only.** Cheaper, but an agent can ignore them, and `minimal` could not be relied on.
- **An agent rewrites every comment in the owner's tone.** Each comment would cost a model turn, and the wording would differ every time.
- **Settings stored in the database, overriding the file.** That gives two sources of truth, and you would have to decide which one wins.
