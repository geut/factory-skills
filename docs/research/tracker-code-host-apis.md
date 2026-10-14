# What GitHub, Linear, and Jira expose for backlog, issue links, and pull request state

Research for [#17](https://github.com/geut/factory-skills/issues/17), a child of map #14. This file states facts only and makes no design decisions. Sources were checked on 2026-10-14.

Every claim cites its source. Most sources are official docs: docs.github.com, linear.app/developers and Linear's published GraphQL schema, developer.atlassian.com and support.atlassian.com. Where a fact rests on something weaker, the text says so. **UNVERIFIED** marks a claim that a primary source could not confirm.

---

## 0. What the factory uses today

- **Ticket resolution** (`src/tickets.ts`):
  - The factory accepts these ticket references:
    - a GitHub issue URL
    - `owner/repo#N`
    - a bare `#N` or `N`, which needs `github.owner` and `github.repo` in FACTORY.json
    - `KEY-N`, which is mapped to GitHub through `config.keys`. The only provider is `'github'`.
    - a local `.md` or `.json` file
  - Issues are fetched with `gh issue view N --repo o/r --json id,number,title,body,url,labels`.
  - The ticket id is `github:<host>:<nodeId>`. `contentHash` hashes title, body, and labels.
- **Parent and child links:**
  - The factory reads sub-issues from `gh api repos/{o}/{r}/issues/{n}/sub_issues` (REST sub-issues API).
  - If an issue has children, the factory refuses to run it as an "umbrella" issue.
  - `parseIssueBody` and `relatedTickets` also read `## Parent` and `## Blocked by` headings in the issue body, taking `#N` references from them. These are text conventions, not GitHub's native relationship fields.
  - The factory does not use the dependencies (blocked-by) API, Projects v2, status changes, or comments.
- **Pull requests** (`src/actions/wrapup.ts` and `src/validation/wrapup.ts`):
  - `gh pr view <url> --json headRefName,state` checks that the PR from the handoff exists and that its `headRefName` matches the ticket branch.
  - A "not found" error is reported as a missing PR. Any other `gh` error is treated as an infrastructure error.
  - The `factory-wrapup` skill pushes, then runs `gh pr list --head`, `gh pr edit` or `gh pr create`, but only when `github.pullRequests` is true.
  - The factory does not read reviews, merge state, checks, timeline, or webhooks.
- **Labels:** `config.labels.map` maps project label strings to internal labels. `skills/setup-factory/references/triage-labels.md` defines five triage roles.
- **Transport:** every GitHub call shells out to the `gh` CLI. There is no direct REST or GraphQL client, and no webhook receiver.

---

## 1. GitHub

### 1.1 Backlog queries

- **Search qualifiers** ([searching issues and PRs](https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests)):
  - State: `is:open` and `is:closed`.
  - Type: `is:issue` and `is:pr`.
  - Labels:
    - Repeated qualifiers are combined with AND: `label:a label:b`.
    - Commas mean OR: `label:a,b`.
    - A minus sign excludes: `-label:x`.
  - Missing values: `no:label`, `no:assignee`, `no:milestone` and `no:project`. These cannot be negated.
  - Other fields: `assignee:USER`, `milestone:"name"`, and `project:OWNER/NUMBER` (the project's number, not its name).
  - PR-only qualifiers: `review:none|required|approved|changes_requested`, `review-requested:`, `reviewed-by:`, `status:success|pending|failure`, `is:merged` and `draft:`.
  - Linking: `linked:pr` and `linked:issue`.
  - Close reason: `reason:completed|"not planned"`.
- **Boolean logic and issue types:** `AND`/`OR` work, with parentheses nested up to 5 levels deep. `type:"Bug"` filters by issue type when the org uses issue types. ([filtering](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/filtering-and-searching-issues-and-pull-requests))
- **Sort:** `sort:created|updated|comments|reactions|interactions[-asc|-desc]`. ([sorting](https://docs.github.com/en/search-github/getting-started-with-searching-on-github/sorting-search-results))
- **Dependency qualifiers:** `is:blocked`, `is:blocking`, `blocked-by:` and `blocking:` appear only in the [changelog](https://github.blog/changelog/2025-08-21-dependencies-on-issues/). They are UNVERIFIED on docs.github.com.
- **REST search:** `GET /search/issues?q=` returns at most 1,000 results per query and up to 100 per page. The rate limit is 30 requests/min when authenticated. `search_type` can be `lexical`, `semantic` or `hybrid`. ([REST search](https://docs.github.com/en/rest/search/search))
- **REST list:** `GET /repos/{o}/{r}/issues` ([REST issues](https://docs.github.com/en/rest/issues/issues)):
  - Filters: `state`, `labels` (comma-separated, AND), `assignee` (login, `none` or `*`), `milestone`, `type`, `creator` and `since`.
  - Sorting: `sort=created|updated|comments`.
  - Results include PRs; a PR is marked by its `pull_request` key.
- **Projects v2:** these are GraphQL only ([API guide](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects)):
  - The project id comes from `organization|user(login){ projectV2(number){ id } }`.
  - Fields: `fields{ ... on ProjectV2SingleSelectField { id name options{id name} } }`.
  - Items: `items{ fieldValues{ ... on ProjectV2ItemFieldSingleSelectValue { name } } }`.
  - Items the caller cannot see come back as `REDACTED`.
  - Token scopes: `read:project` to read, `project` to write.
  - Project views also support filters such as `status:"In progress"`, `parent-issue:o/r#N`, `has:`/`no:` field and `reason:`. ([filtering projects](https://docs.github.com/en/issues/planning-and-tracking-with-projects/customizing-views-in-your-project/filtering-projects))
- **gh CLI:** `gh issue list` takes `-l`, `-a`, `-m`, `-S "<search>"`, `-s open|closed|all`, `--type` and `--json`, with a default limit of 30. ([gh manual](https://cli.github.com/manual/gh_issue_list); this is cli.github.com, not docs.github.com)

### 1.2 Parent and child, and blocking

- **Sub-issues (REST)** ([sub-issues](https://docs.github.com/en/rest/issues/sub-issues)):
  - Endpoints, all under `/repos/{o}/{r}/issues/{n}`:
    - `GET /sub_issues` lists sub-issues.
    - `POST /sub_issues` adds one, with body `{sub_issue_id, replace_parent}`.
    - `DELETE /sub_issue` (singular) removes one.
    - `PATCH /sub_issues/priority` reorders, using `after_id` or `before_id`.
    - `GET /parent` returns the parent.
  - `sub_issue_id` is the issue **id**, not its number.
  - Parent and child must have the same repository owner.
  - Limits: 100 sub-issues per parent and 8 levels of nesting. ([adding sub-issues](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues))
- **Dependencies (REST)** ([issue dependencies](https://docs.github.com/en/rest/issues/issue-dependencies)):
  - Endpoints, under `.../issues/{n}/dependencies/`:
    - `GET blocked_by` lists issues that block this one.
    - `POST blocked_by` adds one, with body `{issue_id}`. `issue_id` is the issue id.
    - `DELETE blocked_by/{issue_id}` removes one.
    - `GET blocking` lists issues this one blocks.
  - Each relationship type allows at most 50 issues ([changelog](https://github.blog/changelog/2025-08-21-dependencies-on-issues/)).
- **GraphQL `Issue`** ([issues reference](https://docs.github.com/en/graphql/reference/issues)):
  - Relationship fields: `parent`, `subIssues`, `subIssuesSummary`, `blockedBy`, `blocking`, `issueDependenciesSummary`, `issueType` and `stateReason`.
  - Other fields: `closedByPullRequestsReferences`, `projectItems` and `timelineItems`.
  - Mutations: `addSubIssue`, `addBlockedBy` and `closeIssue`. The remove and reopen mutations were UNVERIFIED because the reference page was truncated.
- **Issue types:** set the `type` field on create or update. Without push access the field is silently dropped. ([REST issues](https://docs.github.com/en/rest/issues/issues))

### 1.3 Status changes

- **REST:** `PATCH /repos/{o}/{r}/issues/{n}` ([REST issues](https://docs.github.com/en/rest/issues/issues)):
  - Takes `state: open|closed` and `state_reason: completed|not_planned|duplicate|reopened|null`.
  - `state_reason` is ignored unless the state changes.
  - `duplicate_issue_id` is used when the reason is `duplicate`.
  - The `labels` and `assignees` arrays replace the existing set rather than adding to it.
- **GraphQL:** `IssueState` is `OPEN` or `CLOSED`. `IssueStateReason` is `COMPLETED`, `DUPLICATE`, `NOT_PLANNED` or `REOPENED`. ([issues reference](https://docs.github.com/en/graphql/reference/issues))
- **Projects v2 status** ([API guide](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects)):
  - Change it with `updateProjectV2ItemFieldValue(input:{projectId,itemId,fieldId,value:{singleSelectOptionId}})`.
  - An item has to be added with `addProjectV2ItemById` first, in a separate call.

### 1.4 Comments

- **Conversation comments:** both issues and PRs use `GET`/`POST /repos/{o}/{r}/issues/{n}/comments`, because "every pull request is an issue" ([issue comments](https://docs.github.com/en/rest/issues/comments)).
  - A repo-wide listing takes `since`.
  - Comments can be pinned with `PUT .../comments/{id}/pin`.
- **Inline diff comments:** these are a separate API, [`/pulls/comments`](https://docs.github.com/en/rest/pulls/comments).

### 1.5 Pull request reviews

- **REST reviews** ([REST reviews](https://docs.github.com/en/rest/pulls/reviews)):
  - `GET /repos/{o}/{r}/pulls/{n}/reviews` returns reviews in chronological order.
  - Each review has `id`, `state`, `submitted_at`, `commit_id`, `user` and `body`.
  - `POST .../reviews` takes `event: APPROVE|REQUEST_CHANGES|COMMENT`. A blank event creates a PENDING review, which has no `submitted_at`.
  - Dismissing a review: `PUT .../reviews/{id}/dismissals`.
- **GraphQL review state** ([pulls reference](https://docs.github.com/en/graphql/reference/pulls)):
  - `PullRequestReviewState` is `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED` or `PENDING`.
  - `reviewDecision` is `APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED` or null.
  - `latestReviews` and `latestOpinionatedReviews` give each user's latest review.
  - Review requests: the `reviewRequests` field and the `requestReviews` and `rerequestReviews` mutations.
- **Review requests (REST):** `GET`/`POST`/`DELETE .../pulls/{n}/requested_reviewers` and `POST .../requested_reviewers/rerequest`. Once a reviewer submits a review, they are no longer listed as requested. ([review requests](https://docs.github.com/en/rest/pulls/review-requests))
- **Counting review rounds:** GitHub defines no "review round". These raw facts are available ([issue event types](https://docs.github.com/en/rest/using-the-rest-api/issue-event-types)):
  - Each review records `commit_id`, the head SHA at the time of the review.
  - The timeline `reviewed` event carries `state`, `submitted_at` and `commit_id`.
  - The timeline also has `review_requested`, `review_request_removed`, `review_dismissed`, `committed` and `head_ref_force_pushed`.

### 1.6 Merge state and checks

- **REST pull request** ([REST pulls](https://docs.github.com/en/rest/pulls/pulls)):
  - `GET /pulls/{n}` returns:
    - `mergeable`: `true`, `false` or `null`. Null means it is still being computed, so poll again.
    - `mergeable_state`: a string. The REST docs do not list its values. They look like the GraphQL `MergeStateStatus` values in lowercase, but that is an inference.
    - `merged`, `merged_at`, `merge_commit_sha`, `rebaseable`, `draft` and `auto_merge`.
  - `PUT /pulls/{n}/merge` takes `merge_method` (`merge`, `squash` or `rebase`) and `sha`, which must equal the head SHA.
    - It returns 405 when the PR is not mergeable and 409 when the SHA does not match.
    - It does not support merge queues.
- **GraphQL pull request** ([pulls reference](https://docs.github.com/en/graphql/reference/pulls)):
  - `mergeStateStatus` is one of `BEHIND`, `BLOCKED`, `CLEAN`, `DIRTY`, `DRAFT`, `HAS_HOOKS`, `UNKNOWN` or `UNSTABLE`.
  - `mergeable` is `MERGEABLE`, `CONFLICTING` or `UNKNOWN`.
  - `state` is `OPEN`, `CLOSED` or `MERGED`.
  - Other fields: `autoMergeRequest`, `isInMergeQueue`, `isDraft` and `statusCheckRollup`.
- **Checks:**
  - `statusCheckRollup.state` is `ERROR`, `EXPECTED`, `FAILURE`, `PENDING` or `SUCCESS`. Its contexts are `CheckRun` or `StatusContext` ([commits reference](https://docs.github.com/en/graphql/reference/commits)).
  - Check runs: `GET /commits/{ref}/check-runs` ([check runs](https://docs.github.com/en/rest/checks/runs)).
  - Legacy statuses: `GET /commits/{ref}/status` ([statuses](https://docs.github.com/en/rest/commits/statuses)).
- **Auto-merge:** merges once required reviews and checks pass. A push by someone without write access disables it. ([auto-merge](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/automatically-merging-a-pull-request))
- **Merge queue:** uses `gh-readonly-queue/*` branches. CI has to run on `merge_group` events. ([merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue))

### 1.7 Timeline and closing links

- **Timeline:** `GET /repos/{o}/{r}/issues/{n}/timeline` returns at most 100 items per page ([timeline](https://docs.github.com/en/rest/issues/timeline)).
  - It includes these events: labeled, assigned, `cross-referenced` (with `source.issue`), `connected`, closed (with `commit_id` when the issue was closed by keyword), reopened, `reviewed`, `review_requested`, `merged`, `head_ref_force_pushed`, `ready_for_review`, `convert_to_draft`, `committed`, and the sub-issue, parent and blocked-by add/remove events.
  - Some of these are timeline-only: `cross-referenced`, `commented`, `committed` and `reviewed` ([event types](https://docs.github.com/en/rest/using-the-rest-api/issue-event-types)).
- **Closing keywords** ([linking a PR](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue)):
  - The keywords are close, closes, closed, fix, fixes, fixed, resolve, resolves and resolved.
  - Syntax: `Fixes #10` or `Fixes o/r#100`.
  - They only take effect when the PR targets the **default branch**.
  - Manual linking allows up to 10 issues, all in the same repo.
  - GraphQL `PullRequest.closingIssuesReferences` lists the issues the PR may close.

### 1.8 Webhooks

- **Headers:** `X-GitHub-Event`, `X-GitHub-Delivery` (a unique id), `X-GitHub-Hook-ID`, `X-Hub-Signature-256`, and the legacy SHA-1 `X-Hub-Signature`. Payloads are at most 25 MB. ([events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads))
- **Events and actions:**
  - `pull_request`: opened, edited, closed, reopened, synchronize, ready_for_review, converted_to_draft, review_requested, review_request_removed, labeled, unlabeled, assigned, auto_merge_enabled/disabled, enqueued/dequeued, and more.
    - A merge arrives as `closed` with `pull_request.merged == true` ([Actions events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)).
  - `pull_request_review`: submitted, edited, dismissed.
  - `pull_request_review_comment`: created, edited, deleted.
  - `pull_request_review_thread`: resolved, unresolved.
  - `issues`: opened, edited, closed, reopened, labeled, unlabeled, assigned, unassigned, typed, untyped, transferred, deleted, and more.
  - `issue_comment`: created, edited, deleted. It fires for both issues and PRs.
  - `sub_issues`: sub_issue_added/removed and parent_issue_added/removed.
  - `issue_dependencies`: blocked_by_added/removed and blocking_added/removed.
  - Also: `check_run`, `check_suite`, `status`, `merge_group` and `projects_v2_item`.
- **Signature verification** ([validating deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)):
  - The signature is an HMAC-SHA256 hex digest of the **raw** body, keyed with the secret. The header value is `sha256=<hex>`. Compare it in constant time.
  - Test vector: secret `It's a Secret to Everybody`, body `Hello, World!`, signature `sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17`.
- **Delivery** ([best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks), [redelivering](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks)):
  - The receiver must respond 2xx within **10 s**.
  - Deduplicate on `X-GitHub-Delivery`; redeliveries reuse the same value.
  - GitHub does **not** redeliver failed deliveries automatically. Manual redelivery is possible for 3 days via `POST /repos/{o}/{r}/hooks/{id}/deliveries/{delivery_id}/attempts`.

---

## 2. Linear

These sources are cited by key:

- [GQL] https://linear.app/developers/graphql
- [FIL] https://linear.app/developers/filtering
- [PAG] https://linear.app/developers/pagination
- [RL] https://linear.app/developers/rate-limiting
- [OAUTH] https://linear.app/developers/oauth-2-0-authentication
- [ATT] https://linear.app/developers/attachments
- [WH] https://linear.app/developers/webhooks
- [GH] https://linear.app/docs/github
- [SEC] https://linear.app/docs/security
- [SCHEMA] https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql

### 2.1 API basics

- **Endpoint:** `POST https://api.linear.app/graphql`. There is no REST API. [GQL]
- **Auth:**
  - Personal key: send `Authorization: <API_KEY>`, with no Bearer prefix. [GQL]
  - OAuth: send `Authorization: Bearer <token>`. [GQL]
  - OAuth scopes: `read`, `write`, `issues:create`, `comments:create` and `admin`. [OAUTH]
  - `actor=app` lets an app act as itself. [OAUTH]
  - Access tokens last about 24 h and can be refreshed. [OAUTH]
  - Client-credentials tokens last about 30 days. [OAUTH]
- **Rate limits** [RL]:
  - API key: 2,500 requests/h and 3M complexity points/h.
  - OAuth: 5,000 requests/h and 2M complexity points/h.
  - A single query costs at most 10,000 complexity points.
  - When limited, the response is HTTP 400 with `extensions.code == "RATELIMITED"`.
- **Pagination:** Relay-style cursors (`first`/`after`, `pageInfo.endCursor`), with a default page size of 50. The maximum page size is not documented. [PAG]

### 2.2 Backlog queries

- **The query:** `issues(filter: IssueFilter, first, after, orderBy: createdAt|updatedAt, includeArchived)`. [SCHEMA]
  - There is no public sort by priority or manual order.
  - `sortOrder` and `prioritySortOrder` are available as fields.
- **`IssueFilter` fields** [SCHEMA]:
  - `team`, `state` (by `id`, `name` or `type`), `assignee` and `labels` (`some`/`every`/`name`)
  - `project`, `cycle` (`isActive`/`isNext`/…), `priority` and `parent`
  - `children`, `hasBlockedByRelations` and `hasBlockingRelations`
  - `and`/`or`
- **Comparators:** `eq`, `neq`, `in`, `nin`, `lt` and `gt`, plus string matchers and `null`. Conditions are combined with AND by default. [FIL]
- **Example:** a backlog filter is `state: { type: { in: ["backlog","unstarted"] } }`. [FIL] [SCHEMA]
- **Priority values:** 0 none, 1 urgent, 2 high, 3 medium, 4 low. [SCHEMA]
- **Lookups:** `issue(id)` accepts a UUID or an identifier like `ENG-123`. `issueVcsBranchSearch(branchName)` finds an issue from a git branch name. [SCHEMA]

### 2.3 Workflow states and status change

- **State types:** `WorkflowState.type` is `triage`, `backlog`, `unstarted`, `started`, `completed`, `canceled` or `duplicate`. Each team has its own states. [SCHEMA]
- **Default state:** if `stateId` is omitted, a new issue goes to the team's first Backlog state, or to Triage when triage is enabled. [GQL]
- **Changing status:** call `issueUpdate(id, input:{stateId})`. Find the state id per team with `workflowStates(filter:{team:{id:{eq}}, type:{eq:"started"}})`. [GQL] [SCHEMA]
- **Other `IssueUpdateInput` fields:** `parentId`, `labelIds`, `addedLabelIds`/`removedLabelIds`, `assigneeId`, `priority`, `projectId` and `cycleId`. [SCHEMA]

### 2.4 Relations

- **Parent and child:** `Issue.parent` and `Issue.children`. Set the parent with `parentId`. [SCHEMA]
- **Relation types:** `IssueRelationType` is `blocks`, `duplicate`, `related` or `similar`. [SCHEMA]
- **Relation shape:** `IssueRelation{type, issue, relatedIssue}`. `Issue.relations` holds the relations where this issue is the source, and `Issue.inverseRelations` holds those where it is the target. [SCHEMA]
- **"Blocked by":** there is no blocked-by type. "A is blocked by B" is a `blocks` relation with issue B and relatedIssue A, so it shows up in A's `inverseRelations`. This is inferred from the schema; no docs page says it.
- **Mutations:** `issueRelationCreate({issueId, relatedIssueId, type})` and `issueRelationDelete`. [SCHEMA]

### 2.5 Comments

- **Creating:** `commentCreate({issueId, body (markdown), parentId (thread reply)})`. [SCHEMA]
- **Threads:** `Comment.children` holds replies. Threads can be resolved with `commentResolve` and reopened with `commentUnresolve`. [SCHEMA]
- **Reading:** `Issue.comments` lists an issue's comments. [SCHEMA]

### 2.6 Linking to GitHub PRs [GH]

- **How a PR gets linked:**
  - The issue id appears in the **branch name**. `Issue.branchName` gives the suggested name.
  - The issue id appears in the PR title.
  - A magic word plus the id appears in the PR title or description. Magic words in PR comments do not link.
  - A magic word plus the id appears in a commit message.
- **Closing magic words:** close, fix, resolve, complete and implement (with their variants). These apply the "on merge" status.
- **Non-closing magic words:** ref, refs, references, part of, contributes to, toward and towards. These link and move the issue through earlier statuses.
- **Other words:** "relates to" links without changing status. `skip` or `ignore` suppresses linking.
- **Automatic status changes:**
  - These are configured per team, for the PR events Draft, Opened, Review requested, Ready for merge and Merged.
  - By default an opened PR moves the issue to In Progress and a merged PR moves it to Done.
  - Rules can target specific branches and can use regex.
  - When several PRs are linked, the status changes only when the last PR reaches the state.
  - "Ready for merge" needs a mergeable PR whose checks pass.
- **Attachments:** a linked PR is stored as an `Attachment` with fields `url`, `title`, `metadata`, `sourceType` (for example `github`) and `issue`.
  - `url` is unique per issue, so creating the same attachment twice is idempotent. [SCHEMA] [ATT]
  - The `metadata` keys for GitHub PRs are not documented.
- **Linking from the API:** `attachmentLinkGitHubPR(issueId, url, linkKind?)` creates a "rich attachment… enabling automated status syncing". `linkKind` is `closes`, `contributes` or `links` and is marked internal. There is also `attachmentLinkURL`, and `attachmentsForURL(url)` works in reverse to find issues from a URL. [SCHEMA]

### 2.7 Webhooks [WH]

- **Creating:** `webhookCreate({url, resourceTypes, teamId | allPublicTeams, secret})`. The URL must be public HTTPS. [SCHEMA] [WH]
- **Resource types:** Issue, Comment, Attachment, IssueLabel, Reaction, Project, ProjectUpdate, Cycle, Document, Initiative, Customer, User, plus Issue SLA and OAuthApp revoked.
  - Of these exact strings, only `Issue`, `Comment`, `Project` and `Cycle` were verified.
- **Actions:** `create`, `update` and `remove`.
- **Payload:** `{action, type, actor, createdAt, data, url, updatedFrom (previous values on update), webhookTimestamp, organizationId, webhookId}`.
- **Headers:** `Linear-Delivery` (a UUID), `Linear-Event` (the entity type), `Linear-Signature` and `Linear-Timestamp` (in ms).
- **Signature verification:**
  - The signature is an HMAC-SHA256 hex digest of the **raw** body, keyed with the signing secret, with no prefix. Compare it in constant time.
  - Reject a delivery whose `webhookTimestamp` is more than 60 s from now.
- **Delivery:**
  - The receiver must respond 200 within **5 s**.
  - Linear retries up to 3 times, after 1 min, 1 h and 6 h.
  - A webhook that keeps failing may be disabled.
  - Linear publishes its IP list at https://linear.app/.well-known/appspecific/app.linear.ips.json. [SEC]

---

## 3. Jira Cloud

Platform API references live under https://developer.atlassian.com/cloud/jira/platform/rest/v3/ and Agile API references under https://developer.atlassian.com/cloud/jira/software/rest/. The OpenAPI specs `swagger-v3.v3.json` (platform) and `swagger.v3.json` (software) were also checked.

### 3.1 API basics

- **Base URL:** `https://<site>.atlassian.net/rest/api/3/...`. The Agile API is at `/rest/agile/1.0/...`. ([intro](https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/))
- **Basic auth:** send `email:api_token`, Base64-encoded, as `Authorization: Basic`. The docs recommend it for scripts. ([basic auth](https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/))
- **OAuth 2.0 (3LO):** call `https://api.atlassian.com/ex/jira/{cloudid}/...` with a Bearer token. Find the `cloudid` from `/oauth/token/accessible-resources`. ([3LO](https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/))
- **Rate limits** ([rate limiting](https://developer.atlassian.com/cloud/jira/platform/rate-limiting/)):
  - Limits are counted in points: 65k per hour globally.
  - Burst limits are 100 req/s for GET and POST, and 50 req/s for PUT and DELETE.
  - Each issue allows 20 writes per 2 s.
  - When limited, the response is 429 with `Retry-After` and `RateLimit-Reason`.
- **Search** ([issue search](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/)):
  - The endpoint is `GET`/`POST /rest/api/3/search/jql`.
  - The JQL must be bounded (have a restriction).
  - Pagination uses `nextPageToken` and `isLast`. A token expires after 7 days.
  - The response has no `total`. Use `POST /search/approximate-count` for a count.
  - The old `/rest/api/3/search`, paged with `startAt`, has been removed ([Atlassian KB](https://confluence.atlassian.com/display/JIRAKB/Run+JQL+search+query+using+Jira+Cloud+REST+API)).

### 3.2 Backlog queries

- **JQL** ([JQL fields](https://support.atlassian.com/jira-software-cloud/docs/jql-fields/), [JQL functions](https://support.atlassian.com/jira-software-cloud/docs/jql-functions/)):
  - Fields include `project`, `labels`, `status`, `statusCategory`, `assignee`, `issuetype` and `resolution = unresolved`.
  - Sprints: `sprint in openSprints()` and `closedSprints()`.
  - Parent: `parent = KEY`. Epic Link was retired in February 2024 in favor of Parent.
  - Hierarchy levels: 1 is epic, 0 is standard and -1 is subtask.
  - The exact wording for `ORDER BY Rank` was UNVERIFIED.
- **Board backlog:** `GET /rest/agile/1.0/board/{id}/backlog` returns incomplete issues that are not in an active or future sprint, ordered by rank. It takes a `jql` parameter. ([board](https://developer.atlassian.com/cloud/jira/software/rest/api-group-board/))
- **Sprints:** `GET /board/{id}/sprint?state=active` and `GET /sprint/{id}/issue`. ([sprint](https://developer.atlassian.com/cloud/jira/software/rest/api-group-sprint/))
- **Ranking:** `PUT /rest/agile/1.0/issue/rank`.

### 3.3 Status changes

- **Workflows:** each project has its own workflow, and status moves by **transitions**. There is no "set status" call. ([issues](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/))
  - `GET /rest/api/3/issue/{key}/transitions` lists the transitions available now. It returns an empty list when a transition is not allowed or the user lacks permission.
  - `POST` to the same path performs one, with body `{"transition":{"id":"5"},"fields":{"resolution":{"name":"Fixed"}},"update":{"comment":[{"add":{"body":<ADF>}}]}}`.
- **Status categories:** `TODO`, `IN_PROGRESS` and `DONE`, from `GET /rest/api/3/statuscategory`. The runtime key strings were UNVERIFIED. ([status categories](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-workflow-status-categories/))

### 3.4 Hierarchy and links

- **Parent:** the single `parent` field (`{"parent":{"key":"PROJ-1"}}`) covers both epic→story and story→subtask. The old Epic Link and Parent Link fields are deprecated. ([issues](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/), [deprecation notice](https://community.developer.atlassian.com/t/deprecation-of-the-epic-link-parent-link-and-other-related-fields-in-rest-apis-and-webhooks/54048))
- **Issue links:** `POST /rest/api/3/issueLink` with body `{type:{name:"Blocks"}, inwardIssue, outwardIssue}`. ([issue links](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-links/))
  - The response has no body. Read links from the `issuelinks` field.
- **Link types:** `GET /issueLinkType` lists them, for example `{name:"Blocks", inward:"Blocked by" (or "is blocked by"), outward:"Blocks"}`. Link types are configured per site. ([link types](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-link-types/))
- **Remote links:** `POST /issue/{key}/remotelink` with `globalId` (which makes it an upsert), `object{url,title,status{resolved}}`. ([remote links](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-remote-links/))

### 3.5 Comments

- **Creating:** `POST /rest/api/3/issue/{key}/comment` with `{"body": <ADF doc>}`. ([comments](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/))
- **Format:** v3 text fields use **Atlassian Document Format**, JSON with the shape `{type:"doc",version:1,content:[...]}`. They do not take markdown. ([ADF](https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/))

### 3.6 Linking to GitHub PRs

- **App:** the "GitHub for Atlassian" app connects a GitHub org. A Jira admin installs it and a GitHub org owner connects it. ([integrate with GitHub](https://support.atlassian.com/jira-cloud-administration/docs/integrate-with-github/))
- **How links are made** ([reference issues](https://support.atlassian.com/jira-software-cloud/docs/reference-issues-in-your-development-work/)):
  - The issue key must be **uppercase** and appear in the branch name, a commit message, or the PR title.
  - For GitHub, a PR links through its title or source branch. Linking through a commit inside the PR works only on Bitbucket.
  - Linked work shows in the issue's Development panel.
- **Smart commits:** `KEY-1 #comment text`, `#time 1h` and `#<transition-name>` ([smart commits](https://support.atlassian.com/jira-software-cloud/docs/process-issues-with-smart-commits/)).
  - The committer's email must match a Jira user.
  - If a transition has required fields, it fails silently.
- **Development JQL:** `development[pullrequests].all|open`, `development[commits].all` and `development[builds].failing`. A `.merged` variant was UNVERIFIED. ([developer reference](https://confluence.atlassian.com/jiracorecloud/advanced-searching-developer-reference-967312946.html))
- **DevInfo API:** `POST /rest/devinfo/0.10/bulk` pushes repositories, branches, commits and PRs, with a `updateSequenceId` that orders updates. It needs a Connect or Forge dev-tool app or on-prem OAuth. Builds and Deployments have their own APIs. ([dev info](https://developer.atlassian.com/cloud/jira/software/rest/api-group-development-information/))
- **Automation:** Jira Automation triggers on PR created, merged or declined ([automation triggers](https://support.atlassian.com/cloud-automation/docs/jira-automation-triggers/)). Company-managed workflows have a "Pull request merged" trigger that transitions the issue ([workflow triggers](https://support.atlassian.com/jira-cloud-administration/docs/use-workflow-triggers-for-company-managed-projects/)).

### 3.7 Webhooks ([webhooks](https://developer.atlassian.com/cloud/jira/platform/webhooks/))

- **Registration:**
  - An admin can register a webhook in the UI or through `POST /rest/webhooks/1.0/webhook`, with a JQL filter and a `secret`.
  - Apps register through `POST /rest/api/3/webhook` (Connect or OAuth only). The JQL filter there allows only limited fields and operators.
  - App webhooks **expire after 30 days** unless refreshed with `PUT /webhook/refresh`.
  - App limits: 100 webhooks per Connect app, and 5 per OAuth app per user. ([webhooks API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-webhooks/))
- **Events:** `jira:issue_created`, `jira:issue_updated`, `jira:issue_deleted`, `comment_created/updated/deleted`, `issuelink_created/deleted` (admin and Connect only; dynamic webhooks don't get these), and sprint, version and worklog events.
- **Payload:** `{timestamp, webhookEvent, issue_event_type_name, user, issue, changelog}`. `changelog.items` (the changed fields) is present only on `jira:issue_updated`.
- **Signatures:**
  - Admin webhooks with a secret send `X-Hub-Signature: sha256=<hex HMAC of raw body>`.
  - Test vector: secret `It's a Secret to Everybody`, body `Hello World!`, signature `sha256=a4771c39fbe90f317c7824e83ddef3caae9cb3d976c214ace1f2937e133263c9`.
  - OAuth app webhooks carry a JWT in `Authorization`, signed with the client secret. Connect apps use a JWT signed with `sharedSecret`.
- **Delivery:**
  - Jira retries up to 5 times, 5 to 15 minutes apart, on 408, 409, 425, 429, 5xx or a timeout.
  - Deduplicate on `X-Atlassian-Webhook-Identifier`; `X-Atlassian-Webhook-Retry` gives the retry count.
  - After 30 minutes of failures, Jira makes only one attempt per event.

---

## 4. Side by side (facts only)

| Concern           | GitHub                                                                 | Linear                                                    | Jira Cloud                                                    |
| ----------------- | ---------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------- |
| API style         | REST + GraphQL                                                         | GraphQL only                                              | REST (v3 platform + Agile 1.0)                                |
| Issue identifier  | `owner/repo#N`, node id                                                | `TEAM-N` identifier, UUID                                 | `PROJ-N` key, numeric id                                      |
| Backlog query     | search qualifiers / list filters; Projects v2 fields                   | `IssueFilter` (team, state.type, labels, project, cycle)  | JQL; board backlog endpoint                                   |
| Status model      | open/closed + `state_reason`; optional Projects v2 single-select       | per-team `WorkflowState` with fixed `type` categories     | per-project workflow, transitions, 3 status categories        |
| Status change     | PATCH state; GraphQL field update for Projects                         | `issueUpdate(stateId)`                                    | POST transition id (must be currently available)              |
| Parent/child      | sub-issues API (id-based, 8 levels)                                    | `parent` / `children`                                     | `parent` field + hierarchy levels                             |
| Blocking          | dependencies API `blocked_by`/`blocking`                               | relation type `blocks` (+ inverse)                        | issue link type "Blocks" (inward/outward)                     |
| Comment body      | Markdown                                                               | Markdown                                                  | ADF JSON                                                      |
| Issue↔PR link     | closing keywords (default branch), `closingIssuesReferences`, timeline | ID in branch/title/description + magic words; attachments | key in branch/PR title/commit; Development panel; DevInfo API |
| PR-driven status  | auto-close on merge via keyword                                        | per-team automation on draft/open/review/ready/merge      | Automation / workflow triggers; smart commits                 |
| Webhook signature | `X-Hub-Signature-256: sha256=` HMAC raw body                           | `Linear-Signature` hex HMAC raw body + 60 s timestamp     | `X-Hub-Signature: sha256=` (admin secret) or JWT (apps)       |
| Webhook dedupe id | `X-GitHub-Delivery`                                                    | `Linear-Delivery`                                         | `X-Atlassian-Webhook-Identifier`                              |
| Response deadline | 10 s                                                                   | 5 s                                                       | not stated (primary flow targets 30 s delivery)               |
| Automatic retries | none (manual redeliver, 3 days)                                        | 3 (1 m, 1 h, 6 h)                                         | up to 5 (5–15 min)                                            |

## 5. Open uncertainties

- **GitHub:**
  - The REST `mergeable_state` values are not documented.
  - The search qualifiers `is:blocked` and `blocked-by:` appear only in the changelog.
  - Some GraphQL remove mutations were not seen on the reference page.
- **Linear:**
  - "Blocked by" is inferred from schema semantics.
  - The maximum page size is undocumented.
  - The metadata keys of GitHub attachments are undocumented.
- **Jira:**
  - Whether `development[pullrequests].merged` exists.
  - The runtime `statusCategory` key strings.
  - The `ORDER BY Rank` wording.
  - The details of Connect JWT verification.
