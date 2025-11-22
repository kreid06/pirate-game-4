# WebSocket Configuration

The client uses environment variables to configure the WebSocket server connection.

## Setup

1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```

2. Edit `.env` with your server details:
   ```env
   VITE_WS_PROTOCOL=ws
   VITE_WS_HOST=192.168.56.10
   VITE_WS_PORT=8082
   ```

## Configuration Options

- **VITE_WS_PROTOCOL**: WebSocket protocol (`ws` or `wss`)
- **VITE_WS_HOST**: Server hostname or IP address
- **VITE_WS_PORT**: Server port number

## Common Configurations

### Local Development
```env
VITE_WS_PROTOCOL=ws
VITE_WS_HOST=localhost
VITE_WS_PORT=8080
```

### LAN/VM Server
```env
VITE_WS_PROTOCOL=ws
VITE_WS_HOST=192.168.56.10
VITE_WS_PORT=8082
```

### Production (Secure)
```env
VITE_WS_PROTOCOL=wss
VITE_WS_HOST=yourdomain.com
VITE_WS_PORT=443
```

## Fallback

If environment variables are not set, the client falls back to:
- Default: `ws://192.168.56.10:8082`

## Development

After changing `.env`, restart the Vite dev server:
```bash
npm run dev
```

The WebSocket URL will be logged in the browser console on connection.
