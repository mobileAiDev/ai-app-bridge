#ifndef SFS_H
#define SFS_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#if defined(_WIN32) && defined(SFS_SHARED)
#if defined(SFS_BUILDING_LIBRARY)
#define SFS_API __declspec(dllexport)
#else
#define SFS_API __declspec(dllimport)
#endif
#else
#define SFS_API
#endif

#define SFS_FORMAT_VERSION 1u
#define SFS_SEGMENT_HEADER_SIZE 64u
#define SFS_DEFAULT_SEGMENT_SIZE (1024u * 1024u)
#define SFS_MAX_PARTITIONS 8u
#define SFS_PARTITION_ALL UINT32_MAX

typedef struct sfs_store sfs_store_t;

typedef int32_t sfs_result_t;
enum {
    SFS_OK = 0,
    SFS_END = 1,
    SFS_BUFFER_TOO_SMALL = 2,
    SFS_ERR_INVALID_ARGUMENT = -1,
    SFS_ERR_IO = -2,
    SFS_ERR_FORMAT_VERSION = -3,
    SFS_ERR_CORRUPT = -4,
    SFS_ERR_FULL = -5,
    SFS_ERR_BUSY = -6,
    SFS_ERR_NOMEM = -7,
    SFS_ERR_CLOSED = -8,
    SFS_ERR_PARTITION_DISABLED = -9
};

typedef uint32_t sfs_open_flags_t;
enum {
    SFS_OPEN_CREATE = 1u << 0
};

typedef int32_t sfs_durability_t;
enum {
    SFS_DURABILITY_MEMORY = 0,
    SFS_DURABILITY_SYNC = 1
};

typedef uint32_t sfs_status_flags_t;
enum {
    SFS_STATUS_RECOVERED_TAIL = 1u << 0
};

typedef uint32_t sfs_partition_status_flags_t;
enum {
    SFS_PARTITION_ENABLED = 1u << 0
};

typedef uint32_t sfs_record_flags_t;
enum {
    SFS_RECORD_GAP_BEFORE = 1u << 0
};

typedef struct sfs_open_options {
    uint32_t struct_size;
    uint32_t flags;
    const char *directory;
    uint64_t segment_size;
    uint64_t partition_quotas[SFS_MAX_PARTITIONS];
} sfs_open_options_t;

typedef struct sfs_cursor {
    uint32_t partition_id;
    uint32_t flags;
    uint64_t after_sequence;
    uint64_t segment_id;
    uint64_t offset;
} sfs_cursor_t;

#define SFS_CURSOR_BEGIN \
    { SFS_PARTITION_ALL, 0u, 0u, 0u, 0u }

#define SFS_CURSOR_PARTITION(partition) \
    { (partition), 0u, 0u, 0u, 0u }

typedef struct sfs_record_info {
    uint32_t struct_size;
    uint32_t payload_length;
    uint32_t partition_id;
    uint32_t flags;
    uint64_t sequence;
    uint64_t segment_id;
    uint64_t frame_offset;
    uint64_t gap_first_sequence;
    uint64_t gap_last_sequence;
} sfs_record_info_t;

typedef struct sfs_partition_status {
    uint32_t partition_id;
    uint32_t flags;
    uint64_t quota_bytes;
    uint64_t allocated_bytes;
    uint64_t segment_count;
    uint64_t first_segment_id;
    uint64_t active_segment_id;
    uint64_t active_write_offset;
    uint64_t record_count;
    uint64_t payload_bytes;
    uint64_t first_sequence;
    uint64_t last_sequence;
    uint64_t evicted_segments;
    uint64_t evicted_records;
    uint64_t evicted_payload_bytes;
} sfs_partition_status_t;

typedef struct sfs_status {
    uint32_t struct_size;
    uint32_t format_version;
    uint32_t flags;
    uint32_t reserved;
    uint64_t segment_size;
    uint64_t segment_count;
    uint64_t record_count;
    uint64_t payload_bytes;
    uint64_t next_sequence;
    uint32_t recovery_partition_id;
    uint32_t recovery_reserved;
    uint64_t recovery_segment_id;
    uint64_t recovery_offset;
    uint64_t recovery_discarded_bytes;
    sfs_partition_status_t partitions[SFS_MAX_PARTITIONS];
} sfs_status_t;

typedef struct sfs_error {
    int32_t code;
    int32_t system_code;
    char message[160];
} sfs_error_t;

SFS_API sfs_result_t sfs_open(const sfs_open_options_t *options,
                              sfs_store_t **out_store,
                              sfs_error_t *error);

SFS_API sfs_result_t sfs_append(sfs_store_t *store,
                                uint32_t partition_id,
                                const void *payload,
                                uint32_t payload_length,
                                sfs_durability_t durability,
                                sfs_record_info_t *out_record,
                                sfs_error_t *error);

SFS_API sfs_result_t sfs_scan(sfs_store_t *store,
                              sfs_cursor_t *cursor,
                              void *buffer,
                              uint32_t buffer_capacity,
                              sfs_record_info_t *out_record,
                              sfs_error_t *error);

SFS_API sfs_result_t sfs_status(sfs_store_t *store,
                                sfs_status_t *out_status,
                                sfs_error_t *error);

SFS_API sfs_result_t sfs_flush(sfs_store_t *store, sfs_error_t *error);

SFS_API sfs_result_t sfs_close(sfs_store_t *store, sfs_error_t *error);

#ifdef __cplusplus
}
#endif

#endif
