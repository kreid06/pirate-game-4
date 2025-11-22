#!/bin/bash
# Quick port configuration for Pirate Game Server
# Run this on your VPS after initial setup

echo "🔧 Configuring Pirate Game Server Ports..."

# Configure UFW firewall
if command -v ufw &> /dev/null; then
    echo "Opening ports in UFW..."
    
    # CRITICAL: Ensure SSH is allowed
    echo "⚠️  Ensuring SSH (port 22) is allowed..."
    sudo ufw allow 22/tcp comment 'SSH'
    
    # Add game server ports
    sudo ufw allow 8082/tcp comment 'Pirate Game WebSocket'
    sudo ufw allow 8081/tcp comment 'Pirate Game Admin Panel'
    sudo ufw allow 8080/udp comment 'Pirate Game UDP (future)'
    
    echo "✅ UFW rules added (including SSH)"
fi

# Configure firewalld (CentOS/RHEL)
if command -v firewall-cmd &> /dev/null; then
    echo "Opening ports in firewalld..."
    
    # Ensure SSH is allowed
    sudo firewall-cmd --permanent --add-service=ssh
    
    # Add game server ports
    sudo firewall-cmd --permanent --add-port=8082/tcp
    sudo firewall-cmd --permanent --add-port=8081/tcp
    sudo firewall-cmd --permanent --add-port=8080/udp
    sudo firewall-cmd --reload
    
    echo "✅ Firewalld rules added (including SSH)"
fi

echo ""
echo "✅ Port configuration complete!"
echo ""
echo "Configured ports:"
echo "  22/tcp   - SSH (CRITICAL - prevents lockout)"
echo "  8082/tcp - WebSocket (game traffic)"
echo "  8081/tcp - Admin panel"
echo "  8080/udp - UDP traffic (future)"
echo ""
echo "Test your ports:"
echo "  telnet your-server-ip 8082"
echo "  telnet your-server-ip 8081"
echo "  nc -u -v your-server-ip 8080"
