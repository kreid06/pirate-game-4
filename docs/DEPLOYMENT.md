# Deployment & Server Operations

---

## Ports

| Port | Protocol | Purpose | Access |
|------|----------|---------|--------|
| 8082 | TCP (WebSocket) | Game clients | Public |
| 8081 | TCP (HTTP) | Admin panel | Restricted |
| 8080 | UDP | Future native clients | Public (not yet active) |

---

## Firewall Setup

### UFW (Ubuntu/Debian)
```bash
sudo ufw allow 8082/tcp comment 'Pirate Game WebSocket'
sudo ufw allow 8081/tcp comment 'Pirate Game Admin'
sudo ufw allow 8080/udp comment 'Pirate Game UDP (future)'
sudo ufw status numbered
```

### Restrict admin panel to your IP (recommended)
```bash
sudo ufw delete allow 8081/tcp
sudo ufw allow from YOUR_IP to any port 8081 comment 'Admin Panel (restricted)'
```

### Cloud Providers

**AWS Security Group (inbound):**
```
TCP 8082  0.0.0.0/0        Game WebSocket
TCP 8081  YOUR_IP/32       Admin (restricted)
UDP 8080  0.0.0.0/0        Future UDP
```

**DigitalOcean:** Networking → Firewalls → add same rules above.

**GCP:**
```bash
gcloud compute firewall-rules create pirate-ws    --allow tcp:8082
gcloud compute firewall-rules create pirate-admin --allow tcp:8081 --source-ranges YOUR_IP/32
gcloud compute firewall-rules create pirate-udp   --allow udp:8080
```

**Azure:**
```bash
az network nsg rule create --nsg-name myNSG --name pirate-ws    --priority 100 --destination-port-ranges 8082 --protocol Tcp
az network nsg rule create --nsg-name myNSG --name pirate-admin --priority 101 --destination-port-ranges 8081 --protocol Tcp --source-address-prefixes YOUR_IP
az network nsg rule create --nsg-name myNSG --name pirate-udp   --priority 102 --destination-port-ranges 8080 --protocol Udp
```

---

## Client `.env` Configuration

```env
# Development (plain WebSocket)
VITE_WS_PROTOCOL=ws
VITE_WS_HOST=your-server-ip
VITE_WS_PORT=8082

# Production (WSS behind nginx)
VITE_WS_PROTOCOL=wss
VITE_WS_HOST=game.yourdomain.com
VITE_WS_PORT=443
```

---

## Production: nginx SSL Reverse Proxy

For WSS (secure WebSocket) set up nginx in front of the server:

```nginx
# /etc/nginx/sites-available/pirate-game

# Game WebSocket → wss://game.yourdomain.com
server {
    listen 443 ssl;
    server_name game.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://localhost:8082;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}

# Admin panel → https://admin.yourdomain.com (restricted)
server {
    listen 443 ssl;
    server_name admin.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

    allow YOUR_IP;
    deny all;

    location / {
        proxy_pass http://localhost:8081;
        proxy_set_header Host $host;
    }
}
```

See [SSL_SETUP.md](SSL_SETUP.md) for full Let's Encrypt setup.

---

## Admin Panel (port 8081)

Built-in web dashboard at `http://localhost:8081` (or your server IP).

### REST API

| Endpoint | Returns |
|----------|---------|
| `GET /` | Interactive HTML dashboard |
| `GET /api/status` | Uptime, tick rate, player count |
| `GET /api/physics` | Ship/player/projectile counts, physics timing |
| `GET /api/entities` | Full entity list with positions and velocities |
| `GET /api/network` | Packets sent/received, RTT, bandwidth |
| `GET /api/performance` | Tick time µs, CPU/memory, TPS |

**Example:**
```bash
curl http://localhost:8081/api/status | jq
curl http://localhost:8081/api/entities | jq
```

### Performance overhead
- Non-blocking I/O — no impact on 30Hz game loop
- Updates throttled to every 5th tick (~6 Hz)
- <0.1% CPU impact measured

### Security
⚠️ No authentication — localhost / trusted network only. Do not expose publicly without nginx `allow`/`deny`.

**Admin server compile-time config** (`include/admin/admin_server.h`):
```c
#define ADMIN_DEFAULT_PORT  8081
#define ADMIN_MAX_CLIENTS   5
#define ADMIN_BUFFER_SIZE   4096
```

---

## Running as a systemd Service

```ini
# /etc/systemd/system/pirate-server.service
[Unit]
Description=Pirate Game Server
After=network.target

[Service]
ExecStart=/home/debian/pirate-game-4/server/bin/pirate-server
WorkingDirectory=/home/debian/pirate-game-4/server
Restart=on-failure
User=debian

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable pirate-server
sudo systemctl start pirate-server
sudo journalctl -u pirate-server -f
```

---

## Diagnostics

```bash
# Verify ports are listening
sudo netstat -tulpn | grep pirate-server

# Check ports are reachable
curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" http://localhost:8082
curl http://localhost:8081

# Port conflicts
sudo lsof -i :8082
sudo lsof -i :8081

# Server logs
sudo journalctl -u pirate-server -n 100
```
