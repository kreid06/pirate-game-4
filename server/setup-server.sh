#!/bin/bash
# One-time setup script for game server
# Run this on your VPS/server

set -e

echo "🚀 Setting up Pirate Game Server..."

# 1. Create directories
echo "📁 Creating directories..."
sudo mkdir -p /opt/pirate-game/bin
sudo mkdir -p /opt/pirate-game/config
sudo mkdir -p /opt/pirate-game/logs
sudo chown -R $USER:$USER /opt/pirate-game

# 2. Install dependencies
echo "📦 Installing dependencies..."
sudo apt-get update
sudo apt-get install -y libssl3

# 3. Create config file
echo "⚙️ Creating config file..."
cat > /opt/pirate-game/config/server.conf << 'EOF'
port=8082
max_players=100
tick_rate=60
log_level=info
EOF

# 4. Create systemd service
echo "🔧 Creating systemd service..."
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

# 5. Enable service
echo "✅ Enabling service..."
sudo systemctl daemon-reload
sudo systemctl enable pirate-server

# 6. Configure firewall
echo "🔥 Configuring firewall..."

if command -v ufw &> /dev/null; then
    # UFW is installed
    echo "Using UFW firewall..."
    sudo ufw allow 22/tcp comment 'SSH'
    sudo ufw allow 8082/tcp comment 'Pirate Game WebSocket'
    sudo ufw allow 8081/tcp comment 'Pirate Game Admin Panel'
    sudo ufw allow 8080/udp comment 'Pirate Game UDP Traffic (future)'
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
        sudo ufw allow 8082/tcp comment 'Pirate Game WebSocket'
        sudo ufw allow 8081/tcp comment 'Pirate Game Admin Panel'
        sudo ufw allow 8080/udp comment 'Pirate Game UDP Traffic (future)'
        
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
        sudo iptables -A INPUT -p tcp --dport 8082 -j ACCEPT -m comment --comment "Game WebSocket"
        sudo iptables -A INPUT -p tcp --dport 8081 -j ACCEPT -m comment --comment "Admin Panel"
        sudo iptables -A INPUT -p udp --dport 8080 -j ACCEPT -m comment --comment "UDP (future)"
        
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
echo "Firewall ports opened:"
echo "  - 8082/tcp: WebSocket (game traffic)"
echo "  - 8081/tcp: Admin panel"
echo "  - 8080/udp: UDP traffic (future feature)"
echo ""
echo "Next steps:"
echo "1. Add GitHub secrets for deployment"
echo "2. Push code to main branch"
echo "3. GitHub Actions will deploy the server binary"
echo "4. Start the service: sudo systemctl start pirate-server"
echo "5. Check status: sudo systemctl status pirate-server"
echo "6. View logs: sudo journalctl -u pirate-server -f"
echo "7. Access admin panel: http://your-server-ip:8081"
