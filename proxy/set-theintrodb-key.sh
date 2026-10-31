#!/bin/sh
# Stores TheIntroDB's API key (https://theintrodb.org/account, "Generate API Key") as the worker's secret
# THEINTRODB_API_KEY: /segments then asks with it, 100,000 requests a day for the account instead of the anonymous
# per-IP budget Cloudflare's shared addresses run out of (429). The key is asked without echo and never printed; it
# is stored only when TheIntroDB counts it as an account's (a wrong key is served as anonymous, 5000 a day).
set -eu
cd "$(dirname "$0")"
printf 'TheIntroDB API key: '
trap 'stty echo 2>/dev/null || true' EXIT INT TERM
stty -echo 2>/dev/null || true # not a terminal: a key piped in
read -r KEY
stty echo 2>/dev/null || true
echo
limit=$(printf 'Authorization: Bearer %s\n' "$KEY" | curl -s -o /dev/null -D - -H @- -A lampa-intros/1 \
  'https://api.theintrodb.org/v4/media?tmdb_id=93740&season=1&episode=9' | tr -d '\r' |
  awk -F': ' 'tolower($1) == "x-usagelimit-limit" { print $2 }')
if [ "${limit:-0}" -le 5000 ]; then
  echo "TheIntroDB doesn't count this key as an account's (daily limit ${limit:-unknown}): not stored"
  exit 1
fi
echo "Key accepted (daily limit $limit), storing it in the worker"
N=~/.nvm/versions/node/v24.16.0/bin # a plain npx hits the broken nvm shim
printf %s "$KEY" | PATH="$N:$PATH" "$N/npx" wrangler@4 secret put THEINTRODB_API_KEY
