# FWC - Free World Coin - APPROVED BUILD

## Files (19 + 2)
- package.json, wrangler.toml, schema.sql, .gitignore
- public/logo.png, public/tonconnect-manifest.json
- src/*.js (12 files) + src/html/user.html + src/html/admin.html

## Deploy
1. Upload ALL files to GitHub, same structure, one commit.
2. Cloudflare Workers > Deploy (or `wrangler deploy`).
3. Cloudflare Dashboard > Settings > Variables - set:
   BOT_TOKEN, ADMIN_SECRET, TON_MNEMONIC_TREASURY, ADSGRAM_BLOCK_ID, TONCENTER_API_KEY
4. D1: `wrangler d1 execute fwc-db --file=schema.sql --remote`
5. Check: /api/health -> bot ok, /api/admin/health -> secrets status
6. Telegram webhook: set to https://<worker>/webhook

## Notes
- Bot handles /start only - mining/tasks/wallet are in the Mini App.
- Founder verify: /api/founder/verify checks TonCenter for burn tx.
- Hold check: 2nd+ withdrawal requires on-chain FWC >= withdraw_hold_amount (default 1000).
- Payouts are MANUAL - no private key in Worker.
