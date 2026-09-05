# Nearby Connect — MVP

Login → see people within 1km who are also logged in and sharing location →
send a connect request → once accepted, chat with text + images.

## Run it

```bash
npm install
npm start
```

Then open `http://localhost:3000` on two different devices/browsers (or two
browser profiles) on the same network to test — you need at least two
accounts within 1km of each other to see anyone in the "Nearby" list.

Location only works over `https://` or `localhost` — mobile browsers block
Geolocation on plain `http://` for any other host. If you deploy this,
you need TLS (any host like Render/Railway/Fly.io + free Let's Encrypt gets
you this for free).

## How it works

- **Auth**: username + bcrypt-hashed password, JWT in an httpOnly cookie.
- **Location**: browser's Geolocation `watchPosition` posts lat/lng every
  time it changes; nearby list is polled every 15s.
- **Nearby matching**: Haversine distance, computed server-side against
  everyone whose location was updated in the last 5 minutes (so people who
  closed the tab don't linger as "nearby" forever).
- **Connections**: pending → accepted/rejected. Chat is only unlocked after
  both sides accept — no messaging strangers before that.
- **Chat**: REST for history/sending, WebSocket for real-time push so
  messages and connection requests show up live without refreshing.
- **Images**: uploaded via multipart form, stored on disk under
  `public/uploads/`, 5MB limit, image-mimetype only.

## What this MVP does NOT have (be honest with yourself before shipping this)

1. **No blocking or reporting.** Any real-time "strangers near you" app
   needs this before real users touch it. Right now an accepted connection
   can message you forever with no way to cut them off except never
   opening the app.
2. **No rate limiting.** Someone could spam connection requests or hammer
   `/api/nearby`. Add `express-rate-limit` before deploying.
3. **Uploads are unauthenticated at the URL level.** Anyone with the image
   URL can view it — fine for an MVP, not fine for anything sensitive.
   For real use, serve images through an authenticated route instead of
   static hosting.
4. **JWT_SECRET defaults to a placeholder.** Set a real `JWT_SECRET`
   environment variable before deploying anywhere public.
5. **GPS accuracy is not 1km-precise.** Phone GPS is typically accurate to
   5–50m outdoors and much worse indoors/urban canyon. The 1km filter is
   solid; don't expect the *distance shown* to be exact.
6. **Location tracking of real people is a genuine privacy/safety
   surface.** Think about consent, data retention (how long do you keep
   location history?), and what happens if this gets used to track someone
   who doesn't want to be found. This is the actual hard part of this kind
   of app — not the code.

## Stack

Node.js, Express, better-sqlite3, bcryptjs, jsonwebtoken, multer, ws.
Plain HTML/CSS/JS frontend (no framework, no build step) — same pattern as
your task-management app.
