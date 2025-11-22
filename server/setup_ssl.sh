#!/bin/bash
# SSL Setup Script for Pirate Game Server
# Run this on your Hostinger VPS as root or with sudo

set -e

echo "🔐 Setting up SSL/WSS for Pirate Game Server"

# Install nginx and certbot
echo "📦 Installing nginx and certbot..."
apt update
apt install -y nginx certbot python3-certbot-nginx

# Create nginx configuration for the game server
echo "⚙️  Creating nginx configuration..."
cat > /etc/nginx/sites-available/pirate-game << 'EOF'
server {
    listen 80;
    server_name YOUR_DOMAIN_OR_IP;

    # Redirect HTTP to HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name YOUR_DOMAIN_OR_IP;

    # SSL configuration (certbot will add these)
    # ssl_certificate /etc/letsencrypt/live/YOUR_DOMAIN/fullchain.pem;
    # ssl_certificate_key /etc/letsencrypt/live/YOUR_DOMAIN/privkey.pem;

    # WebSocket proxy to game server
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        
        # WebSocket headers
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        
        # Standard proxy headers
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # Timeouts for long-lived WebSocket connections
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
    }
}
EOF

# Note: Replace YOUR_DOMAIN_OR_IP with actual value before running certbot
echo ""
echo "⚠️  IMPORTANT: Edit /etc/nginx/sites-available/pirate-game"
echo "   Replace YOUR_DOMAIN_OR_IP with your actual domain or IP"
echo ""
read -p "Press Enter after you've edited the file..."

# Enable the site
ln -sf /etc/nginx/sites-available/pirate-game /etc/nginx/sites-enabled/

# Test nginx configuration
nginx -t

# Reload nginx
systemctl reload nginx

echo ""
echo "📝 Next steps:"
echo "1. If using a DOMAIN NAME:"
echo "   Run: certbot --nginx -d yourdomain.com"
echo ""
echo "2. If using ONLY IP ADDRESS:"
echo "   You'll need to create a self-signed certificate:"
echo "   Run: openssl req -x509 -nodes -days 365 -newkey rsa:2048 \\"
echo "        -keyout /etc/ssl/private/nginx-selfsigned.key \\"
echo "        -out /etc/ssl/certs/nginx-selfsigned.crt"
echo "   Then update nginx config with these paths"
echo ""
echo "3. Update GitHub secrets:"
echo "   VITE_WS_PROTOCOL=wss"
echo "   VITE_WS_HOST=yourdomain.com (or IP)"
echo "   VITE_WS_PORT=443"
