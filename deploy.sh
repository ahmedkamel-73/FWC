
#!/bin/bash
# FWC CLEAN v1 - deploy
set -e
echo "Deploying FWC to Worker fwc..."
npx wrangler deploy
echo "Done. Test:"
echo "  https://fwc.ahmed73.workers.dev/api/health"
echo "  https://fwc.ahmed73.workers.dev/api/debug-secrets"
echo "Set webhook:"
echo "  https://api.telegram.org/bot$BOT_TOKEN/setWebhook?url=https://fwc.ahmed73.workers.dev/webhook"
