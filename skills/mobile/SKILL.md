---
name: mobile
description: Send the current Claude Code or Codex task to HTML共有くん for phone review, then wait for approval or follow-up instructions and continue the same task. Use only when the user explicitly invokes /mobile or $mobile, asks to continue from a phone, or asks to stop mobile monitoring.
---

# Mobile handoff

Use the `html-share` CLI. Do not call the review API directly and do not print device tokens.

## Stop

When the argument is `stop`, resolve the session ID as described below and run:

```bash
html-share review stop --session "<session-id>"
```

Report whether a watcher was stopped, then end the workflow.

## Resolve the session

Use the first available value:

1. `codex-${CODEX_THREAD_ID}`
2. `claude-${CLAUDE_SESSION_ID}`
3. A stable ID already used for this conversation

If none exists, explain that the current client did not expose a resumable session ID and stop before creating a review card.

## Handoff workflow

1. Pull answered cards for this session before doing more work:

   ```bash
   html-share review pull --session "<session-id>"
   ```

2. Apply returned comments as new user instructions. An approved `kind: run` card permits exactly the action in its `recommendation`. An approved `kind: todo` card only means the user finished their own task, so close it without further work (card kinds are in `references/review-cards.md`). Complete a card only after its instruction has been handled:

   ```bash
   html-share review complete <card-id>
   ```

3. Create or replace one self-contained status HTML inside a directory listed in `content.roots`. Keep it phone-friendly and concise:
   - current request and status;
   - work completed;
   - decisions or actions needed from the user;
   - next action.

   Do not include secrets, raw logs, hidden reasoning, or unrelated repository data.

4. Register the page if it is not already configured, then publish:

   ```bash
   html-share page add <relative-html-path> --title "<short task title>"
   html-share publish
   ```

5. Push one status card. Add separate cards only for genuinely independent decisions. Use at most five cards. Read [review-cards.md](references/review-cards.md) when multiple cards are needed.

   ```bash
   printf '%s' '[{"title":"<task title>","question":"生成結果を確認して、追加の指示があればコメントで返してください。","context":"HTML共有くんの生成結果一覧に状況ページを追加しました。","recommendation":"対応内容を確認してください。"}]' \
     | html-share review push --session "<session-id>"
   ```

6. Start the watcher and keep the task active:

   ```bash
   html-share review watch --session "<session-id>"
   ```

7. Treat returned comments as user instructions. Apply them, complete the handled card, update the status page, publish again, and repeat the review cycle when another decision is needed.

Do not declare the task complete while a watcher is active or an unanswered card still blocks the requested work.
