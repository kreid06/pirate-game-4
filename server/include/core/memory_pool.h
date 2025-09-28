#ifndef CORE_MEMORY_POOL_H
#define CORE_MEMORY_POOL_H

#include <stdint.h>
#include <stddef.h>

// Memory pool configuration
#define MAX_POOL_BLOCKS 1024
#define INVALID_BLOCK 0xFFFF
#define ALLOCATED_BLOCK 0xFFFE

// Memory pool for fixed-size allocations
struct MemoryPool {
    uint8_t blocks[MAX_POOL_BLOCKS * 256]; // Up to 256KB per pool
    uint16_t free_list[MAX_POOL_BLOCKS];   // Free block linked list
    uint16_t next_free;                    // Index of next free block
    uint16_t free_count;                   // Number of free blocks
    uint16_t allocated_count;              // Number of allocated blocks
    size_t block_size;                     // Size of each block
    size_t block_count;                    // Total number of blocks
};

// Memory pool statistics
struct MemoryPoolStats {
    size_t block_size;
    size_t total_blocks;
    size_t free_blocks;
    size_t allocated_blocks;
    uint32_t utilization_percent;
    size_t memory_used_bytes;
    size_t memory_total_bytes;
};

// Memory pool operations
int memory_pool_init(struct MemoryPool* pool, size_t block_size, size_t block_count);
void* memory_pool_alloc(struct MemoryPool* pool);
void memory_pool_free(struct MemoryPool* pool, void* ptr);
void memory_pool_reset(struct MemoryPool* pool);
void memory_pool_stats(const struct MemoryPool* pool, struct MemoryPoolStats* stats);

#endif /* CORE_MEMORY_POOL_H */