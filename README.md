# FWC CLEAN v1 - Step 1
Worker fwc @ https://fwc.ahmed73.workers.dev

## Deploy
1. Set D1 database_id in wrangler.toml
2. Set secrets in Cloudflare > Workers > fwc > Settings > Variables > Production: BOT_TOKEN, ADMIN_SECRET, TONCENTER_API_KEY
3. wrangler deploy

## Test
- /api/health -> bot ok:true
- /api/debug-secrets -> hasBOT_TOKEN true, hasADMIN_SECRET true
- /aha.htm -> login with ADMIN_SECRET, works from browser
