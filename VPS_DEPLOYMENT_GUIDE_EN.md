# MWU Validation Console - VPS Deployment

This guide deploys the current Node/Praat validation application. It replaces
the earlier LDT/Supabase deployment notes.

## 1. Recommended baseline

- Ubuntu 22.04 or 24.04 LTS
- 2-4 vCPU
- 4-8 GB RAM
- 80+ GB encrypted SSD
- Node.js 20 LTS
- Praat available as a command-line executable
- Nginx in front of the Node service

The application processes research audio and is not designed as a stateless
high-concurrency SaaS service. Storage capacity and processing time matter more
than request throughput.

## 2. Install dependencies

```bash
sudo apt update
sudo apt install -y git nginx praat ffmpeg

curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

node --version
npm --version
praat --version
```

If the distribution installs Praat elsewhere, locate it with
`command -v praat` and use that path for `PRAAT_BIN`.

## 3. Install the application

```bash
sudo mkdir -p /opt/mwu
sudo chown "$USER":"$USER" /opt/mwu
git clone https://github.com/hugowell18/MWU.git /opt/mwu/app
cd /opt/mwu/app

npm ci
npm run sprint:build-ui
```

Create the local environment file. It is ignored by Git:

```bash
cat >/opt/mwu/app/.env <<'EOF'
PRAAT_BIN=/usr/bin/praat
# Add provider keys only when their modules are intentionally enabled.
# ASSEMBLYAI_API_KEY=
# PYANNOTE_API_KEY=
EOF

chmod 600 /opt/mwu/app/.env
```

Do not place credentials in source files, shell history, committed reports, or
client-facing packages.

## 4. Prepare private data storage

The GitHub repository is public. Transfer client research files directly to the
VPS over SSH/SFTP and keep them outside public web roots.

```bash
sudo mkdir -p /var/lib/mwu/private /var/lib/mwu/outputs
sudo chown -R "$USER":"$USER" /var/lib/mwu
chmod 700 /var/lib/mwu/private /var/lib/mwu/outputs
```

Never commit active human-subject audio, muted-mirror WAVs, transcripts,
TextGrids, provider responses, or derived research reports to GitHub.

## 5. Run with systemd

Create `/etc/systemd/system/mwu-validation.service`:

```ini
[Unit]
Description=MWU Validation Console
After=network.target

[Service]
Type=simple
User=mwu
Group=mwu
WorkingDirectory=/opt/mwu/app
EnvironmentFile=/opt/mwu/app/.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/npm run sprint:serve -- --port 4173
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Create the service account and grant ownership before starting:

```bash
sudo useradd --system --home /opt/mwu --shell /usr/sbin/nologin mwu || true
sudo chown -R mwu:mwu /opt/mwu/app /var/lib/mwu
sudo systemctl daemon-reload
sudo systemctl enable --now mwu-validation
sudo systemctl status mwu-validation
```

## 6. Nginx reverse proxy

Create `/etc/nginx/sites-available/mwu-validation`:

```nginx
server {
    listen 80;
    server_name mwu.example.com;

    client_max_body_size 1g;

    # Use Basic Auth, an IP allowlist, VPN, or an institutional access layer.
    # Do not expose confidential research uploads anonymously.

    location / {
        proxy_pass http://127.0.0.1:4173;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 900s;
        proxy_send_timeout 900s;
        proxy_request_buffering off;
    }
}
```

Enable it:

```bash
sudo ln -sfn /etc/nginx/sites-available/mwu-validation /etc/nginx/sites-enabled/mwu-validation
sudo nginx -t
sudo systemctl reload nginx
```

Add HTTPS before sharing the URL:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d mwu.example.com
```

## 7. Verification

```bash
cd /opt/mwu/app
npm run sprint:test
npm run phase1:pyannote:test
npm run l1b:test
curl -I http://127.0.0.1:4173/
```

Confirm manually that:

- The Validation Sprint page loads.
- The SpeakerX benchmark can run.
- Praat is reported as available.
- L1a inputs can feed L1b.
- L1b creates the configured threshold TextGrids and downloadable package.
- No confidential files are accessible outside the authenticated application.

## 8. Updating

```bash
cd /opt/mwu/app
git pull --ff-only
npm ci
npm run sprint:build-ui
sudo systemctl restart mwu-validation
```

Back up private inputs and outputs separately. Git deployment does not include
or restore research data.
