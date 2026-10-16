# Movie Quest — Cloudflare Worker

Movie Quest stays hosted on GitHub Pages. Firebase Authentication and Firestore store each user's progress. This Worker proxies TMDB API calls so the TMDB read token never appears in the public frontend.

## Deploy (Cloudflare Workers Free)

1. Create a free Cloudflare account at https://dash.cloudflare.com/.
2. Go to **Workers & Pages → Create → Import a repository** (or **Create Worker**).
3. Connect GitHub and select `vchaillo/movie-quest`.
4. If Git integration supports a root directory, choose `worker`. Build command: `npx wrangler deploy`. Deploy command: `npx wrangler deploy`. No output directory is required.
5. Alternatively, from a local clone run:
   ```bash
   cd worker
   npm install
   npx wrangler login
   npx wrangler secret put TMDB_READ_TOKEN
   npm run deploy
   ```
6. In the Cloudflare Worker dashboard, open **Settings → Variables and Secrets**, add `TMDB_READ_TOKEN` as **Secret**, paste the TMDB **API Read Access Token**, and redeploy if necessary. Never add this token to GitHub.
7. The Worker will have a URL like `https://movie-quest-api.<your-subdomain>.workers.dev`. Test `/health` and `/api/search?q=spielberg&type=director`.
8. Open Movie Quest → **⚙ API**, paste your Worker HTTPS origin (without a trailing slash), and save.

The frontend saves only the Worker URL in localStorage, not the TMDB token.

## Routes

- `GET /health`
- `GET /api/search?q=...&type=all|actor|director|movie`
- `GET /api/person/:id/movies?role=actor|director`
- `GET /api/movie/:id`

## Security / limits

The token stays secret on Cloudflare, but the public Worker URL can still be called outside a browser: CORS is **not** an authentication mechanism. For higher traffic, add Cloudflare rate limits or verify Firebase ID tokens at the Worker before making upstream TMDB calls. TMDB API terms and attribution requirements still apply.

## Firebase

Firestore security rules are configured directly in the Firebase Console. There is no need for Firebase Blaze or Firebase Functions for this setup.
