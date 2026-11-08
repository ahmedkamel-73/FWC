#!/bin/bash
# deploy.sh - FWC Full Deploy Script
set -e

echo "🚀 FWC Deployment Script"
echo "========================"

# Check wrangler
if ! command -v wrangler &> /dev/null; then
  echo "❌ wrangler not found. Install: npm install -g wrangler"
  exit 1
fi

# Check login
if ! wrangler whoami &> /dev/null; then
  echo "🔐 Please login first: wrangler login"
  exit 1
fi

# Install deps
echo "📦 Installing dependencies..."
npm install

# Check if D1 database exists
DB_ID=$(grep 'database_id' wrangler.toml | head -1 | cut -d'"' -f2)
if [ "$DB_ID" = "REPLACE_WITH_YOUR_D1_ID" ]; then
  echo ""
  echo "⚠️  D1 database not configured!"
  echo ""
  echo "Run this first:"
  echo "  wrangler d1 create fwc-db"
  echo ""
  echo "Then copy the database_id into wrangler.toml"
  exit 1
fi

# Apply schema
echo "📋 Applying database schema..."
wrangler d1 execute fwc-db --file=schema.sql --remote

# Check secrets
echo "🔑 Checking secrets..."
REQUIRED_SECRETS=("BOT_TOKEN" "ADMIN_SECRET" "TON_MNEMONIC_TREASURY" "ADSGRAM_BLOCK_ID")
for SECRET in "${REQUIRED_SECRETS[@]}"; do
  if ! wrangler secret list 2>/dev/null | grep -q "$SECRET"; then
    echo "❌ Missing secret: $SECRET"
    echo "   Run: wrangler secret put $SECRET"
    exit 1
  fi
done

# Deploy
echo "🚀 Deploying to Cloudflare..."
wrangler deploy

echo ""
echo "✅ Deployment complete!"
echo ""
echo "📍 URLs:"
echo "   User app:    https://fwc.ahmed73.workers.dev/"
echo "   Admin panel: https://fwc.ahmed73.workers.dev/admin"
echo "   Health:      https://fwc.ahmed73.workers.dev/api/health"
echo ""
echo "🔗 Set webhook:"
echo "   curl -X POST \"https://api.telegram.org/bot\$BOT_TOKEN/setWebhook\" \\"
echo "     -d \"url=https://fwc.ahmed73.workers.dev/webhook\""