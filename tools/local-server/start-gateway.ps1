# MediFlow Baileys gateway on a local Windows server.
#
# Same deal as start-api.ps1: fill the values once, Task Scheduler at startup,
# forget it. Every connection this process makes is outbound (WhatsApp
# servers, Firestore, and polling the API below), so no tunnel, no port
# forwarding, no inbound firewall rule.
#
# Session lives in gateway-sessions\<clinicId> on real disk: pair once with
# the code this script prints, and reboots reconnect alone. Suspend the Render
# gateway BEFORE pairing here - two sessions on one number fight and WhatsApp
# drops one of them.

$env:PORT = "10000"

# Copy these three from the Render gateway service's Environment tab.
$env:GATEWAY_CLINIC_ID = "<FROM-RENDER>"
$env:GATEWAY_PROJECT_ID = "<FROM-RENDER>"
$env:GATEWAY_PHONE_NUMBER = "<CLINIC-NUMBER-WITH-COUNTRY-CODE>"

$env:GATEWAY_ADMIN_TOKEN = "<SAME-TOKEN-AS-START-API>"
$env:GATEWAY_SESSION_DIR = "C:\mediflow\gateway-sessions"
# Service-account key for the Firebase project (Admin SDK). Copy the JSON to
# this path, or point at wherever you keep it.
$env:GOOGLE_APPLICATION_CREDENTIALS = "C:\mediflow\secrets\firebase-key.json"

# Where the API lives from this machine's point of view. The gateway polls
# this for due outbox rows and forwards inbound patient texts here.
$env:MEDIFLOW_API_URL = "http://localhost:4000"
$env:GATEWAY_API_POLL_MS = "15000"

node C:\mediflow\apps\baileys-gateway\dist\index.js
