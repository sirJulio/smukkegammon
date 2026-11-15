# games.jdunne.au

Home of SmukkeGammon (backgammon) and future games, served at games.jdunne.au.

Backgammon for two players on separate devices, with an optional bot opponent. Runs on Cloudflare: the page is served as static assets, and each game room is a Durable Object that stores the board and pushes every move to both players over a WebSocket.

No accounts are needed. Each room has a code (for example `wombat-482`); anyone with the invite link can join that room.

## Files

- `public/index.html` — the games landing page (games.jdunne.au)
- `public/backgammon/index.html` — the backgammon game (games.jdunne.au/backgammon)
- `public/404.html` — not-found page
- `src/worker.js` — the Worker and the `GameRoom` Durable Object
- `wrangler.toml` — Cloudflare settings

## Deploy

You need Node.js 18 or later and your Cloudflare account (the one that already runs jdunne.au).

1. In this folder, install the tools:
   ```
   npm install
   ```
2. Sign in to Cloudflare (opens a browser window):
   ```
   npx wrangler login
   ```
3. Deploy:
   ```
   npm run deploy
   ```
   Wrangler prints a `*.workers.dev` address. Open it to check the game loads.
4. Add the subdomain. In the Cloudflare dashboard go to **Workers & Pages → games-jdunne → Settings → Domains & Routes → Add → Custom domain**, and enter `games.jdunne.au`. Cloudflare creates the DNS record and certificate for you, because jdunne.au's DNS is already on Cloudflare.

Durable Objects with SQLite storage are available on the Workers Free plan, so this should cost nothing at two-player scale.

## Play

1. Open games.jdunne.au and choose Backgammon. You get a new room and the address changes to `/backgammon/?room=<code>`.
2. Tap **Copy invite link** and send it to your friend.
3. Each of you taps **Sit as White** or **Sit as Black**. Your seat is remembered on that device.

To play the computer, sit at one colour and tap **Invite bot as** the other.

## Adding a game

Put it in its own folder under `public/` (for example `public/chess/index.html`) and add a tile for it to `public/index.html`. Redeploy with `npm run deploy`.

## Game history

Finished games (with every roll and move) are saved per room. To see them:

```
https://games.jdunne.au/api/room/<code>/history
```

The latest 200 games per room are kept.

The current board of a room can be read (not changed) at `https://games.jdunne.au/api/room/<code>/state`.

## Run locally

```
npm run dev
```

then open http://localhost:8787.

## Bot opponent (wildbg)

Any player or observer can tap **Invite bot as White/Black** to seat the [wildbg](https://github.com/carsten-wenderdel/wildbg) engine (MIT/Apache-2.0, by Carsten Wenderdel). The bot runs in the browser of whoever invited it, so that page has to stay open while the bot plays. **Auto finish** also plays with wildbg when it is loaded, and falls back to a simple race strategy when it isn't.

The engine is not stored in this repo. The GitHub Action in `.github/workflows/deploy.yml` downloads wildbg (pinned to a fixed commit, using the stronger networks from its `nets` branch), compiles it to WebAssembly, and places it in `public/backgammon/wildbg/` before deploying.

## Automatic deploys from GitHub

Every push to `main` builds and deploys the site. For the deploy step, add two repository secrets under **Settings → Secrets and variables → Actions**:

- `CLOUDFLARE_ACCOUNT_ID`: shown on the right-hand side of the Workers & Pages overview in the Cloudflare dashboard.
- `CLOUDFLARE_API_TOKEN`: create one at **My Profile → API Tokens → Create Token**, using the **Edit Cloudflare Workers** template.

Without the secrets the Action still builds everything and offers the finished site as a downloadable artifact named `site`.
