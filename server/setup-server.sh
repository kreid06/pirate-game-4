#!/bin/bash
# One-time setup script for game server + auth server
# Run this on your VPS/server

set -e

echo "🚀 Setting up Pirate Game Server..."

# 1. Create directories
echo "📁 Creating directories..."
sudo mkdir -p /opt/pirate-game/bin
sudo mkdir -p /opt/pirate-game/config
sudo mkdir -p /opt/pirate-game/logs
sudo mkdir -p /opt/pirate-game/auth
sudo chown -R $USER:$USER /opt/pirate-game

# 2. Install dependencies
echo "📦 Installing dependencies..."
sudo apt-get update
sudo apt-get install -y libssl3 libjson-c5 nginx certbot python3-certbot-nginx

# Install Node.js (for auth server) if not present
if ! command -v node &> /dev/null; then
    echo "Installing Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi
echo "Node.js version: $(node --version)"

# 3. Create config files
echo "⚙️ Creating config files..."
cat > /opt/pirate-game/config/server.conf << 'EOF'
port=8082
max_players=100
tick_rate=60
log_level=info
EOF

cat > /opt/pirate-game/config/auth.env << 'EOF'
AUTH_PORT=3001
# IMPORTANT: change this to a long random secret before deploying
JWT_SECRET=change-me-to-a-long-random-secret
# Comma-separated allowed origins, e.g.: https://yourdomain.com
CORS_ORIGINS=
EOF
echo "⚠️  Edit /opt/pirate-game/config/auth.env and set JWT_SECRET before starting!"

# 4. Create systemd service for the game server (C binary)
echo "🔧 Creating game server systemd service..."
sudo tee /etc/systemd/system/pirate-server.service > /dev/null << EOF
[Unit]
Description=Pirate Game Server
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=/opt/pirate-game
ExecStart=/opt/pirate-game/bin/pirate-server
Restart=always
RestartSec=10
StandardOutput=append:/opt/pirate-game/logs/server.log
StandardError=append:/opt/pirate-game/logs/error.log

[Install]
WantedBy=multi-user.target
EOF

# 5. Create systemd service for the auth server (Node.js)
echo "🔧 Creating auth server systemd service..."
sudo tee /etc/systemd/system/pirate-auth.service > /dev/null << EOF
[Unit]
Description=Pirate Auth Server
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=/opt/pirate-game/auth
EnvironmentFile=/opt/pirate-game/config/auth.env
ExecStart=$(which node) dist/index.js
Restart=always
RestartSec=10
StandardOutput=append:/opt/pirate-game/logs/auth.log
StandardError=append:/opt/pirate-game/logs/auth-error.log

[Install]
WantedBy=multi-user.target
EOF

# 6. Enable both services
echo "✅ Enabling services..."
sudo systemctl daemon-reload
sudo systemctl enable pirate-server
sudo systemctl enable pirate-auth

# 7. Configure firewall
echo "🔥 Configuring firewall..."

if command -v ufw &> /dev/null; then
    # UFW is installed
    echo "Using UFW firewall..."
    sudo ufw allow 22/tcp comment 'SSH'
    sudo ufw allow 80/tcp comment 'HTTP (nginx / Let'\''s Encrypt)'
    sudo ufw allow 443/tcp comment 'HTTPS (nginx)'
    sudo ufw allow 8082/tcp comment 'Pirate Game WebSocket'
    sudo ufw allow 8081/tcp comment 'Pirate Game Admin Panel'
    sudo ufw allow 8080/udp comment 'Pirate Game UDP Traffic (future)'
    # Auth server listens on loopback only — nginx proxies /auth/ to it
    echo "✅ UFW rules added (including SSH)"
else
    # UFW not installed - offer to install or use iptables
    echo "⚠️  UFW not found"
    read -p "Install UFW? (y/n): " install_ufw
    
    if [[ $install_ufw == "y" ]]; then
        echo "Installing UFW..."
        sudo apt-get update
        sudo apt-get install -y ufw
        
        # Configure UFW
        sudo ufw default deny incoming
        sudo ufw default allow outgoing
        
        # CRITICAL: Allow SSH FIRST to prevent lockout
        echo "⚠️  Adding SSH rule (port 22) to prevent lockout..."
        sudo ufw allow 22/tcp comment 'SSH'
        
        # Add game server ports
        sudo ufw allow 80/tcp comment 'HTTP (nginx / Let'\''s Encrypt)'
        sudo ufw allow 443/tcp comment 'HTTPS (nginx)'
        sudo ufw allow 8082/tcp comment 'Pirate Game WebSocket'
        sudo ufw allow 8081/tcp comment 'Pirate Game Admin Panel'
        sudo ufw allow 8080/udp comment 'Pirate Game UDP Traffic (future)'
        # Auth server proxied via nginx — no direct public port needed
        
        echo ""
        echo "⚠️  IMPORTANT: About to enable UFW firewall"
        echo "SSH (port 22) has been allowed to prevent lockout"
        echo "Current rules:"
        sudo ufw show added
        echo ""
        read -p "Enable UFW now? (y/n): " enable_ufw
        
        if [[ $enable_ufw == "y" ]]; then
            sudo ufw --force enable  # --force to skip confirmation
            echo "✅ UFW enabled with SSH access preserved"
        else
            echo "⚠️  UFW installed but not enabled. Enable it with: sudo ufw enable"
        fi
    else
        echo "Using iptables instead..."
        
        # CRITICAL: Allow SSH first
        echo "Adding SSH rule (port 22) to prevent lockout..."
        sudo iptables -A INPUT -p tcp --dport 22 -j ACCEPT -m comment --comment "SSH"
        
        # Allow established connections
        sudo iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
        
        # Allow loopback
        sudo iptables -A INPUT -i lo -j ACCEPT
        
        # Configure game server ports
        sudo iptables -A INPUT -p tcp --dport 80 -j ACCEPT -m comment --comment "HTTP (nginx)"
        sudo iptables -A INPUT -p tcp --dport 443 -j ACCEPT -m comment --comment "HTTPS (nginx)"
        sudo iptables -A INPUT -p tcp --dport 8082 -j ACCEPT -m comment --comment "Game WebSocket"
        sudo iptables -A INPUT -p tcp --dport 8081 -j ACCEPT -m comment --comment "Admin Panel"
        sudo iptables -A INPUT -p udp --dport 8080 -j ACCEPT -m comment --comment "UDP (future)"
        # Auth server proxied via nginx — no direct public port needed
        
        # Install iptables-persistent to save rules
        echo "Installing iptables-persistent to save rules..."
        sudo DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent
        sudo netfilter-persistent save
        echo "✅ iptables rules added and saved (including SSH)"
    fi
fi

echo ""
echo "✅ Setup complete!"
echo ""

# 8. Configure nginx reverse proxy
echo "🌐 Configuring nginx reverse proxy..."
read -p "Enter your domain name (or server IP if no domain, e.g. example.com): " SERVER_DOMAIN

sudo tee /etc/nginx/sites-available/pirate-game > /dev/null << NGINXEOF
server {
    listen 80;
    server_name ${SERVER_DOMAIN};

    # Proxy auth API to Node.js auth server (loopback)
    location /auth/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # WebSocket proxy for game server
    location /ws {
        proxy_pass http://127.0.0.1:8082;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_read_timeout 86400;
    }
}
NGINXEOF

sudo ln -sf /etc/nginx/sites-available/pirate-game /etc/nginx/sites-enabled/pirate-game
sudo nginx -t && sudo systemctl reload nginx

# Offer to set up SSL with certbot
if [[ "$SERVER_DOMAIN" =~ \. ]]; then
    echo ""
    read -p "Set up HTTPS with Let's Encrypt for ${SERVER_DOMAIN}? (y/n): " setup_ssl
    if [[ $setup_ssl == "y" ]]; then
        read -p "Enter your email for Let's Encrypt notifications: " LE_EMAIL
        sudo certbot --nginx -d "${SERVER_DOMAIN}" --non-interactive --agree-tos -m "${LE_EMAIL}"
        echo "✅ SSL configured — nginx now handles HTTPS"
    fi
else
    echo "⚠️  IP address detected (not a domain) — skipping Let's Encrypt (requires a domain name)"
fi

echo ""
echo "Firewall ports opened:"
echo "  - 22/tcp:   SSH"
echo "  - 80/tcp:   HTTP (nginx, redirect to HTTPS)"
echo "  - 443/tcp:  HTTPS (nginx — proxies /auth/ and /ws)"
echo "  - 8082/tcp: WebSocket (game traffic, direct)"
echo "  - 8081/tcp: Admin panel"
echo "  - 8080/udp: UDP traffic (future feature)"
echo "  - 3001/tcp: Auth server (loopback only — proxied via nginx)"
echo ""
echo "Next steps:"
echo "1. Edit /opt/pirate-game/config/auth.env — verify JWT_SECRET is set by CI"
echo "2. Make sure GitHub secrets are set: AUTH_JWT_SECRET, AUTH_CORS_ORIGINS"
echo "3. Update VITE_AUTH_URL in deploy-client.yml to use your domain (if not already)"
echo "4. Push code to main branch — GitHub Actions will deploy both servers"
echo "5. Start game server:  sudo systemctl start pirate-server"
echo "6. Start auth server:  sudo systemctl start pirate-auth"
echo "7. Check status:       sudo systemctl status pirate-server pirate-auth nginx"
echo "8. View game logs:     sudo journalctl -u pirate-server -f"
echo "9. View auth logs:     sudo journalctl -u pirate-auth -f"
echo "10. Access admin panel: http://your-server-ip:8081"
