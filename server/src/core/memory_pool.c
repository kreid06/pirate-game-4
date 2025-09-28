#include "core/memory_pool.h"
#include "util/log.h"
#include <string.h>
#include <assert.h>

int memory_pool_init(struct MemoryPool* pool, size_t block_size, size_t block_count) {
    if (!pool || block_size == 0 || block_count == 0 || block_count > MAX_POOL_BLOCKS) {
        log_error("Invalid memory pool parameters");
        return -1;
    }
    
    // Clear the pool structure
    memset(pool, 0, sizeof(struct MemoryPool));
    
    pool->block_size = block_size;
    pool->block_count = block_count;
    pool->free_count = block_count;
    
    // Initialize free list - all blocks are initially free
    for (size_t i = 0; i < block_count - 1; i++) {
        pool->free_list[i] = i + 1;
    }
    pool->free_list[block_count - 1] = INVALID_BLOCK; // Last block points to invalid
    
    pool->next_free = 0; // First free block
    
    log_info("Memory pool initialized: %zu blocks of %zu bytes each (%zu KB total)",
             block_count, block_size, (block_count * block_size) / 1024);
    
    return 0;
}

void* memory_pool_alloc(struct MemoryPool* pool) {
    if (!pool || pool->free_count == 0) {
        return NULL; // Pool exhausted
    }
    
    // Get next free block
    uint16_t block_index = pool->next_free;
    if (block_index == INVALID_BLOCK) {
        log_warn("Memory pool corruption: free_count > 0 but no free blocks");
        return NULL;
    }
    
    // Update free list head
    pool->next_free = pool->free_list[block_index];
    pool->free_count--;
    pool->allocated_count++;
    
    // Mark block as allocated (for debugging)
    pool->free_list[block_index] = ALLOCATED_BLOCK;
    
    // Return pointer to the block
    return &pool->blocks[block_index * pool->block_size];
}

void memory_pool_free(struct MemoryPool* pool, void* ptr) {
    if (!pool || !ptr) {
        return;
    }
    
    // Calculate block index from pointer offset
    uintptr_t pool_start = (uintptr_t)pool->blocks;
    uintptr_t ptr_addr = (uintptr_t)ptr;
    
    if (ptr_addr < pool_start || 
        ptr_addr >= pool_start + (pool->block_count * pool->block_size)) {
        log_warn("Attempt to free pointer outside memory pool");
        return;
    }
    
    size_t offset = ptr_addr - pool_start;
    if (offset % pool->block_size != 0) {
        log_warn("Attempt to free misaligned pointer in memory pool");
        return;
    }
    
    uint16_t block_index = offset / pool->block_size;
    
    // Check if block was actually allocated
    if (pool->free_list[block_index] != ALLOCATED_BLOCK) {
        log_warn("Double free detected in memory pool (block %u)", block_index);
        return;
    }
    
    // Add block back to free list
    pool->free_list[block_index] = pool->next_free;
    pool->next_free = block_index;
    pool->free_count++;
    pool->allocated_count--;
}

void memory_pool_reset(struct MemoryPool* pool) {
    if (!pool) return;
    
    // Reinitialize free list
    for (size_t i = 0; i < pool->block_count - 1; i++) {
        pool->free_list[i] = i + 1;
    }
    pool->free_list[pool->block_count - 1] = INVALID_BLOCK;
    
    pool->next_free = 0;
    pool->free_count = pool->block_count;
    pool->allocated_count = 0;
    
    log_info("Memory pool reset: %zu blocks available", pool->block_count);
}

void memory_pool_stats(const struct MemoryPool* pool, struct MemoryPoolStats* stats) {
    if (!pool || !stats) return;
    
    stats->block_size = pool->block_size;
    stats->total_blocks = pool->block_count;
    stats->free_blocks = pool->free_count;
    stats->allocated_blocks = pool->allocated_count;
    stats->utilization_percent = pool->block_count > 0 ? 
        (pool->allocated_count * 100) / pool->block_count : 0;
    stats->memory_used_bytes = pool->allocated_count * pool->block_size;
    stats->memory_total_bytes = pool->block_count * pool->block_size;
}