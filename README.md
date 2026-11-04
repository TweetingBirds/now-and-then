# Now and Then

A notebook-style todo list, made for Tiffany. It works the way her paper notebook does:

- **Now** is today's page. **Tomorrow** is the next page. **Later** is for things to remember someday.
- Checked-off todos stay where they are for the rest of the day. The next morning they move to **Done**, grouped by date. A setting can move them to Done as soon as they are checked instead.
- Each morning, unfinished Tomorrow todos move into Now (this can be turned off in Settings).
- Lists can be renamed, recolored, reordered and added, up to 10.
- Todos move between lists by dragging the ⋮⋮ handle, or with the ••• menu.
- Deleting, moving or checking off a todo (or deleting a list, or putting a todo back from Done) shows a toast with **Undo** for a few seconds. Cmd+Z or Ctrl+Z works too while it's showing. Undo syncs like any other edit.
- **Done** can be searched and filtered by when a todo was finished (today, this week, this month) and which list it came from. The ↩ button on a finished todo puts it back, unchecked, on its list.
- Dark mode follows the system, or pick Light or Dark per device in Settings. Phones give a small buzz when a todo is picked up and dropped (Android, and iPhone on iOS 18 or later).
- On a Mac, keyboard shortcuts cover adding, moving and checking off todos. Press **?** to see them.
- Sync starts from an **invite link**: open it, tap **Join**, and that person has their own synced board. **Copy link for another device** in Settings adds a phone, tablet or computer to the same board, and **Delete synced board…** removes the board and its backups from the Worker.
- The bottom of Settings links to **What's New**, **Support & FAQ**, **Privacy** and **Terms**. What's New is marked *New* after an update until it's opened.

It's a progressive web app: open it in Safari or Chrome and choose **Add to Home Screen** to install it. It works offline, and syncs through a small Cloudflare Worker when one is set up.

## How it's built

| Path | What it is |
| --- | --- |
| `app/` | The web app: plain HTML, CSS and JavaScript, no build step. Deployed to GitHub Pages. |
| `app/whats-new.html`, `support.html`, `privacy.html`, `terms.html` | Info pages. Each stands on its own (`pages.css`, `pages.js`), so the Support and Privacy URLs can also go on an App Store listing. Add a card to What's New whenever `APP_VERSION` is bumped. Privacy and Terms are drafts until reviewed. |
| `app/sw.js` | Service worker for offline use. Its cache name is stamped with the build on each deploy. |
| `worker/` | Cloudflare Worker that stores each person's board in Workers KV. Tests: `npm test` in `worker/` (they also run before every deploy). |
| `docs/self-hosting.md` | How anyone can run their own sync Worker on Cloudflare's free plan. Linked from Support. |
| `.github/workflows/pages.yml` | Deploys `app/` to GitHub Pages on every push to `main`, stamping the build number, commit and date into the app and writing `version.json`. |
| `.github/workflows/worker.yml` | Deploys the Worker to Cloudflare on pushes that change `worker/`. |

Data lives in the browser's local storage first. When sync is set up, the app sends its whole board to the Worker after each change and whenever it's reopened. The Worker merges it with the stored board (the newest edit wins for each list, each todo and the settings) and sends the result back, so a phone and an iPad can both be used without overwriting each other. While the app is on screen it also checks for changes from other devices every 20 seconds, and right away when its tab or window comes back into focus, so a board left open on a computer keeps up with edits made on a phone. These checks only read the board (no KV writes), pause while the tab is hidden, and wait while you're typing or dragging.

The badge in the header shows where things stand: **Synced · Name** (and whose board this device syncs with), **Syncing…**, **Offline · 3 unsynced** when the Worker can't be reached, or **Sync problem** when it refuses (for example a wrong token). Unsynced changes are counted against what the Worker last confirmed, so the count survives closing the app while offline, and while offline each unsynced todo gets a small amber ring. Tap the badge to sync right away; on a phone, tapping also explains a problem. If an edit made on this device loses to a newer edit of the same todo or list from another device, a message says so (for example “Buy milk” was also changed on another device).

Each person has their own board and their own access token. There are two kinds of token:

- **Owner tokens** are Worker secrets named `TOKEN_<NAME>`, set by hand (Nate's and Tiffany's). That board is stored under the KV key `board:<name>`. Two secrets must never hold the same value.
- **Invited tokens** are made by the Worker when someone opens an invite link (see [Invites](#invites)). That board is stored under `board:b_<random id>`, and KV holds only a SHA-256 hash of the token (`tok:<hash>`), never the token itself.

To share one board, two people use the same token: **Copy link for another device** in Settings makes a link that carries it.

## Setup

### 1. Turn on GitHub Pages

In the repo, go to **Settings → Pages** and set **Source** to **GitHub Actions**. After the next push to `main`, the app is at
`https://tweetingbirds.com/now-and-then/` (the TweetingBirds custom domain).

### 2. Connect Cloudflare

The KV namespace `now-and-then` already exists in the Cloudflare account, and its id is in `worker/wrangler.toml`.

Add these as repository secrets under **Settings → Secrets and variables → Actions**:

| Secret | Where to get it |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard → My Profile → API Tokens → Create Token → **Edit Cloudflare Workers** template. |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard → Workers & Pages → the Account ID on the right. |

Then run **Actions → Deploy sync Worker to Cloudflare → Run workflow**. The Worker is deployed as `now-and-then-sync`, at
`https://now-and-then-sync.<your-subdomain>.workers.dev`. Opening that address in a browser shows "Now and Then sync is running."

Each person's access token is a **Worker secret**, not a repo secret. Make one long random string per person (for example `openssl rand -hex 32`) and set it from `worker/`:

```sh
npx wrangler secret put TOKEN_NATE
npx wrangler secret put TOKEN_TIFFANY
```

or in the Cloudflare dashboard under **Workers & Pages → now-and-then-sync → Settings → Variables and Secrets**. Deploys keep these secrets as they are, so changing the Worker code never changes anyone's token. To add another person, add another `TOKEN_<NAME>` secret.

Every token must be different. If two `TOKEN_*` secrets hold the same value the Worker refuses to sync with it instead of guessing whose board it is. The Worker also tells the app whose board a token opens (Settings shows "Syncing with Nate's board"), and if a device's token suddenly opens a different board than before, the app stops and warns instead of merging the two boards.

### 3. Connect each phone

Open the app, tap **Settings**, and paste the Worker address and that person's token, then **Save and sync**. The first sync on a new device loads the saved board. The pill at the top shows **Synced**, **Syncing…**, **Offline** or **Sync problem** (tap it to retry).

## Invites

Owners listed in `ADMINS` in `worker/wrangler.toml` (now `nate`) see **Invite people** in Settings. **Create invite link** asks the Worker for a one-time code and shares a link like `https://tweetingbirds.com/now-and-then/#join=<code>&sync=<worker address>`. The code and the Worker address sit after the `#`, so GitHub Pages never sees them.

Opening the link shows **Join Now and Then sync**, with an optional name for the board and the Worker's host name. **Join** calls `POST /join`, which deletes the invite, makes a new board and a new token, and returns the token once. The app saves it like a pasted token and uploads the lists already on that device. Invites expire after 14 days (up to 30) and Settings lists open ones with **Revoke**. The note on an invite ("Mom") is only for the person inviting; it's stored with the board so `GET /boards` can say who is who.

**Copy link for another device** makes `#connect=<token>&sync=<worker address>`. Opening it connects that device to the same board, the same way **Save and sync** does with a pasted token.

### Deleting a board

People who joined by invite see **Delete synced board…** in Settings. It calls `DELETE /data?confirm=delete`, which deletes `board:<id>`, every `snap:<id>:` copy and the token's `tok:` key, then leaves `gone:<hash>` (no other data) for 30 days. While that marker exists the token gets **410 Gone**, and the person's other devices turn sync off and say the board was deleted, instead of uploading it again. The app can also erase the lists on the device doing the delete.

Owner boards (`TOKEN_*`) can't delete themselves, because the secret would keep working. Remove those by hand: `wrangler secret delete TOKEN_<NAME>`, then delete `board:<name>` in the KV dashboard (its snapshots expire within 30 days). An admin can delete an invited board for someone who emails in: `GET /boards` lists them, `DELETE /boards/<id>` removes one just like the person's own delete.

### Worker API

| Request | Token | What it does |
| --- | --- | --- |
| `GET /data`, `PUT /data` | any | Read, or merge and save, the board. |
| `DELETE /data?confirm=delete` | invited | Delete the board, its copies and its token. |
| `GET /snapshots`, `GET /snapshots/<id>`, `POST /snapshots` | any | Nightly copies (see Backups). |
| `POST /join` `{code, name}` | none | Turn an invite into a board and token. |
| `POST /invites` `{label, days}`, `GET /invites`, `DELETE /invites/<code>` | admin | Make, list and revoke invites. |
| `GET /boards`, `DELETE /boards/<id>` | admin | List invited boards (name, note, date joined) and remove one. |

Every board response carries `X-Board` (the board id the app pins itself to), `X-Board-Name`, `X-Board-Kind` (`owner` or `invited`) and, for admins, `X-Board-Admin: 1`.

### Costs and limits

All of this stays inside Cloudflare's free plan, with nothing to maintain:

- **KV writes (1,000 a day)** are the tight one. Each sync after an edit is one write, each board's nightly copy is one, and joining is one. Polling never writes.
- **KV reads (100,000 a day).** The 20-second refresh reads the board, and an invited token's lookup is cached for a minute inside the Worker, so it costs about one read per refresh, like an owner token.
- **KV deletes and lists (1,000 a day each)** are only used by joining, deleting and the nightly backup.
- `MAX_BOARDS` in `wrangler.toml` (50) caps invited boards so a forwarded invite can't run the account over. If a free limit is reached, Cloudflare refuses requests until the next day; it never bills a free account.

Anyone who would rather keep their lists in their own Cloudflare account can follow [docs/self-hosting.md](docs/self-hosting.md).

## Backups

Settings → **Backups** has three buttons:

- **Download backup** saves a JSON file with every list, todo and Done item. On a phone it opens the share sheet, so choose **Save to Files**.
- **Download CSV** saves the same todos as a spreadsheet (list, todo, status, dates) for Numbers or Excel. It can't be restored.
- **Restore from file…** reads a backup file and puts every list and todo in it back the way it was. Things added since the backup are kept unless you tick **Also remove lists and todos added since this backup**. The restore syncs to the other devices like any other edit.

The Worker also keeps its own copies. Every night at 09:00 UTC (the cron trigger in `wrangler.toml`) it copies each board to a KV key `snap:<name>:<time>`, which KV deletes by itself after 30 days. When sync is on, Settings lists these copies and can restore or download any of them. Before any restore, the app asks the Worker for one more copy of the board as it was, labelled "before restore", so a restore can be undone the same way. The Worker's backup endpoints use the same token as `/data`, and a token only sees its own board's copies:

| Request | What it does |
| --- | --- |
| `GET /snapshots` | Lists the board's copies, newest first, with counts. |
| `GET /snapshots/<id>` | Returns one copy. |
| `POST /snapshots` | Takes a copy now. |

## Local development

Any static file server works, for example:

```sh
npx serve app
```
