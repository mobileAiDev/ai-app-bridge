#include <node_api.h>

#include "sfs.h"

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct node_sfs_handle {
    sfs_store_t *store;
} node_sfs_handle_t;

static napi_value js_undefined(napi_env env)
{
    napi_value value;
    (void)napi_get_undefined(env, &value);
    return value;
}

static void throw_napi(napi_env env, const char *message)
{
    (void)napi_throw_error(env, "napi_error", message);
}

static const char *result_code(sfs_result_t result)
{
    switch (result) {
    case SFS_ERR_INVALID_ARGUMENT: return "sfs_invalid_argument";
    case SFS_ERR_IO: return "sfs_io";
    case SFS_ERR_FORMAT_VERSION: return "sfs_format_version";
    case SFS_ERR_CORRUPT: return "sfs_corrupt";
    case SFS_ERR_FULL: return "sfs_full";
    case SFS_ERR_BUSY: return "sfs_busy";
    case SFS_ERR_NOMEM: return "sfs_nomem";
    case SFS_ERR_CLOSED: return "sfs_closed";
    case SFS_ERR_PARTITION_DISABLED: return "sfs_partition_disabled";
    default: return "sfs_error";
    }
}

static void throw_sfs(napi_env env, sfs_result_t result, const sfs_error_t *error)
{
    char message[256];
    const char *detail = error != NULL && error->message[0] != '\0'
        ? error->message
        : "segmented fact store operation failed";
    (void)snprintf(message,
                   sizeof(message),
                   "%s (result=%d system=%d)",
                   detail,
                   (int)result,
                   error != NULL ? error->system_code : 0);
    (void)napi_throw_error(env, result_code(result), message);
}

static bool named_property(napi_env env,
                           napi_value object,
                           const char *name,
                           napi_value *out_value,
                           bool *out_present)
{
    bool present = false;
    if (napi_has_named_property(env, object, name, &present) != napi_ok) {
        throw_napi(env, "failed to inspect option property");
        return false;
    }
    *out_present = present;
    if (!present) return true;
    if (napi_get_named_property(env, object, name, out_value) != napi_ok) {
        throw_napi(env, "failed to read option property");
        return false;
    }
    return true;
}

static bool value_uint64(napi_env env, napi_value value, uint64_t *out_value)
{
    napi_valuetype type;
    if (napi_typeof(env, value, &type) != napi_ok) {
        throw_napi(env, "failed to inspect integer value");
        return false;
    }
    if (type == napi_bigint) {
        bool lossless = false;
        if (napi_get_value_bigint_uint64(env, value, out_value, &lossless) != napi_ok || !lossless) {
            throw_napi(env, "integer BigInt is outside uint64 range");
            return false;
        }
        return true;
    }
    if (type == napi_number) {
        double number = 0.0;
        if (napi_get_value_double(env, value, &number) != napi_ok
            || number < 0.0
            || number > 9007199254740991.0) {
            throw_napi(env, "integer must be a non-negative safe Number or BigInt");
            return false;
        }
        *out_value = (uint64_t)number;
        if ((double)*out_value != number) {
            throw_napi(env, "integer Number must not contain a fractional part");
            return false;
        }
        return true;
    }
    throw_napi(env, "integer must be a Number or BigInt");
    return false;
}

static bool optional_uint64(napi_env env,
                            napi_value object,
                            const char *name,
                            uint64_t fallback,
                            uint64_t *out_value)
{
    napi_value value;
    bool present;
    if (!named_property(env, object, name, &value, &present)) return false;
    if (!present) {
        *out_value = fallback;
        return true;
    }
    return value_uint64(env, value, out_value);
}

static bool optional_uint32(napi_env env,
                            napi_value object,
                            const char *name,
                            uint32_t fallback,
                            uint32_t *out_value)
{
    uint64_t value;
    if (!optional_uint64(env, object, name, fallback, &value)) return false;
    if (value > UINT32_MAX) {
        throw_napi(env, "integer exceeds uint32 range");
        return false;
    }
    *out_value = (uint32_t)value;
    return true;
}

static bool required_string(napi_env env,
                            napi_value object,
                            const char *name,
                            char **out_value)
{
    napi_value value;
    napi_valuetype type;
    bool present;
    size_t length = 0u;
    char *buffer;
    if (!named_property(env, object, name, &value, &present)) return false;
    if (!present || napi_typeof(env, value, &type) != napi_ok || type != napi_string) {
        throw_napi(env, "directory must be a non-empty string");
        return false;
    }
    if (napi_get_value_string_utf8(env, value, NULL, 0u, &length) != napi_ok || length == 0u) {
        throw_napi(env, "directory must be a non-empty string");
        return false;
    }
    buffer = (char *)malloc(length + 1u);
    if (buffer == NULL) {
        throw_napi(env, "unable to allocate directory path");
        return false;
    }
    if (napi_get_value_string_utf8(env, value, buffer, length + 1u, &length) != napi_ok) {
        free(buffer);
        throw_napi(env, "unable to decode directory path");
        return false;
    }
    *out_value = buffer;
    return true;
}

static node_sfs_handle_t *required_handle(napi_env env, napi_value value)
{
    node_sfs_handle_t *handle = NULL;
    if (napi_get_value_external(env, value, (void **)&handle) != napi_ok
        || handle == NULL
        || handle->store == NULL) {
        throw_napi(env, "segmented fact store handle is closed or invalid");
        return NULL;
    }
    return handle;
}

static void finalize_handle(napi_env env, void *data, void *hint)
{
    node_sfs_handle_t *handle = (node_sfs_handle_t *)data;
    sfs_error_t error;
    (void)env;
    (void)hint;
    if (handle == NULL) return;
    if (handle->store != NULL) {
        (void)sfs_close(handle->store, &error);
        handle->store = NULL;
    }
    free(handle);
}

static napi_value uint64_value(napi_env env, uint64_t value)
{
    napi_value result;
    if (napi_create_bigint_uint64(env, value, &result) != napi_ok) return js_undefined(env);
    return result;
}

static void set_named(napi_env env, napi_value object, const char *name, napi_value value)
{
    (void)napi_set_named_property(env, object, name, value);
}

static void set_uint32(napi_env env, napi_value object, const char *name, uint32_t value)
{
    napi_value result;
    if (napi_create_uint32(env, value, &result) == napi_ok) set_named(env, object, name, result);
}

static void set_uint64(napi_env env, napi_value object, const char *name, uint64_t value)
{
    set_named(env, object, name, uint64_value(env, value));
}

static void set_boolean(napi_env env, napi_value object, const char *name, bool value)
{
    napi_value result;
    if (napi_get_boolean(env, value, &result) == napi_ok) set_named(env, object, name, result);
}

static napi_value record_info_value(napi_env env, const sfs_record_info_t *info)
{
    napi_value object;
    (void)napi_create_object(env, &object);
    set_uint32(env, object, "payloadLength", info->payload_length);
    set_uint32(env, object, "partitionId", info->partition_id);
    set_uint32(env, object, "flags", info->flags);
    set_uint64(env, object, "sequence", info->sequence);
    set_uint64(env, object, "segmentId", info->segment_id);
    set_uint64(env, object, "frameOffset", info->frame_offset);
    set_uint64(env, object, "gapFirstSequence", info->gap_first_sequence);
    set_uint64(env, object, "gapLastSequence", info->gap_last_sequence);
    return object;
}

static napi_value cursor_value(napi_env env, const sfs_cursor_t *cursor)
{
    napi_value object;
    (void)napi_create_object(env, &object);
    set_uint32(env, object, "partitionId", cursor->partition_id);
    set_uint32(env, object, "flags", cursor->flags);
    set_uint64(env, object, "afterSequence", cursor->after_sequence);
    set_uint64(env, object, "segmentId", cursor->segment_id);
    set_uint64(env, object, "offset", cursor->offset);
    return object;
}

static bool parse_cursor(napi_env env, napi_value value, sfs_cursor_t *cursor)
{
    napi_valuetype type;
    if (napi_typeof(env, value, &type) != napi_ok || type != napi_object) {
        throw_napi(env, "cursor must be an object");
        return false;
    }
    memset(cursor, 0, sizeof(*cursor));
    if (!optional_uint32(env, value, "partitionId", SFS_PARTITION_ALL, &cursor->partition_id)) return false;
    if (!optional_uint32(env, value, "flags", 0u, &cursor->flags)) return false;
    if (!optional_uint64(env, value, "afterSequence", 0u, &cursor->after_sequence)) return false;
    if (!optional_uint64(env, value, "segmentId", 0u, &cursor->segment_id)) return false;
    if (!optional_uint64(env, value, "offset", 0u, &cursor->offset)) return false;
    return true;
}

static napi_value binding_open(napi_env env, napi_callback_info info)
{
    napi_value argv[1];
    size_t argc = 1u;
    napi_valuetype type;
    sfs_open_options_t options;
    sfs_error_t error;
    sfs_result_t result;
    sfs_store_t *store = NULL;
    node_sfs_handle_t *handle;
    napi_value external;
    napi_value quotas;
    bool quotas_present;
    bool is_array = false;
    uint32_t length = 0u;
    char *directory = NULL;

    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok
        || argc != 1u
        || napi_typeof(env, argv[0], &type) != napi_ok
        || type != napi_object) {
        throw_napi(env, "open(options) requires an object");
        return NULL;
    }
    memset(&options, 0, sizeof(options));
    options.struct_size = sizeof(options);
    options.flags = SFS_OPEN_CREATE;
    options.segment_size = SFS_DEFAULT_SEGMENT_SIZE;
    if (!required_string(env, argv[0], "directory", &directory)) return NULL;
    options.directory = directory;
    if (!optional_uint64(env, argv[0], "segmentSize", options.segment_size, &options.segment_size)) {
        free(directory);
        return NULL;
    }
    if (!named_property(env, argv[0], "partitionQuotas", &quotas, &quotas_present)) {
        free(directory);
        return NULL;
    }
    if (quotas_present) {
        if (napi_is_array(env, quotas, &is_array) != napi_ok || !is_array
            || napi_get_array_length(env, quotas, &length) != napi_ok
            || length > SFS_MAX_PARTITIONS) {
            free(directory);
            throw_napi(env, "partitionQuotas must be an array with at most eight entries");
            return NULL;
        }
        for (uint32_t index = 0u; index < length; index += 1u) {
            napi_value value;
            if (napi_get_element(env, quotas, index, &value) != napi_ok
                || !value_uint64(env, value, &options.partition_quotas[index])) {
                free(directory);
                return NULL;
            }
        }
    }
    result = sfs_open(&options, &store, &error);
    free(directory);
    if (result != SFS_OK) {
        throw_sfs(env, result, &error);
        return NULL;
    }
    handle = (node_sfs_handle_t *)calloc(1u, sizeof(*handle));
    if (handle == NULL) {
        (void)sfs_close(store, &error);
        throw_napi(env, "unable to allocate native handle");
        return NULL;
    }
    handle->store = store;
    if (napi_create_external(env, handle, finalize_handle, NULL, &external) != napi_ok) {
        finalize_handle(env, handle, NULL);
        throw_napi(env, "unable to create native handle");
        return NULL;
    }
    return external;
}

static napi_value binding_append(napi_env env, napi_callback_info info)
{
    napi_value argv[4];
    size_t argc = 4u;
    node_sfs_handle_t *handle;
    uint64_t partition_value;
    bool is_buffer = false;
    void *payload = NULL;
    size_t payload_length = 0u;
    bool sync = false;
    sfs_record_info_t record;
    sfs_error_t error;
    sfs_result_t result;

    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 3u) {
        throw_napi(env, "append(handle, partitionId, buffer, sync?) requires three arguments");
        return NULL;
    }
    handle = required_handle(env, argv[0]);
    if (handle == NULL || !value_uint64(env, argv[1], &partition_value)) return NULL;
    if (partition_value >= SFS_MAX_PARTITIONS) {
        throw_napi(env, "partitionId must be between 0 and 7");
        return NULL;
    }
    if (napi_is_buffer(env, argv[2], &is_buffer) != napi_ok || !is_buffer
        || napi_get_buffer_info(env, argv[2], &payload, &payload_length) != napi_ok
        || payload_length > UINT32_MAX) {
        throw_napi(env, "payload must be a Buffer no larger than uint32");
        return NULL;
    }
    if (argc >= 4u && napi_get_value_bool(env, argv[3], &sync) != napi_ok) {
        throw_napi(env, "sync must be a boolean");
        return NULL;
    }
    memset(&record, 0, sizeof(record));
    record.struct_size = sizeof(record);
    result = sfs_append(handle->store,
                        (uint32_t)partition_value,
                        payload,
                        (uint32_t)payload_length,
                        sync ? SFS_DURABILITY_SYNC : SFS_DURABILITY_MEMORY,
                        &record,
                        &error);
    if (result != SFS_OK) {
        throw_sfs(env, result, &error);
        return NULL;
    }
    return record_info_value(env, &record);
}

static napi_value binding_scan(napi_env env, napi_callback_info info)
{
    napi_value argv[2];
    size_t argc = 2u;
    node_sfs_handle_t *handle;
    sfs_cursor_t cursor;
    sfs_record_info_t record;
    sfs_error_t error;
    sfs_result_t result;
    napi_value object;
    napi_value payload;
    void *buffer = NULL;
    uint32_t required_length = 0u;

    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 2u) {
        throw_napi(env, "scan(handle, cursor) requires two arguments");
        return NULL;
    }
    handle = required_handle(env, argv[0]);
    if (handle == NULL || !parse_cursor(env, argv[1], &cursor)) return NULL;
    memset(&record, 0, sizeof(record));
    record.struct_size = sizeof(record);
    result = sfs_scan(handle->store, &cursor, NULL, 0u, &record, &error);
    if (result == SFS_END) {
        (void)napi_create_object(env, &object);
        set_boolean(env, object, "done", true);
        set_named(env, object, "cursor", cursor_value(env, &cursor));
        return object;
    }
    if (result != SFS_BUFFER_TOO_SMALL && result != SFS_OK) {
        throw_sfs(env, result, &error);
        return NULL;
    }
    required_length = record.payload_length;
    if (required_length > 0u) {
        if (napi_create_buffer(env, required_length, &buffer, &payload) != napi_ok) {
            throw_napi(env, "unable to allocate scan buffer");
            return NULL;
        }
        memset(&record, 0, sizeof(record));
        record.struct_size = sizeof(record);
        result = sfs_scan(handle->store,
                          &cursor,
                          buffer,
                          required_length,
                          &record,
                          &error);
        if (result != SFS_OK) {
            throw_sfs(env, result, &error);
            return NULL;
        }
    } else {
        if (napi_create_buffer(env, 0u, &buffer, &payload) != napi_ok) {
            throw_napi(env, "unable to create empty scan buffer");
            return NULL;
        }
    }
    (void)napi_create_object(env, &object);
    set_boolean(env, object, "done", false);
    set_named(env, object, "payload", payload);
    set_named(env, object, "record", record_info_value(env, &record));
    set_named(env, object, "cursor", cursor_value(env, &cursor));
    return object;
}

static napi_value partition_status_value(napi_env env, const sfs_partition_status_t *status)
{
    napi_value object;
    (void)napi_create_object(env, &object);
    set_uint32(env, object, "partitionId", status->partition_id);
    set_uint32(env, object, "flags", status->flags);
    set_boolean(env, object, "enabled", (status->flags & SFS_PARTITION_ENABLED) != 0u);
    set_uint64(env, object, "quotaBytes", status->quota_bytes);
    set_uint64(env, object, "allocatedBytes", status->allocated_bytes);
    set_uint64(env, object, "segmentCount", status->segment_count);
    set_uint64(env, object, "firstSegmentId", status->first_segment_id);
    set_uint64(env, object, "activeSegmentId", status->active_segment_id);
    set_uint64(env, object, "activeWriteOffset", status->active_write_offset);
    set_uint64(env, object, "recordCount", status->record_count);
    set_uint64(env, object, "payloadBytes", status->payload_bytes);
    set_uint64(env, object, "firstSequence", status->first_sequence);
    set_uint64(env, object, "lastSequence", status->last_sequence);
    set_uint64(env, object, "evictedSegments", status->evicted_segments);
    set_uint64(env, object, "evictedRecords", status->evicted_records);
    set_uint64(env, object, "evictedPayloadBytes", status->evicted_payload_bytes);
    return object;
}

static napi_value binding_status(napi_env env, napi_callback_info info)
{
    napi_value argv[1];
    size_t argc = 1u;
    node_sfs_handle_t *handle;
    sfs_status_t status;
    sfs_error_t error;
    sfs_result_t result;
    napi_value object;
    napi_value partitions;

    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1u) {
        throw_napi(env, "status(handle) requires one argument");
        return NULL;
    }
    handle = required_handle(env, argv[0]);
    if (handle == NULL) return NULL;
    memset(&status, 0, sizeof(status));
    status.struct_size = sizeof(status);
    result = sfs_status(handle->store, &status, &error);
    if (result != SFS_OK) {
        throw_sfs(env, result, &error);
        return NULL;
    }
    (void)napi_create_object(env, &object);
    set_uint32(env, object, "formatVersion", status.format_version);
    set_uint32(env, object, "flags", status.flags);
    set_boolean(env, object, "recoveredTail", (status.flags & SFS_STATUS_RECOVERED_TAIL) != 0u);
    set_uint64(env, object, "segmentSize", status.segment_size);
    set_uint64(env, object, "segmentCount", status.segment_count);
    set_uint64(env, object, "recordCount", status.record_count);
    set_uint64(env, object, "payloadBytes", status.payload_bytes);
    set_uint64(env, object, "nextSequence", status.next_sequence);
    set_uint32(env, object, "recoveryPartitionId", status.recovery_partition_id);
    set_uint64(env, object, "recoverySegmentId", status.recovery_segment_id);
    set_uint64(env, object, "recoveryOffset", status.recovery_offset);
    set_uint64(env, object, "recoveryDiscardedBytes", status.recovery_discarded_bytes);
    (void)napi_create_array_with_length(env, SFS_MAX_PARTITIONS, &partitions);
    for (uint32_t index = 0u; index < SFS_MAX_PARTITIONS; index += 1u) {
        (void)napi_set_element(env, partitions, index, partition_status_value(env, &status.partitions[index]));
    }
    set_named(env, object, "partitions", partitions);
    return object;
}

static napi_value binding_flush(napi_env env, napi_callback_info info)
{
    napi_value argv[1];
    size_t argc = 1u;
    node_sfs_handle_t *handle;
    sfs_error_t error;
    sfs_result_t result;
    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1u) {
        throw_napi(env, "flush(handle) requires one argument");
        return NULL;
    }
    handle = required_handle(env, argv[0]);
    if (handle == NULL) return NULL;
    result = sfs_flush(handle->store, &error);
    if (result != SFS_OK) {
        throw_sfs(env, result, &error);
        return NULL;
    }
    return js_undefined(env);
}

static napi_value binding_close(napi_env env, napi_callback_info info)
{
    napi_value argv[1];
    size_t argc = 1u;
    node_sfs_handle_t *handle = NULL;
    sfs_error_t error;
    sfs_result_t result;
    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1u
        || napi_get_value_external(env, argv[0], (void **)&handle) != napi_ok || handle == NULL) {
        throw_napi(env, "close(handle) requires a native handle");
        return NULL;
    }
    if (handle->store == NULL) return js_undefined(env);
    result = sfs_close(handle->store, &error);
    if (result != SFS_OK) {
        throw_sfs(env, result, &error);
        return NULL;
    }
    handle->store = NULL;
    return js_undefined(env);
}

static napi_value initialize(napi_env env, napi_value exports)
{
    napi_property_descriptor properties[] = {
        {"open", NULL, binding_open, NULL, NULL, NULL, napi_default, NULL},
        {"append", NULL, binding_append, NULL, NULL, NULL, napi_default, NULL},
        {"scan", NULL, binding_scan, NULL, NULL, NULL, napi_default, NULL},
        {"status", NULL, binding_status, NULL, NULL, NULL, napi_default, NULL},
        {"flush", NULL, binding_flush, NULL, NULL, NULL, napi_default, NULL},
        {"close", NULL, binding_close, NULL, NULL, NULL, napi_default, NULL},
    };
    if (napi_define_properties(env,
                               exports,
                               sizeof(properties) / sizeof(properties[0]),
                               properties) != napi_ok) {
        throw_napi(env, "unable to initialize segmented fact store binding");
        return NULL;
    }
    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
