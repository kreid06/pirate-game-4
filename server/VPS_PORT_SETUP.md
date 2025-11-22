# VPS Setup - Complete Port Configuration

## Quick Setup Commands

### Step 1: Configure Firewall (All Ports)

```bash
# SSH to your VPS
ssh your-username@your-vps-ip

# Run the port configuration script
wget https://raw.githubusercontent.com/kreid06/pirate-game-4/main/server/configure-ports.sh
chmod +x configure-ports.sh
./configure-ports.sh
```

Or manually:

```bash
# Allow all game server ports
sudo ufw allow 8082/tcp comment 'Game WebSocket'
sudo ufw allow 8081/tcp comment 'Admin Panel'
sudo ufw allow 8080/udp comment 'UDP Traffic (future)'

# Verify ports are open
sudo ufw status numbered
```

### Step 2: Verify Ports After Deployment

```bash
# Check server is listening on all ports
sudo netstat -tulpn | grep pirate-server

# Expected output:
# tcp ... :8082 ... LISTEN ... pirate-server  ← WebSocket
# tcp ... :8081 ... LISTEN ... pirate-server  ← Admin panel
# (udp :8080 will appear when UDP feature is implemented)
```

### Step 3: Test Each Port

**Test WebSocket (8082):**
```bash
# From your local machine
curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" \
  http://your-vps-ip:8082

# Should get WebSocket handshake response
```

**Test Admin Panel (8081):**
```bash
# Open in browser
http://your-vps-ip:8081

# Or use curl
curl http://your-vps-ip:8081
```

**Test UDP (8080) - Future:**
```bash
# Install netcat if needed
sudo apt-get install netcat

# Test UDP port
nc -u -v your-vps-ip 8080
```

## Cloud Provider Configurations

### DigitalOcean

1. Go to: Networking → Firewalls
2. Create new firewall rule:
   - **Inbound Rules:**
     - Custom: TCP, 8082, All IPv4/IPv6 (WebSocket)
     - Custom: TCP, 8081, Your IP only (Admin Panel)
     - Custom: UDP, 8080, All IPv4/IPv6 (Future UDP)

### AWS EC2

Edit Security Group:

```
Inbound Rules:
- Type: Custom TCP, Port: 8082, Source: 0.0.0.0/0  (WebSocket)
- Type: Custom TCP, Port: 8081, Source: YOUR_IP/32  (Admin - Restricted)
- Type: Custom UDP, Port: 8080, Source: 0.0.0.0/0  (Future UDP)
```

### Google Cloud Platform

```bash
# WebSocket
gcloud compute firewall-rules create pirate-ws \
  --allow tcp:8082 \
  --description "Pirate Game WebSocket"

# Admin Panel (restricted to your IP)
gcloud compute firewall-rules create pirate-admin \
  --allow tcp:8081 \
  --source-ranges YOUR_IP/32 \
  --description "Pirate Game Admin Panel"

# UDP (future)
gcloud compute firewall-rules create pirate-udp \
  --allow udp:8080 \
  --description "Pirate Game UDP"
```

### Azure

```bash
# Create network security group rules
az network nsg rule create --resource-group myResourceGroup \
  --nsg-name myNSG --name pirate-ws --priority 100 \
  --destination-port-ranges 8082 --protocol Tcp

az network nsg rule create --resource-group myResourceGroup \
  --nsg-name myNSG --name pirate-admin --priority 101 \
  --destination-port-ranges 8081 --protocol Tcp \
  --source-address-prefixes YOUR_IP

az network nsg rule create --resource-group myResourceGroup \
  --nsg-name myNSG --name pirate-udp --priority 102 \
  --destination-port-ranges 8080 --protocol Udp
```

## Client Configuration

Update your `.env` to connect to the correct ports:

```env
# WebSocket connection (port 8082)
VITE_WS_PROTOCOL=ws
VITE_WS_HOST=your-vps-ip
VITE_WS_PORT=8082

# Admin panel access (port 8081) - optional
VITE_ADMIN_HOST=your-vps-ip
VITE_ADMIN_PORT=8081

# UDP connection (port 8080) - future
VITE_UDP_HOST=your-vps-ip
VITE_UDP_PORT=8080
```

## Security Recommendations

### Restrict Admin Panel (Port 8081)

Only allow access from your IP:

```bash
# Remove unrestricted rule
sudo ufw delete allow 8081/tcp

# Add restricted rule
sudo ufw allow from YOUR_IP to any port 8081 comment 'Admin Panel (restricted)'
```

### Production: Use SSL/TLS

For production, use Nginx reverse proxy with SSL:

```nginx
# /etc/nginx/sites-available/pirate-game

# WebSocket - wss://game.yourdomain.com
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
    }
}

# Admin Panel - https://admin.yourdomain.com
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
    }
}
```

Then update client `.env`:

```env
VITE_WS_PROTOCOL=wss
VITE_WS_HOST=game.yourdomain.com
VITE_WS_PORT=443
```

## Troubleshooting

### Port Not Accessible

```bash
# 1. Check firewall
sudo ufw status verbose

# 2. Check server is listening
sudo netstat -tulpn | grep -E '808[0-2]'

# 3. Check cloud firewall/security groups
# (varies by provider)

# 4. Test from server itself
curl http://localhost:8082
curl http://localhost:8081
nc -u -v localhost 8080

# 5. Test from external
# (from different machine)
telnet your-vps-ip 8082
telnet your-vps-ip 8081
```

### Connection Refused

```bash
# Check if server is running
sudo systemctl status pirate-server

# Check server logs for port binding errors
sudo journalctl -u pirate-server -n 50 | grep -i port

# Restart server
sudo systemctl restart pirate-server
```

## Quick Reference

| Port | Purpose | Protocol | Access | Production |
|------|---------|----------|--------|------------|
| 8082 | Game WebSocket | TCP | Public | wss://game.domain.com:443 |
| 8081 | Admin Panel | TCP | Restricted | https://admin.domain.com:443 |
| 8080 | UDP Traffic | UDP | Public | N/A (future) |

**Essential:** Port 8082 must be open for game to work  
**Optional:** Port 8081 for server administration  
**Future:** Port 8080 for UDP optimization
