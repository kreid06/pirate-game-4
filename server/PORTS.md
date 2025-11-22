# Server Ports Configuration

The Pirate Game server uses multiple ports for different purposes:

## Port Overview

| Port | Protocol | Purpose | Status |
|------|----------|---------|--------|
| 8082 | TCP (WebSocket) | Main game traffic | ✅ Active |
| 8081 | TCP (HTTP) | Admin panel | ✅ Active |
| 8080 | UDP | High-performance game traffic | 🚧 Future |

## Port Details

### 8082 - WebSocket (Primary Game Traffic)

**Purpose:** Main client-server communication

**Protocol:** WebSocket over TCP

**Traffic:**
- Player input (movement, rotation, actions)
- Game state updates (60 Hz snapshots)
- Player connection/disconnection
- Game events

**Client Connection:**
```typescript
ws://your-server-ip:8082
// or secure:
wss://your-domain.com:8082
```

**Firewall Rule:**
```bash
sudo ufw allow 8082/tcp comment 'Pirate Game WebSocket'
```

### 8081 - Admin Panel

**Purpose:** Server administration and monitoring

**Protocol:** HTTP/WebSocket

**Features:**
- Server statistics
- Connected players list
- Server commands
- Performance metrics
- Real-time logs

**Access:**
```
http://your-server-ip:8081
```

**Firewall Rule:**
```bash
sudo ufw allow 8081/tcp comment 'Pirate Game Admin Panel'
```

**Security Note:** Consider restricting this port to specific IPs in production:
```bash
# Only allow from your IP
sudo ufw delete allow 8081/tcp
sudo ufw allow from YOUR_IP to any port 8081 comment 'Admin Panel (restricted)'
```

### 8080 - UDP (Future Feature)

**Purpose:** Low-latency game traffic

**Protocol:** UDP

**Planned Features:**
- Player movement (unreliable, fast)
- Projectile updates
- Reduced bandwidth vs WebSocket
- Packet loss tolerance

**Status:** 🚧 Planned for future implementation

**Firewall Rule:**
```bash
sudo ufw allow 8080/udp comment 'Pirate Game UDP Traffic'
```

## Server Configuration

### Config File: `server/config/server.conf`

```conf
# WebSocket port (main game traffic)
ws_port=8082

# Admin panel port
admin_port=8081

# UDP port (future feature)
udp_port=8080

# Server settings
max_players=100
tick_rate=60
log_level=info
```

### Systemd Service

The server automatically binds to all configured ports on startup.

Check which ports are listening:
```bash
# Check all server ports
sudo netstat -tulpn | grep pirate-server

# Should show:
# tcp  ... :8082 ... LISTEN ... pirate-server
# tcp  ... :8081 ... LISTEN ... pirate-server
# udp  ... :8080 ... LISTEN ... pirate-server (future)
```

## Firewall Setup

### UFW (Ubuntu/Debian)

```bash
# Allow all game server ports
sudo ufw allow 8082/tcp comment 'Game WebSocket'
sudo ufw allow 8081/tcp comment 'Admin Panel'
sudo ufw allow 8080/udp comment 'UDP Traffic (future)'

# Verify
sudo ufw status numbered
```

### Firewalld (CentOS/RHEL)

```bash
sudo firewall-cmd --permanent --add-port=8082/tcp
sudo firewall-cmd --permanent --add-port=8081/tcp
sudo firewall-cmd --permanent --add-port=8080/udp
sudo firewall-cmd --reload
```

### Cloud Provider Firewalls

**AWS Security Group:**
- Inbound: TCP 8082 from 0.0.0.0/0
- Inbound: TCP 8081 from YOUR_IP/32 (restricted)
- Inbound: UDP 8080 from 0.0.0.0/0 (future)

**DigitalOcean Firewall:**
- Add inbound rules for ports 8080-8082
- Restrict 8081 to trusted IPs

**Google Cloud Firewall:**
```bash
gcloud compute firewall-rules create pirate-game-ws \
  --allow tcp:8082 \
  --description "Pirate Game WebSocket"

gcloud compute firewall-rules create pirate-game-admin \
  --allow tcp:8081 \
  --source-ranges YOUR_IP/32 \
  --description "Pirate Game Admin Panel"

gcloud compute firewall-rules create pirate-game-udp \
  --allow udp:8080 \
  --description "Pirate Game UDP (future)"
```

## Client Configuration

### Environment Variables (`.env`)

```env
# WebSocket connection
VITE_WS_PROTOCOL=ws
VITE_WS_HOST=your-server-ip
VITE_WS_PORT=8082

# Admin panel access
VITE_ADMIN_HOST=your-server-ip
VITE_ADMIN_PORT=8081

# UDP (future)
VITE_UDP_HOST=your-server-ip
VITE_UDP_PORT=8080
```

### Production (Secure)

```env
VITE_WS_PROTOCOL=wss
VITE_WS_HOST=game.yourdomain.com
VITE_WS_PORT=443

VITE_ADMIN_HOST=admin.yourdomain.com
VITE_ADMIN_PORT=443
```

## Nginx Reverse Proxy (Production)

For production, proxy all ports through Nginx with SSL:

```nginx
# WebSocket (port 8082 → 443)
server {
    listen 443 ssl;
    server_name game.yourdomain.com;
    
    ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;
    
    location / {
        proxy_pass http://localhost:8082;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}

# Admin panel (port 8081 → 443)
server {
    listen 443 ssl;
    server_name admin.yourdomain.com;
    
    ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;
    
    # Restrict to your IP
    allow YOUR_IP;
    deny all;
    
    location / {
        proxy_pass http://localhost:8081;
        proxy_set_header Host $host;
    }
}
```

## Testing Ports

### WebSocket (8082)

```bash
# Test WebSocket connection
curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" \
  http://your-server-ip:8082
```

### Admin Panel (8081)

```bash
# Test admin panel
curl http://your-server-ip:8081

# Or open in browser
xdg-open http://your-server-ip:8081
```

### UDP (8080 - Future)

```bash
# Test UDP port is open
nc -u -v your-server-ip 8080
```

## Troubleshooting

### Port Already in Use

```bash
# Find what's using a port
sudo lsof -i :8082
sudo lsof -i :8081
sudo lsof -i :8080

# Kill process
sudo killall pirate-server
sudo systemctl restart pirate-server
```

### Firewall Blocking

```bash
# Check UFW status
sudo ufw status verbose

# Check if port is reachable externally
# (run from different machine)
telnet your-server-ip 8082
telnet your-server-ip 8081
```

### Server Not Listening

```bash
# Check what ports server is listening on
sudo netstat -tulpn | grep pirate

# Check server logs
sudo journalctl -u pirate-server -n 100 | grep -i port
```

## Port Summary for Deployment

When deploying, ensure:

- ✅ Port 8082 is open (WebSocket - **critical**)
- ✅ Port 8081 is open (Admin panel - **optional but recommended**)
- ⏳ Port 8080 is open (UDP - **not yet used**)
- ✅ Firewall rules configured
- ✅ Cloud provider security groups updated
- ✅ Client `.env` points to correct ports
- ✅ SSL/TLS configured for production (ports 443)
