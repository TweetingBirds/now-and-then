# Now and Then

A notebook-style todo list, made for Tiffany. It works the way her paper notebook does:

- **Now** is today's page. **Tomorrow** is the next page. **Later** is for things to remember someday.
- Checked-off todos stay where they are for the rest of the day. The next morning they move to **Done**, grouped by date. A setting can move them to Done as soon as they are checked instead.
- Each morning, unfinished Tomorrow todos move into Now (this can be turned off in Settings).
- Lists can be renamed, recolored, reordered and added, up to 10.
- Todos move between lists by dragging the ⋮⋮ handle, or with the ••• menu.
- **Done** can be searched and filtered by when a todo was finished (today, this week, this month) and which list it came from. The ↩ button on a finished todo puts it back, unchecked, on its list.

It's a progressive web app: open it in Safari or Chrome and choose **Add to Home Screen** to install it. It works offline, and syncs through a small Cloudflare Worker when one is set up.

## How it's built

| Path | What it is |
| --- | --- |
| `app/` | The web app: plain HTML, CSS and JavaScript, no build step. Deployed to GitHub Pages. |
| `app/sw.js` | Service worker for offline use. Its cache name is stamped with the build on each deploy. |
| `worker/` | Cloudflare Worker that stores each person's board in Workers KV. |
| `.github/workflows/pages.yml` | Deploys `app/` to GitHub Pages on every push to `main`, stamping the build number, commit and date into the app and writing `version.json`. |
| `.github/workflows/worker.yml` | Deploys the Worker to Cloudflare on pushes that change `worker/`. |

Data lives in the browser's local storage first. When sync is set up, the app sends its whole board to the Worker after each change and whenever it's reopened. The Worker merges it with the stored board (the newest edit wins for each list, each todo and the settings) and sends the result back, so a phone and an iPad can both be used without overwriting each other. While the app is on screen it also checks for changes from other devices every 20 seconds, and right away when its tab or window comes back into focus, so a board left open on a computer keeps up with edits made on a phone. These checks only read the board (no KV writes), pause while the tab is hidden, and wait while you're typing or dragging.

Each person has their own board and their own access token. The Worker looks for secrets named `TOKEN_<NAME>` and stores that person's board under the KV key `board:<name>`. To share one board, two people use the same token (one `TOKEN_<NAME>` secret, for example `TOKEN_FAMILY`). Two secrets must never hold the same value.

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
