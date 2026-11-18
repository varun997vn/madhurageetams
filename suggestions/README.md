# Suggested corrections — review queue

Readers can propose a fix to any lyric line, in whichever script they are reading. The
proposal comes to you first; only what you accept is published.

```
Reader (unlocked site)          Apps Script web app            GitHub
  Suggest a correction  --->    row in your Sheet (pending)
                                email to you: now vs suggested
You: Accept             --->    confirm page, one button --->  commit to
                                                               web/public/data/corrections.json
                                                               -> normal Pages deploy
You: Reject             --->    row marked rejected, nothing published
```

Cost: nothing. It runs on a free Google account (quota: 100 emails a day) and the
existing GitHub Pages deploy.

## One-time setup (about 15 minutes)

1. **Sheet.** Create a Google Sheet, e.g. "Madhurageetam corrections". Keep it private;
   it is the queue and the audit log.
2. **Script.** In the Sheet: Extensions → Apps Script. Replace the editor contents with
   `Code.gs` from this folder and save.
3. **GitHub token.** GitHub → Settings → Developer settings → Fine-grained tokens →
   Generate. Repository access: only `varun997vn/madhurageetams`. Permissions:
   **Contents: Read and write**, nothing else. Note the expiry date (one year at most):
   when it lapses, Accept reports "Could not publish" and the suggestion stays pending
   until you paste in a new token.
4. **Unlock token.** On your machine:

   ```bash
   MG_PASSWORD='…' python build/tools/suggest_token.py
   ```

5. **Script Properties.** Apps Script → Project Settings → Script Properties:

   | Property | Value |
   |---|---|
   | `GITHUB_TOKEN` | the token from step 3 |
   | `UNLOCK_TOKEN` | the line printed in step 4 |
   | `ADMIN_EMAIL` | where review emails go (optional; defaults to your Google account) |

6. **Check.** In the editor choose the function `testSetup` and Run. Approve the
   permission prompt. You should receive a "setup OK" email.
7. **Deploy.** Deploy → New deployment → type **Web app** → Execute as **Me**, Who has
   access **Anyone** → Deploy. Copy the web app URL (it ends in `/exec`).
8. **Switch it on.** Put that URL in `web/src/data/suggest.json` as `"url"`, commit and
   push. The "Suggest a correction" button appears on every song once the deploy
   finishes. While `url` is empty the button is not rendered at all.

When you later change `Code.gs`: Deploy → Manage deployments → edit → Version: **New
version**. That keeps the same URL. A brand-new deployment gets a new URL, which would
have to go into `suggest.json` again.

## Reviewing

Each suggestion arrives as an email showing every changed line as it is now and as
suggested, with a link to the song. **Accept and publish** and **Reject** each open a
confirmation page; nothing happens until you press the button there (mail scanners
follow links, so a link alone must never publish). A suggestion is accepted or rejected
as a whole. To take only part of one, reject it and add the lines you want to
`corrections.json` by hand.

Accepting commits to `main` as you, and the site redeploys in a few minutes. Readers
see the fix on their next visit.

To undo an accepted correction, delete its entry from
`web/public/data/corrections.json` and push.

## What an accepted correction changes

- Only the script the reader edited. A Telugu fix does not touch the Devanagari line.
- Each entry records the text it replaced and applies only while the shipped line still
  reads that way, so an entry can never overwrite a line it was not written against.
- Search is not re-indexed. A corrected word becomes searchable after the next offline
  rebuild; the reading view, exports and print sheet are correct immediately.

At the next offline rebuild, fold the accepted fixes into `madhurageetams-source` so
they become part of the data itself. Entries whose fix is already in the data stop
applying on their own and can then be removed.

## Abuse limits

The endpoint URL is visible in the site's JavaScript, so the script defends itself:

- a submission must carry a token that only a browser which unlocked the site can
  compute (derived one-way from the key; the script never holds the key);
- at most 40 changed lines per submission, 300 characters per line, 50 submissions a day;
- a hidden field that only bots fill in.

After a password or salt rotation, rerun step 4 and update `UNLOCK_TOKEN`.
