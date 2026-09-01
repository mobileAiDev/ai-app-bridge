#ifndef AI_APP_BRIDGE_FACT_STORE_C_H
#define AI_APP_BRIDGE_FACT_STORE_C_H

#include "aab_nslog_hook.h"
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define AIB_SFS_MAX_PARTITIONS 8u
#define AIB_SFS_ERROR_MESSAGE_CAPACITY 160u

typedef uint64_t aib_sfs_handle_t;

typedef struct aib_sfs_operation {
    int32_t code;
    int32_t system_code;
    char message[AIB_SFS_ERROR_MESSAGE_CAPACITY];
} aib_sfs_operation_t;

typedef struct aib_sfs_open_result {
    aib_sfs_operation_t operation;
    aib_sfs_handle_t handle;
} aib_sfs_open_result_t;

typedef struct aib_sfs_append_result {
    aib_sfs_operation_t operation;
    uint32_t payload_length;
    uint32_t partition_id;
    uint64_t sequence;
    uint64_t segment_id;
    uint64_t frame_offset;
} aib_sfs_append_result_t;

typedef struct aib_sfs_read_result {
    aib_sfs_operation_t operation;
    uint32_t cursor_partition_id;
    uint32_t cursor_flags;
    uint64_t cursor_after_sequence;
    uint64_t cursor_segment_id;
    uint64_t cursor_offset;
    uint32_t payload_length;
    uint32_t record_partition_id;
    uint32_t record_flags;
    uint64_t sequence;
    uint64_t record_segment_id;
    uint64_t frame_offset;
    uint64_t gap_first_sequence;
    uint64_t gap_last_sequence;
} aib_sfs_read_result_t;

typedef struct aib_sfs_status_result {
    aib_sfs_operation_t operation;
    uint32_t format_version;
    uint32_t flags;
    uint64_t segment_size;
    uint64_t segment_count;
    uint64_t first_segment_id;
    uint64_t active_segment_id;
    uint64_t active_write_offset;
    uint64_t record_count;
    uint64_t payload_bytes;
    uint64_t next_sequence;
    uint32_t recovery_partition_id;
    uint64_t recovery_segment_id;
    uint64_t recovery_offset;
    uint64_t recovery_discarded_bytes;
    uint64_t partition_quotas[AIB_SFS_MAX_PARTITIONS];
} aib_sfs_status_result_t;

aib_sfs_open_result_t aib_sfs_open(const char *directory,
                                   uint64_t segment_size,
                                   uint32_t flags,
                                   const uint64_t *partition_quotas,
                                   uint32_t partition_quota_count);

aib_sfs_append_result_t aib_sfs_append(aib_sfs_handle_t handle,
                                       uint32_t partition_id,
                                       const void *payload,
                                       uint32_t payload_length,
                                       int32_t durability);

aib_sfs_read_result_t aib_sfs_read(aib_sfs_handle_t handle,
                                   uint32_t cursor_partition_id,
                                   uint32_t cursor_flags,
                                   uint64_t cursor_after_sequence,
                                   uint64_t cursor_segment_id,
                                   uint64_t cursor_offset,
                                   void *buffer,
                                   uint32_t buffer_capacity);

aib_sfs_status_result_t aib_sfs_get_status(aib_sfs_handle_t handle);
aib_sfs_operation_t aib_sfs_flush(aib_sfs_handle_t handle);
aib_sfs_operation_t aib_sfs_close(aib_sfs_handle_t handle);

#ifdef __cplusplus
}
#endif

#endif
