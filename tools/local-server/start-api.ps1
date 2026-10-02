# MediFlow API on a local Windows server.
#
# Fill the three secrets + the LAN IP once, then register in Task Scheduler
# (trigger: At startup, "run whether user is logged on or not") and forget it:
# reboots recover alone. Logs: Task Scheduler history, or run manually to watch.
#
# Layout assumed (adjust if you cloned elsewhere):
#   C:\mediflow              <- git clone of the repo (this file lives at tools\local-server\)
#   C:\mediflow\data         <- SQLite database (real disk: survives reboots)
#   C:\mediflow\uploads      <- patient files
#   C:\mediflow\backups      <- db:backup output
#
# The gateway runs on the same machine (start-gateway.ps1); the API reaches it
# over localhost, so no tunnel and no firewall rule exist anywhere.

$env:NODE_ENV = "production"
$env:HOST = "0.0.0.0"
$env:PORT = "4000"

# Generate fresh values (run twice) and paste them here. Never reuse the ones
# that appeared in chat screenshots.
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
$env:JWT_SECRET = "<PUT-NEW-64-HEX-HERE>"
$env:ENCRYPTION_KEY = "<PUT-NEW-64-HEX-HERE>"

$env:DATABASE_FILE = "C:\mediflow\data\mediflow.db"
$env:UPLOADS_DIR = "C:\mediflow\uploads"
$env:BACKUP_DIR = "C:\mediflow\backups"

# The LAN address staff browsers use, e.g. http://192.168.1.50:8080
$env:CORS_ORIGINS = "http://<SERVER-LAN-IP>:8080"
$env:PUBLIC_WEB_URL = "http://<SERVER-LAN-IP>:8080"

$env:WHATSAPP_PROVIDER = "cloud"
# The worker sends via Meta Cloud API (credentials you do not have); the
# Baileys gateway delivers instead, so the worker stays off. Turning it on
# without WHATSAPP_CLOUD_TOKEN crashes the boot on purpose.
$env:REMINDER_WORKER_ENABLED = "false"
$env:DEFAULT_TIMEZONE = "Asia/Beirut"

$env:GATEWAY_URL = "http://localhost:10000"
$env:GATEWAY_ADMIN_TOKEN = "<SAME-TOKEN-AS-START-GATEWAY>"

# No SMTP yet: forgot-password answers 503 honestly until configured.

node C:\mediflow\apps\api\dist\index.js
