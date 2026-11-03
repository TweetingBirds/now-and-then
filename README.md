# Now and Then

A notebook-style todo list, made for Tiffany. It works the way her paper notebook does:

- **Now** is today's page. **Tomorrow** is the next page. **Later** is for things to remember someday.
- Checked-off todos stay where they are for the rest of the day. The next morning they move to **Done**, grouped by date. A setting can move them to Done as soon as they are checked instead.
- Each morning, unfinished Tomorrow todos move into Now (this can be turned off in Settings).
- Lists can be renamed, recolored, reordered and added, up to 10.
- Todos move between lists by dragging the ⋮⋮ handle, or with the ••• menu.

It's a progressive web app: open it in Safari or Chrome and choose **Add to Home Screen** to install it. It works offline, and syncs through a small Cloudflare Worker when one is set up.

## How it's built

| Path | What it is |
| --- | --- |
| `app/` | The web app: plain HTML, CSS and JavaScript, no build step. Deployed to GitHub Pages. |
| `app/sw.js` | Service worker for offline use. Its cache name is stamped with the build on each deploy. |
| `worker/` | Cloudflare Worker that stores each person's board in Workers KV. |
| `.github/workflows/pages.yml` | Deploys `app/` to GitHub Pages on every push to `main`, stamping the build number, commit and date into the app and writing `version.json`. |
| `.github/workflows/worker.yml` | Deploys the Worker to Cloudflare on pushes that change `worker/`. |

Data lives in the browser's local storage first. When sync is set up, the app sends its whole board to the Worker after each change and whenever it's reopened. The Worker merges it with the stored board (the newest edit wins for each list, each todo and the settings) and sends the result back, so a phone and an iPad can both be used without overwriting each other.

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

## Local development

Any static file server works, for example:

```sh
npx serve app
```
