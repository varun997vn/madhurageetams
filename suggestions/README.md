# Suggested corrections — review queue

Readers can correct a song's lyrics in whichever script they are reading: the whole
song opens in one text box, and only the lines they changed are sent. The proposal
comes to you first; only what you accept is published.

```
Reader (unlocked site)          Apps Script web app            GitHub
  Suggest a correction  --->    row in your Sheet (pending)
                                email to you: was vs suggested
You: Review and decide  --->    review page for the song
       Publish ticked changes                           --->   commit to
                                                               web/public/data/corrections.json
                                                               -> normal Pages deploy
       Reject           --->    row marked rejected, nothing published
```

Cost: nothing. It runs on a free Google account (quota: 100 emails a day) and the
existing GitHub Pages deploy.

## One-time setup (about 15 minutes)

1. **Sheet.** Create a Google Sheet, e.g. "Madhurageetam corrections". Keep it private;
   it is the queue and the audit log.
2. **Script.** In the Sheet: Extensions → Apps Script. Replace the editor contents with
   `Code.gs` from this folder. Add a second script file (+ → Script) named `Rebase`
   and paste `Rebase.gs` into it. Save.
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

When you later change `Code.gs` or `Rebase.gs`: paste the new contents, then Deploy →
Manage deployments → edit → Version: **New version**. That keeps the same URL. A brand-new deployment gets a new URL, which would
have to go into `suggest.json` again.

## Reviewing

Each suggestion arrives as an email showing every changed line as it was and as
suggested. **Review and decide** opens the review page for that song. Nothing happens
until you press a button there (mail scanners follow links, so a link alone must never
publish).

The review page lists every suggestion waiting for the song, oldest first. Each change
has a tick box and a status:

| Status | Meaning |
|---|---|
| Ready | Still applies. Ticked by default. |
| Already on the site | Someone else's accepted correction made the same change. Nothing to publish. |
| Conflict | The line was changed to something else after this reader opened the song. The page shows what it reads now. It cannot be ticked. |
| Competes with … | Another waiting suggestion changes the same line differently. The page shows the other version. Publish the one you prefer; the other then becomes a conflict. |
| Other lines were added here since | Both sets of lines are kept. Look at the song afterwards to check their order. |
| not checked | Sent from a browser still running an older copy of the site. Compare with the site yourself before publishing. |

**Publish ticked changes** commits only the ticked lines, so you can take part of a
suggestion by unticking the rest. **Reject** closes it and publishes nothing. After
either, the page is shown again with every remaining suggestion re-checked against the
new state, so you can work down the list in one sitting.

### Several readers, one song

Nobody is locked out of a song while a suggestion is waiting. Each suggestion records
how many accepted corrections the song had when the reader opened it; on the review
page and again at the moment of publishing, it is compared with everything accepted
since. Changes to different lines all go through, the same fix sent twice is published
once, and only two different fixes to one line need a decision from you. A change that
would no longer apply is never committed.

Accepting commits to `main` as you, and the site redeploys in a few minutes. Readers
see the fix on their next visit.

To undo an accepted correction, delete its entries from
`web/public/data/corrections.json` and push. Entries for a song apply in order, so
undo the newest first: removing an older one can switch off later ones built on it.
Suggestions already waiting for that song were counted against the longer list. If the
page says one cannot be checked, or you deleted entries from the middle of the list,
compare it with the site yourself, or reject it and ask the reader to send it again.

If the email never arrives, the suggestion is still in the Sheet as `pending`, with the
reason in its `commit` column. If the form itself reports "The review queue is not set
up correctly", the text in brackets is the cause; Apps Script → Executions has the full
error.

## What an accepted correction changes

- Readers can change a line, remove a line, or add lines anywhere, including at the top.
  Headings and blank lines cannot be changed. In the email and on the review page, the
  Line column counts lines as originally shipped; "12 +2" means the second line that
  was added after line 12.
- Only the script the reader edited. A Telugu fix does not touch the Devanagari line,
  and a line added or removed in Telugu is added or removed in Telugu only.
- Each entry records the text it expects and applies only while the line still reads
  that way, so an entry can never overwrite a line it was not written against.
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

## Reader details

Every suggestion must carry the reader's name, country code and phone number, so you
can ask about a doubtful change; country of residence is optional. They appear in the
review email ("From:"), on the review page and in the Sheet's `name`, `phone` and
`country` columns, and nowhere else: nothing about the reader is written to
`corrections.json` or the commit. The review page opens only from the signed link in
your email. The Sheet therefore holds personal data;
keep it private and clear out old rows when you no longer need them.

The Sheet's `base` column is the count described under "Several readers, one song", and
`decisions` records what happened to each change when the suggestion was accepted.

After a password or salt rotation, rerun step 4 and update `UNLOCK_TOKEN`.
