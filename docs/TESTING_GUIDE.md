# Protocol Testing Guide

This guide shows how to test the pirate game protocol implementation.

## Quick Test Commands

### 1. Start the Server
```bash
cd /home/kevin/Documents/Github/pirate-game-4/server
./build.sh debug
cd build_debug
./pirate-server
```

### 2. Test UDP Game Port (8080)
```bash
# Test if server is listening
netstat -ulnp | grep 8080

# Send raw UDP packet (basic connectivity)
echo "test" | nc -u localhost 8080

# Monitor UDP traffic
sudo tcpdump -i lo port 8080 -X
```

### 3. Test Admin HTTP Port (8081)
```bash
# Test admin panel homepage
curl http://localhost:8081/

# Test API endpoints
curl http://localhost:8081/api/status
curl http://localhost:8081/api/map
curl http://localhost:8081/api/physics
curl http://localhost:8081/api/network
```

## Protocol Packet Testing

### Manual Packet Construction
```bash
# Create a test JOIN_GAME packet (hex format)
# Magic: 50495241, Version: 0001, Type: 0001, etc.
echo -ne '\x41\x52\x49\x50\x01\x00\x01\x00\x01\x00\x00\x00' | nc -u localhost 8080
```

### Using Netcat for UDP Testing
```bash
# Interactive UDP client
nc -u localhost 8080

# Send JOIN_GAME with JSON payload
echo '{"player_name":"TestPlayer","client_version":"1.0.0"}' | nc -u localhost 8080
```

### Network Monitoring
```bash
# Monitor all game traffic
sudo tcpdump -i any port 8080 or port 8082 v

# Monitor only UDP packets
sudo tcpdump -i any udp port 8080 -X

# Monitor with packet size info
sudo tcpdump -i any port 8080 -v -s 1500

# Save packets to file for analysis
sudo tcpdump -i any port 8080 -w game_packets.pcap
```

## Performance Testing

### Latency Testing
```bash
# Test server response time
ping localhost

# Test UDP latency with hping3
sudo hping3 -2 -p 8080 -c 10 localhost

# HTTP latency testing
curl -w "@curl-format.txt" -s -o /dev/null http://localhost:8081/api/status
```

Create `curl-format.txt`:
```
     time_namelookup:  %{time_namelookup}\n
        time_connect:  %{time_connect}\n
     time_appconnect:  %{time_appconnect}\n
    time_pretransfer:  %{time_pretransfer}\n
       time_redirect:  %{time_redirect}\n
  time_starttransfer:  %{time_starttransfer}\n
                     ----------\n
          time_total:  %{time_total}\n
```

### Load Testing
```bash
# Multiple concurrent connections
for i in {1..10}; do
    echo "test_$i" | nc -u localhost 8080 &
done
wait

# HTTP load testing with ab (if available)
ab -n 100 -c 10 http://localhost:8081/api/status

# Or with curl in loop
for i in {1..100}; do
    curl -s http://localhost:8081/api/status > /dev/null &
done
wait
```

## Protocol Validation

### Packet Structure Validation
```python
#!/usr/bin/env python3
import struct
import socket

def create_join_packet(player_name="TestPlayer"):
    # Packet header (16 bytes)
    magic = 0x50495241      # 'PIRA'
    version = 1
    msg_type = 0x01         # JOIN_GAME
    sequence = 1
    timestamp = 1234567890
    payload = f'{{"player_name":"{player_name}","client_version":"1.0.0"}}'.encode()
    payload_size = len(payload)
    checksum = sum(payload) & 0xFF
    flags = 0
    
    header = struct.pack('<IHHIIHBB', 
                        magic, version, msg_type, sequence, 
                        timestamp, payload_size, checksum, flags)
    
    return header + payload

def test_server_connection():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    packet = create_join_packet("TestPlayer")
    
    try:
        sock.sendto(packet, ('localhost', 8080))
        print(f"Sent {len(packet)} byte packet")
        
        # Wait for response (with timeout)
        sock.settimeout(5.0)
        data, addr = sock.recvfrom(1400)
        print(f"Received {len(data)} byte response from {addr}")
        
        # Parse response header
        if len(data) >= 16:
            magic, version, msg_type = struct.unpack('<IHH', data[:8])
            print(f"Response: Magic=0x{magic:08x}, Type=0x{msg_type:02x}")
            
    except socket.timeout:
        print("No response from server (timeout)")
    except Exception as e:
        print(f"Error: {e}")
    finally:
        sock.close()

if __name__ == "__main__":
    test_server_connection()
```

Save as `test_protocol.py` and run:
```bash
python3 test_protocol.py
```

### Checksum Validation
```c
// Test checksum implementation
#include <stdio.h>
#include <stdint.h>
#include <string.h>

uint8_t calculate_checksum(const void* data, size_t length) {
    const uint8_t* bytes = (const uint8_t*)data;
    uint8_t sum = 0;
    for (size_t i = 0; i < length; i++) {
        sum += bytes[i];
    }
    return sum;
}

int main() {
    const char* test_data = "Hello, World!";
    uint8_t checksum = calculate_checksum(test_data, strlen(test_data));
    printf("Checksum for '%s': 0x%02x\n", test_data, checksum);
    return 0;
}
```

## Debugging Network Issues

### Common Problems & Solutions

1. **"Connection Refused"**
   ```bash
   # Check if server is running
   ps aux | grep pirate-server
   
   # Check if port is bound
   ss -ulnp | grep 8080
   ```

2. **"No Route to Host"**
   ```bash
   # Check network interface
   ip route show
   
   # Test basic connectivity
   ping localhost
   ```

3. **Packet Loss**
   ```bash
   # Monitor dropped packets
   netstat -su | grep -i drop
   
   # Check buffer sizes
   cat /proc/sys/net/core/rmem_default
   cat /proc/sys/net/core/wmem_default
   ```

4. **Firewall Issues**
   ```bash
   # Check iptables rules
   sudo iptables -L -n
   
   # Temporarily disable firewall for testing
   sudo ufw disable
   ```

### Performance Analysis
```bash
# Server performance monitoring
watch -n 1 'ps -p $(pgrep pirate-server) -o pid,pcpu,pmem,time'

# Network buffer usage
watch -n 1 'ss -u -a -n | grep 8080'

# System resource usage
htop
iotop
```

## Automated Testing

### Test Script Example
```bash
#!/bin/bash
# automated_test.sh

echo "Starting server..."
cd /path/to/server && ./pirate-server &
SERVER_PID=$!

sleep 2

echo "Testing connectivity..."
if nc -z localhost 8080; then
    echo "✓ UDP port 8080 accessible"
else
    echo "✗ UDP port 8080 not accessible"
fi

if curl -s http://localhost:8081/ > /dev/null; then
    echo "✓ HTTP port 8081 accessible"
else
    echo "✗ HTTP port 8081 not accessible"
fi

echo "Testing API endpoints..."
for endpoint in status physics network map; do
    if curl -s "http://localhost:8081/api/$endpoint" | grep -q "{"; then
        echo "✓ API endpoint /$endpoint working"
    else
        echo "✗ API endpoint /$endpoint failed"
    fi
done

echo "Cleaning up..."
kill $SERVER_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null

echo "Test complete"
```

Run with:
```bash
chmod +x automated_test.sh
./automated_test.sh
```

This testing guide provides comprehensive methods to validate the protocol implementation and troubleshoot network issues.