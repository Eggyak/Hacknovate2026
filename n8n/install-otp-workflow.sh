#!/usr/bin/env bash
#
# Install the MHA Samadhan OTP workflow into the existing n8n instance.
#
# This CLONES the delivery pattern already running on this box; it does not
# touch Agri_Login_Code or any other workflow. The clone has its own id, its
# own name and its own webhook path, and only shares the Twilio credential,
# which it references by id and never modifies.
#
# The API key is substituted from the stack's .env at install time so it never
# enters git. Re-running this is safe: it overwrites its own workflow only.
#
# Usage, on the VPS:
#   bash /opt/stacks/mha-samadhan/n8n/install-otp-workflow.sh

set -euo pipefail

STACK=/opt/stacks/mha-samadhan
CONTAINER=n8n-kmar-n8n-1
WF_ID=MHASamadhanOTP1
SRC="$STACK/n8n/MHA_Samadhan_OTP.json"

[ -f "$SRC" ] || { echo "missing $SRC"; exit 1; }

# Reuse the key already in .env if there is one, otherwise mint one and
# record it, so the portal and the workflow cannot drift apart.
KEY=$(grep -E '^N8N_OTP_API_KEY=' "$STACK/.env" | cut -d= -f2- || true)
if [ -z "$KEY" ]; then
  KEY=$(openssl rand -base64 32 | tr -d '/+=' | cut -c1-40)
  echo "minted a new OTP API key"
fi

TS=$(date +%s)
TMP=/root/mha_otp_$TS.json
python3 - "$SRC" "$TMP" "$KEY" <<'PY'
import json, sys
src, dst, key = sys.argv[1], sys.argv[2], sys.argv[3]
wf = json.load(open(src, encoding='utf8'))
for node in wf['nodes']:
    code = node.get('parameters', {}).get('jsCode')
    if code and '__OTP_API_KEY__' in code:
        node['parameters']['jsCode'] = code.replace('__OTP_API_KEY__', key)
json.dump([wf], open(dst, 'w', encoding='utf8'), ensure_ascii=False)
print(f"prepared {wf['name']} ({wf['id']}) with {len(wf['nodes'])} nodes")
PY

# A stale file at the destination is the classic way to import yesterday's
# workflow, so clear it first and copy to a timestamped name.
docker exec -u 0 "$CONTAINER" rm -f "/tmp/mha_otp_$TS.json" 2>/dev/null || true
docker cp "$TMP" "$CONTAINER:/tmp/mha_otp_$TS.json"
docker exec "$CONTAINER" n8n import:workflow --input="/tmp/mha_otp_$TS.json"

# import:workflow deactivates what it imports, so this has to follow it or the
# webhook silently 404s.
docker exec "$CONTAINER" n8n update:workflow --id="$WF_ID" --active=true

# Remove the plaintext key from both filesystems.
docker exec -u 0 "$CONTAINER" rm -f "/tmp/mha_otp_$TS.json" 2>/dev/null || true
shred -u "$TMP" 2>/dev/null || rm -f "$TMP"

# Point the portal at the webhook and give it the matching key.
WEBHOOK="http://n8n-kmar-n8n-1:5678/webhook/mha/otp"
python3 - "$STACK/.env" "$WEBHOOK" "$KEY" <<'PY'
import sys
path, url, key = sys.argv[1], sys.argv[2], sys.argv[3]
lines = open(path, encoding='utf8').read().splitlines()
out, seen = [], set()
for line in lines:
    if line.startswith('N8N_OTP_WEBHOOK_URL='):
        out.append(f'N8N_OTP_WEBHOOK_URL={url}'); seen.add('url')
    elif line.startswith('N8N_OTP_API_KEY='):
        out.append(f'N8N_OTP_API_KEY={key}'); seen.add('key')
    else:
        out.append(line)
if 'url' not in seen: out.append(f'N8N_OTP_WEBHOOK_URL={url}')
if 'key' not in seen: out.append(f'N8N_OTP_API_KEY={key}')
open(path, 'w', encoding='utf8').write('\n'.join(out) + '\n')
print('.env updated')
PY

# n8n only registers a production webhook on restart.
docker restart "$CONTAINER" >/dev/null
echo "restarted n8n"

cd "$STACK" && docker compose up -d mha-api >/dev/null
echo "done - the portal now sends OTPs through n8n"
