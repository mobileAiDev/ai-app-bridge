#include "AiAppBridgeFactStoreC.h"

#include "sfs.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

static aib_sfs_operation_t operation(sfs_result_t result,
                                     const sfs_error_t *error)
{
    aib_sfs_operation_t value;
    (void)memset(&value, 0, sizeof(value));
    value.code = (int32_t)result;
    if (error != NULL) {
        value.system_code = error->system_code;
        (void)strncpy(value.message,
                      error->message,
                      sizeof(value.message) - 1u);
        value.message[sizeof(value.message) - 1u] = '\0';
    }
    return value;
}

aib_sfs_open_result_t aib_sfs_open(const char *directory,
                                   uint64_t segment_size,
                                   uint32_t flags,
                                   const uint64_t *partition_quotas,
                                   uint32_t partition_quota_count)
{
    aib_sfs_open_result_t value;
    sfs_open_options_t options;
    sfs_error_t error;
    sfs_store_t *store = NULL;
    sfs_result_t result;
    uint32_t index;

    (void)memset(&value, 0, sizeof(value));
    (void)memset(&options, 0, sizeof(options));
    (void)memset(&error, 0, sizeof(error));
    if (partition_quota_count > SFS_MAX_PARTITIONS ||
        (partition_quota_count > 0u && partition_quotas == NULL)) {
        value.operation.code = SFS_ERR_INVALID_ARGUMENT;
        return value;
    }
    options.struct_size = (uint32_t)sizeof(options);
    options.flags = flags;
    options.directory = directory;
    options.segment_size = segment_size;
    for (index = 0u; index < partition_quota_count; index += 1u) {
        options.partition_quotas[index] = partition_quotas[index];
    }
    result = sfs_open(&options, &store, &error);
    value.operation = operation(result, &error);
    value.handle = (aib_sfs_handle_t)(uintptr_t)store;
    return value;
}

aib_sfs_append_result_t aib_sfs_append(aib_sfs_handle_t handle,
                                       uint32_t partition_id,
                                       const void *payload,
                                       uint32_t payload_length,
                                       int32_t durability)
{
    aib_sfs_append_result_t value;
    sfs_record_info_t record;
    sfs_error_t error;
    sfs_result_t result;

    (void)memset(&value, 0, sizeof(value));
    (void)memset(&record, 0, sizeof(record));
    (void)memset(&error, 0, sizeof(error));
    record.struct_size = (uint32_t)sizeof(record);
    result = sfs_append((sfs_store_t *)(uintptr_t)handle,
                        partition_id,
                        payload,
                        payload_length,
                        (sfs_durability_t)durability,
                        &record,
                        &error);
    value.operation = operation(result, &error);
    value.payload_length = record.payload_length;
    value.partition_id = record.partition_id;
    value.sequence = record.sequence;
    value.segment_id = record.segment_id;
    value.frame_offset = record.frame_offset;
    return value;
}

aib_sfs_read_result_t aib_sfs_read(aib_sfs_handle_t handle,
                                   uint32_t cursor_partition_id,
                                   uint32_t cursor_flags,
                                   uint64_t cursor_after_sequence,
                                   uint64_t cursor_segment_id,
                                   uint64_t cursor_offset,
                                   void *buffer,
                                   uint32_t buffer_capacity)
{
    aib_sfs_read_result_t value;
    sfs_cursor_t cursor;
    sfs_record_info_t record;
    sfs_error_t error;
    sfs_result_t result;

    (void)memset(&value, 0, sizeof(value));
    (void)memset(&cursor, 0, sizeof(cursor));
    (void)memset(&record, 0, sizeof(record));
    (void)memset(&error, 0, sizeof(error));
    cursor.partition_id = cursor_partition_id;
    cursor.flags = cursor_flags;
    cursor.after_sequence = cursor_after_sequence;
    cursor.segment_id = cursor_segment_id;
    cursor.offset = cursor_offset;
    record.struct_size = (uint32_t)sizeof(record);
    result = sfs_scan((sfs_store_t *)(uintptr_t)handle,
                      &cursor,
                      buffer,
                      buffer_capacity,
                      &record,
                      &error);
    value.operation = operation(result, &error);
    value.cursor_partition_id = cursor.partition_id;
    value.cursor_flags = cursor.flags;
    value.cursor_after_sequence = cursor.after_sequence;
    value.cursor_segment_id = cursor.segment_id;
    value.cursor_offset = cursor.offset;
    value.payload_length = record.payload_length;
    value.record_partition_id = record.partition_id;
    value.record_flags = record.flags;
    value.sequence = record.sequence;
    value.record_segment_id = record.segment_id;
    value.frame_offset = record.frame_offset;
    value.gap_first_sequence = record.gap_first_sequence;
    value.gap_last_sequence = record.gap_last_sequence;
    return value;
}

aib_sfs_status_result_t aib_sfs_get_status(aib_sfs_handle_t handle)
{
    aib_sfs_status_result_t value;
    sfs_status_t status;
    sfs_error_t error;
    sfs_result_t result;

    (void)memset(&value, 0, sizeof(value));
    (void)memset(&status, 0, sizeof(status));
    (void)memset(&error, 0, sizeof(error));
    status.struct_size = (uint32_t)sizeof(status);
    result = sfs_status((sfs_store_t *)(uintptr_t)handle, &status, &error);
    value.operation = operation(result, &error);
    value.format_version = status.format_version;
    value.flags = status.flags;
    value.segment_size = status.segment_size;
    value.segment_count = status.segment_count;
    value.record_count = status.record_count;
    value.payload_bytes = status.payload_bytes;
    value.next_sequence = status.next_sequence;
    value.recovery_partition_id = status.recovery_partition_id;
    value.recovery_segment_id = status.recovery_segment_id;
    value.recovery_offset = status.recovery_offset;
    value.recovery_discarded_bytes = status.recovery_discarded_bytes;
    {
        uint32_t partition_id;
        for (partition_id = 0u; partition_id < SFS_MAX_PARTITIONS;
             partition_id += 1u) {
            const sfs_partition_status_t *partition =
                &status.partitions[partition_id];
            value.partition_quotas[partition_id] = partition->quota_bytes;
            if ((partition->flags & SFS_PARTITION_ENABLED) == 0u) {
                continue;
            }
            if (partition->first_segment_id != 0u &&
                (value.first_segment_id == 0u ||
                 partition->first_segment_id < value.first_segment_id)) {
                value.first_segment_id = partition->first_segment_id;
            }
            if (partition->active_segment_id > value.active_segment_id) {
                value.active_segment_id = partition->active_segment_id;
            }
            if (partition->active_write_offset > value.active_write_offset) {
                value.active_write_offset = partition->active_write_offset;
            }
        }
    }
    return value;
}

aib_sfs_operation_t aib_sfs_flush(aib_sfs_handle_t handle)
{
    sfs_error_t error;
    sfs_result_t result;
    (void)memset(&error, 0, sizeof(error));
    result = sfs_flush((sfs_store_t *)(uintptr_t)handle, &error);
    return operation(result, &error);
}

aib_sfs_operation_t aib_sfs_close(aib_sfs_handle_t handle)
{
    sfs_error_t error;
    sfs_result_t result;
    (void)memset(&error, 0, sizeof(error));
    result = sfs_close((sfs_store_t *)(uintptr_t)handle, &error);
    return operation(result, &error);
}
