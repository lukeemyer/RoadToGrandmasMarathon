# Road to Grandma's Marathon

Personal marathon training tracker with automatic Strava sync via Netlify Functions + Netlify Blobs.

## Architecture

```
Run on watch → Strava → webhook POST → Netlify Function → Netlify Blobs → tracker app
```

## Local development

```bash
npm install
netlify dev   # starts local dev server with function emulation
```

## Deploy

```bash
netlify deploy --prod
```

## Environment variables

Set these in Netlify dashboard (Site → Environment variables) or via CLI:

```bash
netlify env:set STRAVA_CLIENT_ID     "your_client_id"
netlify env:set STRAVA_CLIENT_SECRET "your_client_secret"
netlify env:set STRAVA_VERIFY_TOKEN  "your_verify_token"
netlify env:set SHARED_SECRET        "your_shared_secret"
```

## Test commands

Replace `LIVE_URL` and `SHARED_SECRET` with your actual values.

**Test get-runs:**
```bash
curl -H "Authorization: Bearer $SHARED_SECRET" \
  "$LIVE_URL/.netlify/functions/get-runs"
# Expected: {"runs":[]}
```

**List webhook subscriptions:**
```bash
curl -H "Authorization: Bearer $SHARED_SECRET" \
  "$LIVE_URL/.netlify/functions/strava-subscribe?action=list"
```

**Create webhook subscription:**
```bash
curl -H "Authorization: Bearer $SHARED_SECRET" \
  "$LIVE_URL/.netlify/functions/strava-subscribe?action=create&callback=$LIVE_URL/.netlify/functions/strava-webhook"
```

**Delete a subscription:**
```bash
curl -H "Authorization: Bearer $SHARED_SECRET" \
  "$LIVE_URL/.netlify/functions/strava-subscribe?action=delete&id=SUBSCRIPTION_ID"
```

## One-time OAuth setup

1. Update Strava app callback domain at https://www.strava.com/settings/api to your Netlify domain (no protocol, no path).
2. Open in browser:
   ```
   https://www.strava.com/oauth/authorize?client_id=CLIENT_ID&response_type=code&redirect_uri=LIVE_URL/.netlify/functions/strava-callback&approval_prompt=force&scope=read,activity:read_all
   ```
3. Authorize — tokens are stored automatically in Netlify Blobs.

## App configuration

1. Open your live site
2. Settings (gear icon) → Data tab → Cloud sync
3. **Functions endpoint**: `https://your-site.netlify.app/.netlify/functions`
4. **Shared secret**: your `SHARED_SECRET` value
5. Test connection → Save

## Webhook subscription management

Strava allows only one active subscription per app. To reset:

```bash
# List
curl -H "Authorization: Bearer $SHARED_SECRET" "$LIVE_URL/.netlify/functions/strava-subscribe?action=list"
# Delete
curl -H "Authorization: Bearer $SHARED_SECRET" "$LIVE_URL/.netlify/functions/strava-subscribe?action=delete&id=ID"
# Re-create
curl -H "Authorization: Bearer $SHARED_SECRET" "$LIVE_URL/.netlify/functions/strava-subscribe?action=create&callback=$LIVE_URL/.netlify/functions/strava-webhook"
```
