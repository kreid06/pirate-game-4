# Deployment Strategy - Pirate Game 4

## Overview

**Deploy built artifacts, not source code!**

- ✅ Client: Deploy `client/dist/` (built HTML/JS/CSS)
- ✅ Server: Deploy compiled binary `server/build/pirate-server`
- ❌ Don't deploy: Source code, node_modules, build configs

## Simplified Branch Strategy

### Branches

- **`main`** - Production-ready code
  - Automatically deploys to production
  - Only merge tested, stable code here
  
- **`develop`** - Integration/testing branch (optional)
  - Automatically deploys to staging
  - Merge feature branches here for testing

- **`feature/*`** - Feature development
  - No automatic deployment
  - Create PR to `develop` or `main`

## Deployment Workflows

### Client Deployment (Automatic)

**Triggers:** Push to `main` with changes in `client/` or `protocol/`

**Process:**
1. Checkout code
2. Install dependencies (`npm ci`)
3. Build production bundle (`npm run build`)
4. Deploy `client/dist/` folder to hosting

**Deploys only:**
```
client/dist/
├── index.html
├── assets/
│   ├── main-[hash].js
│   └── main-[hash].css
└── favicon.ico
```

**NOT deployed:** Source code, node_modules, configs

### Server Deployment (Automatic)

**Triggers:** Push to `main` with changes in `server/` or `protocol/`

**Process:**
1. Checkout code
2. Install build dependencies (cmake, gcc, openssl)
3. Compile server (`cmake && make`)
4. Strip debug symbols (`strip pirate-server`)
5. Deploy binary + config to production server
6. Restart service

**Deploys only:**
```
/opt/pirate-game/
├── bin/
│   └── pirate-server          # Compiled binary (~500KB)
└── config/
    └── server.conf            # Configuration
```

**NOT deployed:** Source code, object files, build artifacts

## Environment Configuration

### Client Environments

**.env.production** (for production builds):
```env
VITE_WS_PROTOCOL=wss
VITE_WS_HOST=game.yourdomain.com
VITE_WS_PORT=443
```

**.env.staging** (for staging builds):
```env
VITE_WS_PROTOCOL=ws
VITE_WS_HOST=staging.yourdomain.com
VITE_WS_PORT=8080
```

### Server Configuration

Use different config files per environment:

**Production:** `server/config/server.conf`
```conf
port=8082
max_players=100
tick_rate=60
```

**Staging:** `server/config/server.staging.conf`
```conf
port=8083
max_players=10
tick_rate=60
```

## GitHub Secrets Setup

Add these secrets in **Settings → Secrets and variables → Actions**:

### Client Deployment
```
VITE_WS_PROTOCOL=wss
VITE_WS_HOST=game.yourdomain.com
VITE_WS_PORT=443
```

### Server Deployment
```
SERVER_HOST=your-server-ip
SERVER_USER=deploy
SERVER_SSH_KEY=<your-private-key>
```

### Optional (Netlify/Vercel)
```
NETLIFY_AUTH_TOKEN=<token>
NETLIFY_SITE_ID=<site-id>
```

## Deployment Flow

### Production Deployment

```bash
# 1. Develop feature
git checkout -b feature/new-ship-type
# ... make changes ...
git commit -am "Add new ship type"
git push origin feature/new-ship-type

# 2. Create PR to main
# Review on GitHub, run tests

# 3. Merge PR to main
# GitHub Actions automatically:
#   - Builds client → deploys to production
#   - Builds server → deploys to production

# Done! Live in production within 5 minutes
```

### Staging Deployment (Optional)

```bash
# Merge to develop instead of main
git checkout develop
git merge feature/new-ship-type
git push

# Deploys to staging environment
# Test at staging.yourdomain.com

# When ready, merge to main for production
git checkout main
git merge develop
git push
```

## What Gets Deployed

### Client Build Output

```bash
cd client
npm run build

# Creates client/dist/:
dist/
├── index.html                    # Entry point
├── assets/
│   ├── index-a1b2c3d4.js        # Minified JS (~200KB gzipped)
│   ├── index-a1b2c3d4.css       # Minified CSS (~10KB)
│   └── [images/fonts]           # Static assets
└── favicon.ico
```

**Size:** ~300KB total (gzipped)

### Server Build Output

```bash
cd server
mkdir build && cd build
cmake -DCMAKE_BUILD_TYPE=Release ..
make
strip pirate-server

# Creates:
pirate-server    # Compiled binary (~500KB)
```

**Size:** ~500KB binary

## Hosting Options

### Client Hosting

**Option 1: GitHub Pages (Free)**
- Automatic via workflow
- URL: `username.github.io/pirate-game-4`
- Custom domain supported

**Option 2: Netlify (Free tier)**
- Automatic builds
- Custom domain
- HTTPS included
- Fast CDN

**Option 3: Vercel (Free tier)**
- Similar to Netlify
- Great for Vite projects

**Option 4: Cloudflare Pages (Free)**
- Unlimited bandwidth
- Fast CDN
- HTTPS included

### Server Hosting

**Requirements:**
- Linux server (Ubuntu 20.04+)
- 1GB RAM minimum
- Open port for WebSocket (8080-8082)

**Options:**
- DigitalOcean Droplet ($4/month)
- AWS Lightsail ($3.50/month)
- Linode ($5/month)
- Your own VPS

## Manual Deployment

### Client (Manual)

```bash
# Build locally
cd client
npm install
npm run build

# Deploy to any static host
# Upload client/dist/ folder
```

### Server (Manual)

```bash
# Build locally (Linux/WSL)
cd server
mkdir build && cd build
cmake -DCMAKE_BUILD_TYPE=Release ..
make

# Copy to server
scp pirate-server user@server:/opt/pirate-game/bin/
ssh user@server 'sudo systemctl restart pirate-server'
```

## Rollback Strategy

### Client Rollback

GitHub Pages keeps history:
```bash
# Revert to previous deployment
git checkout gh-pages
git revert HEAD
git push
```

Or redeploy specific commit:
```bash
git checkout <old-commit-hash>
git push origin main --force  # Triggers redeploy
```

### Server Rollback

Keep previous binary:
```bash
# On server
sudo systemctl stop pirate-server
cd /opt/pirate-game/bin
cp pirate-server pirate-server.backup
cp pirate-server.previous pirate-server
sudo systemctl start pirate-server
```

## Monitoring

### Client Monitoring
- Check browser console for WebSocket errors
- Monitor Netlify/Vercel deployment logs
- Use analytics (Google Analytics, Plausible)

### Server Monitoring
```bash
# Check server status
sudo systemctl status pirate-server

# View logs
sudo journalctl -u pirate-server -f

# Check connections
netstat -an | grep 8082
```

## Summary

**No deployment branches needed!** ✅

**Workflow:**
1. Push to `main` → Automatic deployment
2. GitHub Actions builds artifacts
3. Only built files deployed (not source)
4. Client: Static files to CDN
5. Server: Compiled binary to VPS

**What you deploy:**
- Client: 300KB of HTML/JS/CSS
- Server: 500KB compiled binary

**What you DON'T deploy:**
- Source code
- node_modules
- Build configs
- Development files
