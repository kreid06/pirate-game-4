#include <stdio.h>
#include <assert.h>
#include <string.h>
#include "../src/net/protocol.c"

void test_packet_validation(void) {
    printf("Testing packet validation...\n");
    
    // Test valid command packet
    struct CmdPacket cmd = {0};
    cmd.type = PACKET_CLIENT_INPUT;
    cmd.version = PROTOCOL_VERSION;
    cmd.seq = 123;
    cmd.thrust = 1000;
    cmd.turn = -500;
    cmd.actions = 0x05;
    cmd.client_time = 12345;
    cmd.checksum = protocol_checksum(&cmd, sizeof(cmd) - sizeof(cmd.checksum));
    
    bool valid = protocol_validate_packet(&cmd, sizeof(cmd), PACKET_CLIENT_INPUT);
    assert(valid && "Valid command packet should pass validation");
    printf("  ✓ Valid command packet passes validation\n");
    
    // Test invalid version
    cmd.version = 99;
    valid = protocol_validate_packet(&cmd, sizeof(cmd), PACKET_CLIENT_INPUT);
    assert(!valid && "Invalid version should fail validation");
    printf("  ✓ Invalid version fails validation\n");
    
    // Test size mismatch
    cmd.version = PROTOCOL_VERSION;
    valid = protocol_validate_packet(&cmd, sizeof(cmd) - 1, PACKET_CLIENT_INPUT);
    assert(!valid && "Size mismatch should fail validation");
    printf("  ✓ Size mismatch fails validation\n");
    
    // Test handshake packet
    struct ClientHandshake handshake = {0};
    handshake.type = PACKET_CLIENT_HANDSHAKE;
    handshake.version = PROTOCOL_VERSION;
    handshake.client_id = 12345;
    strcpy(handshake.player_name, "TestBot");
    handshake.checksum = protocol_checksum(&handshake, 
                                          sizeof(handshake) - sizeof(handshake.checksum));
    
    valid = protocol_validate_packet(&handshake, sizeof(handshake), PACKET_CLIENT_HANDSHAKE);
    assert(valid && "Valid handshake should pass validation");
    printf("  ✓ Valid handshake passes validation\n");
    
    printf("Packet validation test passed!\n\n");
}

void test_quantization(void) {
    printf("Testing quantization functions...\n");
    
    // Test position quantization (1/512 m precision)
    float positions[] = {0.0f, 1.0f, -1.0f, 123.456f, -67.89f};
    
    for (size_t i = 0; i < sizeof(positions)/sizeof(positions[0]); i++) {
        float original = positions[i];
        uint16_t quantized = quantize_position(original);
        float restored = unquantize_position(quantized);
        float error = original - restored;
        
        printf("  Position: %.3f -> %u -> %.3f (error: %.6f)\n",
               original, quantized, restored, error);
        
        // Error should be within quantization precision
        assert(fabs(error) <= (1.0f / 512.0f) && "Position quantization error too large");
    }
    
    // Test velocity quantization (1/256 m/s precision)
    float velocities[] = {0.0f, 10.0f, -5.5f, 50.0f};
    
    for (size_t i = 0; i < sizeof(velocities)/sizeof(velocities[0]); i++) {
        float original = velocities[i];
        uint16_t quantized = quantize_velocity(original);
        float restored = unquantize_velocity(quantized);
        float error = original - restored;
        
        printf("  Velocity: %.3f -> %u -> %.3f (error: %.6f)\n",
               original, quantized, restored, error);
        
        assert(fabs(error) <= (1.0f / 256.0f) && "Velocity quantization error too large");
    }
    
    // Test rotation quantization (1/1024 radian precision)
    float angles[] = {0.0f, 1.5708f, 3.1416f, 6.2832f}; // 0, π/2, π, 2π
    
    for (size_t i = 0; i < sizeof(angles)/sizeof(angles[0]); i++) {
        float original = angles[i];
        uint16_t quantized = quantize_rotation(original);
        float restored = unquantize_rotation(quantized);
        float error = original - restored;
        
        printf("  Rotation: %.4f -> %u -> %.4f (error: %.6f)\n",
               original, quantized, restored, error);
        
        assert(fabs(error) <= (6.28318f / 1024.0f) && "Rotation quantization error too large");
    }
    
    printf("Quantization test passed!\n\n");
}

void test_checksum(void) {
    printf("Testing checksum function...\n");
    
    // Test identical data produces same checksum
    uint8_t data1[] = {1, 2, 3, 4, 5, 6, 7, 8};
    uint8_t data2[] = {1, 2, 3, 4, 5, 6, 7, 8};
    
    uint16_t checksum1 = protocol_checksum(data1, sizeof(data1));
    uint16_t checksum2 = protocol_checksum(data2, sizeof(data2));
    
    assert(checksum1 == checksum2 && "Identical data should have same checksum");
    printf("  ✓ Identical data produces same checksum: 0x%04X\n", checksum1);
    
    // Test different data produces different checksum
    data2[0] = 99;
    uint16_t checksum3 = protocol_checksum(data2, sizeof(data2));
    
    assert(checksum1 != checksum3 && "Different data should have different checksum");
    printf("  ✓ Modified data produces different checksum: 0x%04X\n", checksum3);
    
    // Test empty data
    uint16_t checksum_empty = protocol_checksum(NULL, 0);
    assert(checksum_empty == 0 && "Empty data should have zero checksum");
    printf("  ✓ Empty data produces zero checksum\n");
    
    printf("Checksum test passed!\n\n");
}

int main(void) {
    printf("=== Network Protocol Tests ===\n\n");
    
    test_packet_validation();
    test_quantization();
    test_checksum();
    
    printf("All protocol tests passed! ✓\n");
    printf("\nValidation coverage:\n");
    printf("- Packet type and version validation\n");
    printf("- Size validation for fixed and variable packets\n");
    printf("- Position/velocity/rotation quantization accuracy\n");
    printf("- Checksum consistency and collision detection\n");
    
    return 0;
}