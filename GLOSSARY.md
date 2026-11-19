# Factory

A factory turns tickets into reviewed pull requests by running agents through fixed stages, under one developer's accounts.

## Progress

**Controller step**:
What the controller is doing for a ticket between agents, such as preparing a worktree, validating a run, or updating the issue, with the command it is running, if any. Scheduled steps, such as a retry, count too.
_Avoid_: activity (that is an agent's), job, task (a planned slice of a ticket)

## Releases

**Release**:
A published factory version: the binary, with the agents' extension, the operator's Pi extension, and the skills it carries.
_Avoid_: build, package, tag (for this sense)

**Update**:
A newer release than the one this factory runs; updating the factory installs it and restarts the server on it.
_Avoid_: upgrade (that is the database schema's), patch

## Communication

**Outward communication**:
Anything the factory writes where people other than its owner read it: tracker comments, checklist ticks, the pull request, and commit messages. Pi cards, the API, and the dashboard are not outward.
_Avoid_: notifications, updates, output

**Owner**:
The developer who runs a factory; its outward communication is posted through their accounts.
_Avoid_: user, operator (for this sense)

**Verbosity**:
How much outward communication a factory sends, as one ordered level: `minimal` (the pull request only, succinct), `standard`, or `full`. Each level writes everything the level below does.
_Avoid_: detail level, noise, log level

**Voice**:
Who outward communication sounds like: `factory`, which speaks of itself in the third person, or `developer`, which reads as the owner writing in the first person.
_Avoid_: persona, author, identity

**Feedback round**:
A pass that takes chosen review comments on a handed-off ticket's open pull request back through work, review, and wrap-up, ending in a new commit on the same pull request.
_Avoid_: rework, iteration, review round (that is the reviewer's loop inside one task)

**Pause**:
A ticket stopped until a person answers: an agent asked a question, or the ticket reached a limit. A reply resumes the same agent.
_Avoid_: block, hold, waiting state

**PR format**:
The shape a project asks its pull request bodies to take, from its agent instructions or its pull request template; the factory's default when it has neither.
_Avoid_: PR template (for the general sense), PR style

**Tone**:
The owner's free-text description of how the `developer` voice should sound.
_Avoid_: style, personality
