# SSL/WSS Setup Guide for Pirate Game Server

This guide explains how to set up secure WebSocket (WSS) connections using nginx as a reverse proxy with SSL/TLS.

## Why WSS is Required

GitHub Pages serves content over HTTPS. Browsers block mixed content (HTTPS page connecting to WS). You must use WSS (secure WebSocket) for production.

## Architecture

```
Browser (HTTPS/WSS) → nginx (443, SSL termination) → pirate-server (8080, plain WS)
```

nginx handles SSL/TLS encryption and forwards to your game server on localhost.

## Prerequisites

- Domain name (recommended) OR IP address (self-signed cert)
- Root/sudo access to Hostinger VPS
- Ports 80 and 443 open in firewall

## Setup Instructions

### Option A: With Domain Name (Recommended)

1. **Point your domain to the VPS**
   - Add an A record pointing to your Hostinger VPS IP
   - Wait for DNS propagation (5-30 minutes)

2. **Run the setup script on your VPS:**
   ```bash
   cd /opt/pirate-game
   chmod +x setup_ssl.sh
   sudo ./setup_ssl.sh
   ```

3. **Edit the nginx config:**
   ```bash
   sudo nano /etc/nginx/sites-available/pirate-game
   ```
   Replace `YOUR_DOMAIN_OR_IP` with your actual domain (e.g., `game.yourdomain.com`)

4. **Get SSL certificate from Let's Encrypt:**
   ```bash
   sudo certbot --nginx -d game.yourdomain.com
   ```
   Follow the prompts. Certbot will automatically configure nginx.

5. **Verify it works:**
   ```bash
   sudo systemctl status nginx
   sudo systemctl status pirate-server
   ```

6. **Update GitHub Secrets:**
   - `VITE_WS_PROTOCOL` → `wss`
   - `VITE_WS_HOST` → `game.yourdomain.com`
   - `VITE_WS_PORT` → `443`

### Option B: With IP Address Only (Self-Signed Certificate)

⚠️ **Warning**: Self-signed certificates will show browser warnings. Users must manually accept the certificate.

1. **Run the setup script:**
   ```bash
   cd /opt/pirate-game
   chmod +x setup_ssl.sh
   sudo ./setup_ssl.sh
   ```

2. **Edit nginx config:**
   ```bash
   sudo nano /etc/nginx/sites-available/pirate-game
   ```
   Replace `YOUR_DOMAIN_OR_IP` with your VPS IP address.

3. **Generate self-signed certificate:**
   ```bash
   sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
     -keyout /etc/ssl/private/nginx-selfsigned.key \
     -out /etc/ssl/certs/nginx-selfsigned.crt
   ```
   Fill in the prompts (can use dummy values).

4. **Update nginx config to use the certificate:**
   ```bash
   sudo nano /etc/nginx/sites-available/pirate-game
   ```
   Uncomment and update the SSL lines:
   ```nginx
   ssl_certificate /etc/ssl/certs/nginx-selfsigned.crt;
   ssl_certificate_key /etc/ssl/private/nginx-selfsigned.key;
   ```

5. **Reload nginx:**
   ```bash
   sudo nginx -t
   sudo systemctl reload nginx
   ```

6. **Update GitHub Secrets:**
   - `VITE_WS_PROTOCOL` → `wss`
   - `VITE_WS_HOST` → `YOUR_VPS_IP`
   - `VITE_WS_PORT` → `443`

## Updating Deployment Workflow

The setup script should be run once manually. To automate SSL certificate in deployments, update `.github/workflows/deploy-server.yml` to include the setup script in the deployment.

## Testing

1. **Test locally first:**
   ```bash
   cd client
   npm run dev
   ```
   Update `.env` with `wss://` settings and test the connection.

2. **Deploy and test on GitHub Pages:**
   - Push changes to trigger client deployment
   - Visit https://kreid06.github.io/pirate-game-4/
   - Check browser console for connection success

## Troubleshooting

### Connection Refused
- Check if nginx is running: `sudo systemctl status nginx`
- Check if ports 80/443 are open: `sudo ufw status`
- Check nginx logs: `sudo tail -f /var/log/nginx/error.log`

### Certificate Errors
- For Let's Encrypt: Ensure domain DNS is pointing to your VPS
- For self-signed: Users must accept the certificate warning in browser
- Check certificate validity: `sudo certbot certificates`

### WebSocket Upgrade Failed
- Verify nginx config has `proxy_set_header Upgrade` and `Connection "upgrade"`
- Check game server is running: `sudo systemctl status pirate-server`
- Test direct connection: `curl http://localhost:8080`

## Certificate Renewal

Let's Encrypt certificates expire after 90 days. Certbot automatically sets up a renewal timer:

```bash
sudo systemctl status certbot.timer
sudo certbot renew --dry-run  # Test renewal
```

## Security Recommendations

1. **Use a domain name** - Easier SSL management, no browser warnings
2. **Enable firewall** - Only allow ports 22, 80, 443, and 8080 (localhost only)
3. **Keep certificates updated** - Let's Encrypt auto-renews
4. **Monitor logs** - Check nginx and server logs regularly
