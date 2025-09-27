/**
 * Protocol Implementation Examples
 * 
 * This file shows practical examples of how to implement the pirate game
 * protocol on both client and server sides.
 */

// =============================================================================
// CLIENT SIDE (TypeScript/JavaScript)
// =============================================================================

interface GamePacket {
    magic: number;      // 0x50495241
    version: number;    // 1
    type: number;       // Message type
    sequence: number;   // Packet sequence
    timestamp: number;  // Client timestamp
    payload_size: number;
    checksum: number;
    flags: number;
    payload: ArrayBuffer;
}

// Client message types
enum ClientMessageType {
    JOIN_GAME = 0x01,
    INPUT_UPDATE = 0x02,
    PING = 0x03,
    LEAVE_GAME = 0x04
}

// Server message types  
enum ServerMessageType {
    WELCOME = 0x81,
    GAME_STATE = 0x82,
    STATE_UPDATE = 0x83,
    PLAYER_JOINED = 0x84,
    PLAYER_LEFT = 0x85,
    PONG = 0x86
}

class GameClient {
    private socket: WebSocket;
    private playerId: number = 0;
    private sequenceNumber: number = 0;

    connect(serverUrl: string) {
        this.socket = new WebSocket(serverUrl);
        this.socket.binaryType = 'arraybuffer';
        
        this.socket.onopen = () => {
            this.sendJoinGame("PlayerName");
        };
        
        this.socket.onmessage = (event) => {
            this.handlePacket(new Uint8Array(event.data));
        };
    }

    sendJoinGame(playerName: string) {
        const payload = {
            player_name: playerName,
            client_version: "1.0.0",
            preferred_ship: "sloop"
        };
        
        this.sendPacket(ClientMessageType.JOIN_GAME, JSON.stringify(payload));
    }

    sendInputUpdate(input: InputState) {
        // Convert to binary format for efficiency
        const buffer = new ArrayBuffer(16);
        const view = new DataView(buffer);
        
        view.setUint32(0, this.playerId, true);
        view.setUint8(4, input.keys);
        view.setUint8(5, input.mouseButtons);
        view.setInt16(6, input.mouseX, true);
        view.setInt16(8, input.mouseY, true);
        view.setUint32(10, input.timestamp, true);
        view.setUint32(14, this.getCurrentTick(), true);
        
        this.sendPacket(ClientMessageType.INPUT_UPDATE, buffer);
    }

    private sendPacket(type: number, payload: string | ArrayBuffer) {
        const payloadBuffer = typeof payload === 'string' ? 
            new TextEncoder().encode(payload) : 
            new Uint8Array(payload);
            
        const packet = new ArrayBuffer(16 + payloadBuffer.length);
        const view = new DataView(packet);
        
        // Packet header
        view.setUint32(0, 0x50495241, true);    // Magic 'PIRA'
        view.setUint16(4, 1, true);             // Version
        view.setUint16(6, type, true);          // Type
        view.setUint32(8, this.sequenceNumber++, true); // Sequence
        view.setUint32(12, Date.now(), true);   // Timestamp
        view.setUint16(16, payloadBuffer.length, true); // Payload size
        view.setUint8(18, this.calculateChecksum(payloadBuffer), true); // Checksum
        view.setUint8(19, 0, true);             // Flags
        
        // Copy payload
        new Uint8Array(packet, 20).set(payloadBuffer);
        
        this.socket.send(packet);
    }

    private handlePacket(data: Uint8Array) {
        const view = new DataView(data.buffer);
        
        // Validate packet header
        const magic = view.getUint32(0, true);
        if (magic !== 0x50495241) {
            console.error("Invalid packet magic");
            return;
        }
        
        const type = view.getUint16(6, true);
        const payloadSize = view.getUint16(16, true);
        const payload = data.slice(20, 20 + payloadSize);
        
        switch (type) {
            case ServerMessageType.WELCOME:
                this.handleWelcome(payload);
                break;
            case ServerMessageType.GAME_STATE:
                this.handleGameState(payload);
                break;
            case ServerMessageType.STATE_UPDATE:
                this.handleStateUpdate(payload);
                break;
        }
    }

    private handleWelcome(payload: Uint8Array) {
        const json = JSON.parse(new TextDecoder().decode(payload));
        this.playerId = json.player_id;
        console.log(`Connected as player ${this.playerId}`);
    }

    private calculateChecksum(data: Uint8Array): number {
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
            sum += data[i];
        }
        return sum & 0xFF;
    }

    private getCurrentTick(): number {
        // Implementation depends on client tick system
        return Math.floor(Date.now() / 33.33); // 30Hz approximation
    }
}

// =============================================================================
// SERVER SIDE (C Implementation Example)
// =============================================================================

/*
#include <sys/socket.h>
#include <netinet/in.h>
#include <stdint.h>

#define MAGIC_PIRA 0x50495241
#define PROTOCOL_VERSION 1
#define MAX_PACKET_SIZE 1400

// Message types
typedef enum {
    CLIENT_JOIN_GAME = 0x01,
    CLIENT_INPUT_UPDATE = 0x02,
    CLIENT_PING = 0x03,
    CLIENT_LEAVE_GAME = 0x04,
    
    SERVER_WELCOME = 0x81,
    SERVER_GAME_STATE = 0x82,
    SERVER_STATE_UPDATE = 0x83,
    SERVER_PLAYER_JOINED = 0x84,
    SERVER_PLAYER_LEFT = 0x85,
    SERVER_PONG = 0x86
} MessageType;

// Packet structure (16-byte header + payload)
struct GamePacket {
    uint32_t magic;         // 0x50495241
    uint16_t version;       // Protocol version
    uint16_t type;          // Message type
    uint32_t sequence;      // Sequence number
    uint32_t timestamp;     // Timestamp
    uint16_t payload_size;  // Payload length
    uint8_t  checksum;      // Simple checksum
    uint8_t  flags;         // Control flags
} __attribute__((packed));

// Input state structure
struct InputState {
    uint32_t player_id;
    uint8_t  keys;          // WASD bitmask
    uint8_t  mouse_buttons; // Mouse button bitmask
    int16_t  mouse_x;       // Mouse X position
    int16_t  mouse_y;       // Mouse Y position
    uint32_t timestamp;     // Client timestamp
    uint32_t client_tick;   // Client prediction tick
} __attribute__((packed));

// Network manager functions
int network_send_welcome(int socket_fd, struct sockaddr_in* client_addr, 
                        uint32_t player_id, uint32_t ship_id) {
    char json_payload[256];
    int len = snprintf(json_payload, sizeof(json_payload),
        "{"
        "\"player_id\": %u,"
        "\"assigned_ship_id\": %u,"
        "\"world_seed\": %u,"
        "\"server_time\": %u,"
        "\"tick_rate\": 30"
        "}",
        player_id, ship_id, get_world_seed(), get_server_time()
    );
    
    return network_send_packet(socket_fd, client_addr, SERVER_WELCOME, 
                              json_payload, len);
}

int network_send_packet(int socket_fd, struct sockaddr_in* addr, 
                       uint16_t type, const void* payload, uint16_t size) {
    struct GamePacket packet;
    packet.magic = MAGIC_PIRA;
    packet.version = PROTOCOL_VERSION;
    packet.type = type;
    packet.sequence = get_next_sequence();
    packet.timestamp = get_server_time();
    packet.payload_size = size;
    packet.checksum = calculate_checksum(payload, size);
    packet.flags = 0;
    
    // Send header + payload
    uint8_t buffer[MAX_PACKET_SIZE];
    memcpy(buffer, &packet, sizeof(packet));
    memcpy(buffer + sizeof(packet), payload, size);
    
    return sendto(socket_fd, buffer, sizeof(packet) + size, 0,
                  (struct sockaddr*)addr, sizeof(*addr));
}

int network_handle_input_update(const uint8_t* payload, uint16_t size) {
    if (size != sizeof(struct InputState)) {
        log_error("Invalid input update size: %u", size);
        return -1;
    }
    
    struct InputState* input = (struct InputState*)payload;
    
    // Validate player ID
    if (input->player_id == 0 || input->player_id > MAX_PLAYERS) {
        log_error("Invalid player ID: %u", input->player_id);
        return -1;
    }
    
    // Apply input to simulation
    return sim_apply_player_input(get_simulation(), input);
}

// Checksum calculation
uint8_t calculate_checksum(const void* data, size_t length) {
    const uint8_t* bytes = (const uint8_t*)data;
    uint8_t sum = 0;
    
    for (size_t i = 0; i < length; i++) {
        sum += bytes[i];
    }
    
    return sum;
}

// Fixed-point conversion utilities
int32_t float_to_fixed(float f) {
    return (int32_t)(f * 65536.0f);
}

float fixed_to_float(int32_t fixed) {
    return (float)fixed / 65536.0f;
}
*/

// =============================================================================
// USAGE EXAMPLES
// =============================================================================

interface InputState {
    keys: number;           // WASD as bitmask
    mouseButtons: number;   // Mouse buttons
    mouseX: number;         // Mouse X position
    mouseY: number;         // Mouse Y position
    timestamp: number;      // Input timestamp
}

// Example: Client connecting and sending input
const client = new GameClient();
client.connect("ws://localhost:8080");

// Example: Sending player input
const input: InputState = {
    keys: 0b1010,       // W + S pressed
    mouseButtons: 1,    // Left mouse button
    mouseX: 100,
    mouseY: 200,
    timestamp: Date.now()
};

client.sendInputUpdate(input);

// =============================================================================
// TESTING UTILITIES
// =============================================================================

class PacketCapture {
    static logPacket(data: Uint8Array) {
        const view = new DataView(data.buffer);
        const magic = view.getUint32(0, true);
        const type = view.getUint16(6, true);
        const sequence = view.getUint32(8, true);
        
        console.log(`Packet: Magic=0x${magic.toString(16)}, Type=0x${type.toString(16)}, Seq=${sequence}`);
    }
    
    static validatePacket(data: Uint8Array): boolean {
        if (data.length < 20) return false;
        
        const view = new DataView(data.buffer);
        const magic = view.getUint32(0, true);
        const payloadSize = view.getUint16(16, true);
        
        return magic === 0x50495241 && data.length >= 20 + payloadSize;
    }
}

export {
    GameClient,
    ClientMessageType,
    ServerMessageType,
    PacketCapture,
    type GamePacket,
    type InputState
};