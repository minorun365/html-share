# Review card format

Use a JSON array. Each card accepts these fields:

| Field | Required | Limit | Purpose |
|---|---:|---:|---|
| `title` | yes | 160 | Identify the task on a phone |
| `question` | yes | 1,000 | State the decision in one sentence |
| `context` | no | 3,000 | Give only the facts needed to decide |
| `recommendation` | no | 1,000 | State the agent's recommended action |
| `kind` | no | `run` / `todo` | Tell the user what the approve button means (see below) |

Do not include code, logs, credentials, signed URLs, or long histories. Put detail in the status HTML.

The first card should always summarize the task. Add more cards only when the answers can differ independently.

## Card kinds

Set `kind` when approving the card means something more specific than "yes".

| `kind` | Badge | Approve button | What the agent does after approval |
|---|---|---|---|
| (empty) | (none) | 承認 | Reads the approval or comment and continues |
| `run` | 承認で実行 | 承認して任せる | Executes exactly what `recommendation` says. Write it as the concrete action, not as advice |
| `todo` | あなたの番 | 済んだ | Nothing to do. The approval only means the user finished their own task, so close the card |

Use `todo` for work only the user can do (signing in, pressing a final submit button, a physical action). Put the steps in `recommendation`. Cards with a kind are never folded, so keep them short.
