#define _DARWIN_C_SOURCE
#define _POSIX_C_SOURCE 200809L

#include "sfs.h"

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#define TEST_SEGMENT_SIZE 256u

static int failures = 0;

#define CHECK(condition)                                                         \
    do {                                                                         \
        if (!(condition)) {                                                       \
            (void)fprintf(stderr, "%s:%d: CHECK failed: %s\n",                  \
                          __FILE__,                                               \
                          __LINE__,                                               \
                          #condition);                                            \
            failures += 1;                                                        \
            return;                                                               \
        }                                                                         \
    } while (0)

static char *make_temp_directory(void)
{
    char *path = strdup("/tmp/sfs-test-XXXXXX");
    int descriptor;
    if (path == NULL) {
        return NULL;
    }
    descriptor = mkstemp(path);
    if (descriptor < 0) {
        free(path);
        return NULL;
    }
    (void)close(descriptor);
    if (unlink(path) != 0 || mkdir(path, 0700) != 0) {
        free(path);
        return NULL;
    }
    return path;
}

static void remove_tree(const char *path)
{
    DIR *directory;
    struct dirent *entry;
    directory = opendir(path);
    if (directory != NULL) {
        while ((entry = readdir(directory)) != NULL) {
            char child[1024];
            struct stat status;
            if (strcmp(entry->d_name, ".") == 0 ||
                strcmp(entry->d_name, "..") == 0) {
                continue;
            }
            (void)snprintf(child, sizeof(child), "%s/%s", path, entry->d_name);
            if (lstat(child, &status) == 0 && S_ISDIR(status.st_mode)) {
                remove_tree(child);
            } else {
                (void)unlink(child);
            }
        }
        (void)closedir(directory);
    }
    (void)rmdir(path);
}

static void remove_temp_directory(char *path)
{
    if (path == NULL) {
        return;
    }
    remove_tree(path);
    free(path);
}

static sfs_store_t *open_store_with_quota(const char *directory,
                                          uint64_t segment_size,
                                          uint64_t quota)
{
    sfs_open_options_t options;
    sfs_error_t error;
    sfs_store_t *store = NULL;
    sfs_result_t result;

    memset(&options, 0, sizeof(options));
    options.struct_size = sizeof(options);
    options.flags = SFS_OPEN_CREATE;
    options.directory = directory;
    options.segment_size = segment_size;
    options.partition_quotas[0] = quota;
    result = sfs_open(&options, &store, &error);
    if (result != SFS_OK) {
        (void)fprintf(stderr,
                      "sfs_open failed: result=%d system=%d message=%s\n",
                      result,
                      error.system_code,
                      error.message);
    }
    return store;
}

static sfs_store_t *open_store(const char *directory, uint64_t segment_size)
{
    return open_store_with_quota(directory, segment_size, segment_size * 4u);
}

static sfs_store_t *open_two_partition_store(const char *directory,
                                             uint64_t segment_size)
{
    sfs_open_options_t options;
    sfs_error_t error;
    sfs_store_t *store = NULL;
    sfs_result_t result;

    memset(&options, 0, sizeof(options));
    options.struct_size = sizeof(options);
    options.flags = SFS_OPEN_CREATE;
    options.directory = directory;
    options.segment_size = segment_size;
    options.partition_quotas[0] = segment_size * 4u;
    options.partition_quotas[1] = segment_size * 4u;
    result = sfs_open(&options, &store, &error);
    if (result != SFS_OK) {
        (void)fprintf(stderr,
                      "sfs_open failed: result=%d system=%d message=%s\n",
                      result,
                      error.system_code,
                      error.message);
    }
    return store;
}

static sfs_result_t append_payload(sfs_store_t *store,
                                   uint32_t partition_id,
                                   const void *payload,
                                   uint32_t payload_length,
                                   sfs_durability_t durability,
                                   uint64_t *out_sequence,
                                   sfs_error_t *error)
{
    sfs_record_info_t receipt;
    sfs_result_t result;
    memset(&receipt, 0, sizeof(receipt));
    receipt.struct_size = sizeof(receipt);
    result = sfs_append(store,
                        partition_id,
                        payload,
                        payload_length,
                        durability,
                        &receipt,
                        error);
    if (out_sequence != NULL) {
        *out_sequence = result == SFS_OK ? receipt.sequence : 0u;
    }
    return result;
}

static void first_segment_path(char *buffer,
                               size_t buffer_size,
                               const char *directory)
{
    (void)snprintf(buffer,
                   buffer_size,
                   "%s/partition-0/segment-00000000000000000001.sfs",
                   directory);
}

static void test_append_scan_and_status(void)
{
    static const uint8_t first[] = {0x61u, 0x00u, 0x62u};
    static const uint8_t second[] = {0x10u, 0x20u, 0x30u, 0x40u};
    char *directory = make_temp_directory();
    sfs_store_t *store;
    sfs_cursor_t cursor = SFS_CURSOR_BEGIN;
    sfs_record_info_t record;
    sfs_status_t status;
    sfs_error_t error;
    uint8_t buffer[16];
    uint64_t sequence = 0u;

    CHECK(directory != NULL);
    store = open_store(directory, TEST_SEGMENT_SIZE);
    CHECK(store != NULL);

    CHECK(append_payload(store,
                     0u,
                     first,
                     (uint32_t)sizeof(first),
                     SFS_DURABILITY_MEMORY,
                     &sequence,
                     &error) == SFS_OK);
    CHECK(sequence == 1u);
    CHECK(append_payload(store,
                     0u,
                     second,
                     (uint32_t)sizeof(second),
                     SFS_DURABILITY_SYNC,
                     &sequence,
                     &error) == SFS_OK);
    CHECK(sequence == 2u);

    memset(&status, 0, sizeof(status));
    status.struct_size = sizeof(status);
    CHECK(sfs_status(store, &status, &error) == SFS_OK);
    CHECK(status.format_version == SFS_FORMAT_VERSION);
    CHECK(status.segment_size == TEST_SEGMENT_SIZE);
    CHECK(status.segment_count == 1u);
    CHECK(status.record_count == 2u);
    CHECK(status.payload_bytes == sizeof(first) + sizeof(second));
    CHECK(status.next_sequence == 3u);
    CHECK(status.partitions[0].flags == SFS_PARTITION_ENABLED);
    CHECK(status.partitions[0].first_segment_id == 1u);
    CHECK(status.partitions[0].active_segment_id == 1u);

    memset(&record, 0, sizeof(record));
    record.struct_size = sizeof(record);
    CHECK(sfs_scan(store, &cursor, buffer, sizeof(buffer), &record, &error) ==
          SFS_OK);
    CHECK(record.sequence == 1u);
    CHECK(record.partition_id == 0u);
    CHECK(record.segment_id == 1u);
    CHECK(record.frame_offset == SFS_SEGMENT_HEADER_SIZE);
    CHECK(record.payload_length == sizeof(first));
    CHECK(memcmp(buffer, first, sizeof(first)) == 0);

    record.struct_size = sizeof(record);
    CHECK(sfs_scan(store, &cursor, buffer, sizeof(buffer), &record, &error) ==
          SFS_OK);
    CHECK(record.sequence == 2u);
    CHECK(record.payload_length == sizeof(second));
    CHECK(memcmp(buffer, second, sizeof(second)) == 0);

    record.struct_size = sizeof(record);
    CHECK(sfs_scan(store, &cursor, buffer, sizeof(buffer), &record, &error) ==
          SFS_END);
    CHECK(sfs_flush(store, &error) == SFS_OK);
    CHECK(sfs_close(store, &error) == SFS_OK);
    remove_temp_directory(directory);
}

static void test_repeated_reopen_preserves_records_and_sequence(void)
{
    static const uint8_t first[] = {0x01u, 0x02u, 0x03u};
    static const uint8_t second[] = {0xf0u, 0x00u, 0x0fu};
    char *directory = make_temp_directory();
    sfs_store_t *store;
    sfs_status_t status;
    sfs_error_t error;
    sfs_cursor_t cursor = SFS_CURSOR_BEGIN;
    sfs_record_info_t record;
    uint8_t buffer[8];
    uint64_t sequence;
    int reopen_index;

    CHECK(directory != NULL);
    store = open_store(directory, TEST_SEGMENT_SIZE);
    CHECK(store != NULL);
    CHECK(append_payload(store,
                     0u,
                     first,
                     sizeof(first),
                     SFS_DURABILITY_SYNC,
                     &sequence,
                     &error) == SFS_OK);
    CHECK(sequence == 1u);
    CHECK(sfs_close(store, &error) == SFS_OK);

    for (reopen_index = 0; reopen_index < 5; ++reopen_index) {
        store = open_store(directory, TEST_SEGMENT_SIZE);
        CHECK(store != NULL);
        memset(&status, 0, sizeof(status));
        status.struct_size = sizeof(status);
        CHECK(sfs_status(store, &status, &error) == SFS_OK);
        CHECK(status.record_count == 1u);
        CHECK(status.next_sequence == 2u);
        CHECK(sfs_close(store, &error) == SFS_OK);
    }

    store = open_store(directory, TEST_SEGMENT_SIZE);
    CHECK(store != NULL);
    CHECK(append_payload(store,
                     0u,
                     second,
                     sizeof(second),
                     SFS_DURABILITY_SYNC,
                     &sequence,
                     &error) == SFS_OK);
    CHECK(sequence == 2u);
    CHECK(sfs_close(store, &error) == SFS_OK);

    store = open_store(directory, TEST_SEGMENT_SIZE);
    CHECK(store != NULL);
    memset(&record, 0, sizeof(record));
    record.struct_size = sizeof(record);
    CHECK(sfs_scan(store, &cursor, buffer, sizeof(buffer), &record, &error) ==
          SFS_OK);
    CHECK(record.sequence == 1u);
    CHECK(memcmp(buffer, first, sizeof(first)) == 0);
    record.struct_size = sizeof(record);
    CHECK(sfs_scan(store, &cursor, buffer, sizeof(buffer), &record, &error) ==
          SFS_OK);
    CHECK(record.sequence == 2u);
    CHECK(memcmp(buffer, second, sizeof(second)) == 0);
    record.struct_size = sizeof(record);
    CHECK(sfs_scan(store, &cursor, buffer, sizeof(buffer), &record, &error) ==
          SFS_END);

    CHECK(sfs_close(store, &error) == SFS_OK);
    remove_temp_directory(directory);
}

static void test_sealed_segment_accepts_short_zero_tail(void)
{
    uint8_t almost_full_payload[144];
    static const uint8_t next_segment_payload[] = {0x7au};
    char *directory = make_temp_directory();
    sfs_store_t *store;
    sfs_status_t status;
    sfs_error_t error;
    uint64_t sequence;

    CHECK(directory != NULL);
    memset(almost_full_payload, 0x5au, sizeof(almost_full_payload));
    store = open_store(directory, TEST_SEGMENT_SIZE);
    CHECK(store != NULL);

    /*
     * A 144-byte payload occupies a 176-byte frame. Starting after the
     * 64-byte segment header, that leaves 16 zero bytes: too short for the
     * next 24-byte frame prefix, but still a clean end-of-segment tail.
     */
    CHECK(append_payload(store,
                         0u,
                         almost_full_payload,
                         sizeof(almost_full_payload),
                         SFS_DURABILITY_SYNC,
                         &sequence,
                         &error) == SFS_OK);
    CHECK(sequence == 1u);
    CHECK(append_payload(store,
                         0u,
                         next_segment_payload,
                         sizeof(next_segment_payload),
                         SFS_DURABILITY_SYNC,
                         &sequence,
                         &error) == SFS_OK);
    CHECK(sequence == 2u);
    CHECK(sfs_close(store, &error) == SFS_OK);

    store = open_store(directory, TEST_SEGMENT_SIZE);
    CHECK(store != NULL);
    memset(&status, 0, sizeof(status));
    status.struct_size = sizeof(status);
    CHECK(sfs_status(store, &status, &error) == SFS_OK);
    CHECK(status.segment_count == 2u);
    CHECK(status.record_count == 2u);
    CHECK(status.next_sequence == 3u);
    CHECK(sfs_close(store, &error) == SFS_OK);
    remove_temp_directory(directory);
}

static void test_sealed_segment_rejects_short_nonzero_tail(void)
{
    uint8_t almost_full_payload[144];
    static const uint8_t next_segment_payload[] = {0x7au};
    static const uint8_t torn_byte = 0x01u;
    char *directory = make_temp_directory();
    char segment_path[1024];
    sfs_store_t *store;
    sfs_open_options_t options;
    sfs_error_t error;
    sfs_result_t result;
    uint64_t sequence;
    int descriptor;

    CHECK(directory != NULL);
    memset(almost_full_payload, 0x5au, sizeof(almost_full_payload));
    store = open_store(directory, TEST_SEGMENT_SIZE);
    CHECK(store != NULL);
    CHECK(append_payload(store,
                         0u,
                         almost_full_payload,
                         sizeof(almost_full_payload),
                         SFS_DURABILITY_SYNC,
                         &sequence,
                         &error) == SFS_OK);
    CHECK(append_payload(store,
                         0u,
                         next_segment_payload,
                         sizeof(next_segment_payload),
                         SFS_DURABILITY_SYNC,
                         &sequence,
                         &error) == SFS_OK);
    CHECK(sfs_close(store, &error) == SFS_OK);

    first_segment_path(segment_path, sizeof(segment_path), directory);
    descriptor = open(segment_path, O_RDWR);
    CHECK(descriptor >= 0);
    CHECK(pwrite(descriptor, &torn_byte, 1u, TEST_SEGMENT_SIZE - 1u) == 1);
    CHECK(fsync(descriptor) == 0);
    CHECK(close(descriptor) == 0);

    memset(&options, 0, sizeof(options));
    options.struct_size = sizeof(options);
    options.flags = SFS_OPEN_CREATE;
    options.directory = directory;
    options.segment_size = TEST_SEGMENT_SIZE;
    options.partition_quotas[0] = TEST_SEGMENT_SIZE * 4u;
    store = NULL;
    result = sfs_open(&options, &store, &error);
    CHECK(result == SFS_ERR_CORRUPT);
    CHECK(store == NULL);
    CHECK(strstr(error.message, "torn tail") != NULL);
    remove_temp_directory(directory);
}

static void test_every_tail_truncation_recovers_to_last_committed_frame(void)
{
    static const uint8_t first[] = {
        0x10u, 0x11u, 0x12u, 0x13u, 0x14u, 0x15u, 0x16u};
    static const uint8_t second[] = {
        0x20u, 0x21u, 0x22u, 0x23u, 0x24u, 0x25u, 0x26u, 0x27u, 0x28u,
        0x29u, 0x2au, 0x2bu, 0x2cu, 0x2du, 0x2eu, 0x2fu, 0x30u};
    static const uint8_t after_recovery[] = {0xaau, 0x55u};
    const off_t first_frame_end = 104;
    const off_t second_frame_end = 160;
    off_t cut;

    for (cut = first_frame_end; cut <= second_frame_end; ++cut) {
        char *directory = make_temp_directory();
        char segment_path[1024];
        sfs_store_t *store;
        sfs_status_t status;
        sfs_cursor_t cursor = SFS_CURSOR_BEGIN;
        sfs_record_info_t record;
        sfs_error_t error;
        uint8_t buffer[32];
        uint64_t sequence;
        uint64_t expected_records = cut == second_frame_end ? 2u : 1u;

        CHECK(directory != NULL);
        store = open_store(directory, TEST_SEGMENT_SIZE);
        CHECK(store != NULL);
        CHECK(append_payload(store,
                         0u,
                         first,
                         sizeof(first),
                         SFS_DURABILITY_SYNC,
                         &sequence,
                         &error) == SFS_OK);
        CHECK(append_payload(store,
                         0u,
                         second,
                         sizeof(second),
                         SFS_DURABILITY_SYNC,
                         &sequence,
                         &error) == SFS_OK);
        CHECK(sfs_close(store, &error) == SFS_OK);

        first_segment_path(segment_path, sizeof(segment_path), directory);
        CHECK(truncate(segment_path, cut) == 0);
        store = open_store(directory, TEST_SEGMENT_SIZE);
        CHECK(store != NULL);
        memset(&status, 0, sizeof(status));
        status.struct_size = sizeof(status);
        CHECK(sfs_status(store, &status, &error) == SFS_OK);
        CHECK((status.flags & SFS_STATUS_RECOVERED_TAIL) != 0u);
        CHECK(status.record_count == expected_records);
        CHECK(status.recovery_partition_id == 0u);
        CHECK(status.recovery_segment_id == 1u);
        CHECK(status.recovery_offset ==
              (cut == second_frame_end ? (uint64_t)second_frame_end
                                       : (uint64_t)first_frame_end));

        memset(&record, 0, sizeof(record));
        record.struct_size = sizeof(record);
        CHECK(sfs_scan(store, &cursor, buffer, sizeof(buffer), &record, &error) ==
              SFS_OK);
        CHECK(record.sequence == 1u);
        CHECK(memcmp(buffer, first, sizeof(first)) == 0);
        record.struct_size = sizeof(record);
        if (cut == second_frame_end) {
            CHECK(sfs_scan(store,
                           &cursor,
                           buffer,
                           sizeof(buffer),
                           &record,
                           &error) == SFS_OK);
            CHECK(record.sequence == 2u);
            CHECK(memcmp(buffer, second, sizeof(second)) == 0);
            record.struct_size = sizeof(record);
        }
        CHECK(sfs_scan(store, &cursor, buffer, sizeof(buffer), &record, &error) ==
              SFS_END);
        CHECK(append_payload(store,
                         0u,
                         after_recovery,
                         sizeof(after_recovery),
                         SFS_DURABILITY_SYNC,
                         &sequence,
                         &error) == SFS_OK);
        CHECK(sequence == 3u);
        CHECK(sfs_close(store, &error) == SFS_OK);
        remove_temp_directory(directory);
    }
}

static void test_committed_payload_crc_corruption_is_rejected(void)
{
    static const uint8_t payload[] = {0xdeu, 0xadu, 0xbeu, 0xefu};
    char *directory = make_temp_directory();
    char segment_path[1024];
    sfs_store_t *store;
    sfs_open_options_t options;
    sfs_error_t error;
    sfs_result_t result;
    uint64_t sequence;
    uint8_t byte;
    int descriptor;

    CHECK(directory != NULL);
    store = open_store(directory, TEST_SEGMENT_SIZE);
    CHECK(store != NULL);
    CHECK(append_payload(store,
                     0u,
                     payload,
                     sizeof(payload),
                     SFS_DURABILITY_SYNC,
                     &sequence,
                     &error) == SFS_OK);
    CHECK(sfs_close(store, &error) == SFS_OK);

    first_segment_path(segment_path, sizeof(segment_path), directory);
    descriptor = open(segment_path, O_RDWR);
    CHECK(descriptor >= 0);
    CHECK(pread(descriptor, &byte, 1u, 88) == 1);
    byte ^= 0x80u;
    CHECK(pwrite(descriptor, &byte, 1u, 88) == 1);
    CHECK(fsync(descriptor) == 0);
    CHECK(close(descriptor) == 0);

    memset(&options, 0, sizeof(options));
    options.struct_size = sizeof(options);
    options.flags = SFS_OPEN_CREATE;
    options.directory = directory;
    options.segment_size = TEST_SEGMENT_SIZE;
    options.partition_quotas[0] = TEST_SEGMENT_SIZE * 4u;
    store = NULL;
    result = sfs_open(&options, &store, &error);
    CHECK(result == SFS_ERR_CORRUPT);
    CHECK(store == NULL);
    CHECK(error.code == SFS_ERR_CORRUPT);
    CHECK(strstr(error.message, "CRC32C") != NULL);
    remove_temp_directory(directory);
}

static void test_committed_header_length_corruption_is_not_recovered_as_torn(void)
{
    uint8_t payload[17];
    char *directory = make_temp_directory();
    char segment_path[1024];
    sfs_store_t *store;
    sfs_open_options_t options;
    sfs_error_t error;
    sfs_result_t result;
    uint64_t sequence;
    uint8_t corrupted_payload_length = 16u;
    int descriptor;

    CHECK(directory != NULL);
    memset(payload, 0x6c, sizeof(payload));
    store = open_store(directory, TEST_SEGMENT_SIZE);
    CHECK(store != NULL);
    CHECK(append_payload(store,
                         0u,
                         payload,
                         sizeof(payload),
                         SFS_DURABILITY_SYNC,
                         &sequence,
                         &error) == SFS_OK);
    CHECK(sfs_close(store, &error) == SFS_OK);

    first_segment_path(segment_path, sizeof(segment_path), directory);
    descriptor = open(segment_path, O_RDWR);
    CHECK(descriptor >= 0);
    CHECK(pwrite(descriptor, &corrupted_payload_length, 1u, 68) == 1);
    CHECK(fsync(descriptor) == 0);
    CHECK(close(descriptor) == 0);

    memset(&options, 0, sizeof(options));
    options.struct_size = sizeof(options);
    options.flags = SFS_OPEN_CREATE;
    options.directory = directory;
    options.segment_size = TEST_SEGMENT_SIZE;
    options.partition_quotas[0] = TEST_SEGMENT_SIZE * 4u;
    store = NULL;
    result = sfs_open(&options, &store, &error);
    CHECK(result == SFS_ERR_CORRUPT);
    CHECK(store == NULL);
    CHECK(error.code == SFS_ERR_CORRUPT);
    CHECK(strstr(error.message, "header") != NULL);
    remove_temp_directory(directory);
}

static void test_full_record_and_segment_rotation(void)
{
    uint8_t payloads[3][80];
    uint8_t oversized[161];
    char *directory = make_temp_directory();
    sfs_store_t *store;
    sfs_status_t status;
    sfs_cursor_t cursor = SFS_CURSOR_PARTITION(0u);
    sfs_record_info_t record;
    sfs_error_t error;
    uint8_t buffer[80];
    uint64_t sequence;
    size_t index;

    CHECK(directory != NULL);
    for (index = 0u; index < 3u; ++index) {
        memset(payloads[index], (int)(0x40u + index), sizeof(payloads[index]));
    }
    memset(oversized, 0x7f, sizeof(oversized));
    store = open_store(directory, TEST_SEGMENT_SIZE);
    CHECK(store != NULL);
    for (index = 0u; index < 3u; ++index) {
        CHECK(append_payload(store,
                             0u,
                             payloads[index],
                             sizeof(payloads[index]),
                             SFS_DURABILITY_SYNC,
                             &sequence,
                             &error) == SFS_OK);
        CHECK(sequence == index + 1u);
    }
    memset(&status, 0, sizeof(status));
    status.struct_size = sizeof(status);
    CHECK(sfs_status(store, &status, &error) == SFS_OK);
    CHECK(status.segment_count == 3u);
    CHECK(status.partitions[0].segment_count == 3u);
    CHECK(status.partitions[0].first_segment_id == 1u);
    CHECK(status.partitions[0].active_segment_id == 3u);
    CHECK(status.partitions[0].evicted_segments == 0u);
    CHECK(status.partitions[0].allocated_bytes == TEST_SEGMENT_SIZE * 3u);
    CHECK(append_payload(store,
                         0u,
                         oversized,
                         sizeof(oversized),
                         SFS_DURABILITY_MEMORY,
                         &sequence,
                         &error) == SFS_ERR_FULL);
    CHECK(sequence == 0u);
    status.struct_size = sizeof(status);
    CHECK(sfs_status(store, &status, &error) == SFS_OK);
    CHECK(status.next_sequence == 4u);

    for (index = 0u; index < 3u; ++index) {
        memset(&record, 0, sizeof(record));
        record.struct_size = sizeof(record);
        CHECK(sfs_scan(store,
                       &cursor,
                       buffer,
                       sizeof(buffer),
                       &record,
                       &error) == SFS_OK);
        CHECK(record.sequence == index + 1u);
        CHECK(record.segment_id == index + 1u);
        CHECK(record.frame_offset == SFS_SEGMENT_HEADER_SIZE);
        CHECK(memcmp(buffer, payloads[index], sizeof(buffer)) == 0);
    }
    record.struct_size = sizeof(record);
    CHECK(sfs_scan(store, &cursor, buffer, sizeof(buffer), &record, &error) ==
          SFS_END);
    CHECK(sfs_close(store, &error) == SFS_OK);

    store = open_store(directory, TEST_SEGMENT_SIZE);
    CHECK(store != NULL);
    status.struct_size = sizeof(status);
    CHECK(sfs_status(store, &status, &error) == SFS_OK);
    CHECK(status.segment_count == 3u);
    CHECK(status.record_count == 3u);
    CHECK(status.next_sequence == 4u);
    CHECK(sfs_close(store, &error) == SFS_OK);
    remove_temp_directory(directory);
}

static void test_partition_quota_evicts_oldest_segment_and_reports_gap(void)
{
    uint8_t payload[80];
    char *directory = make_temp_directory();
    sfs_store_t *store;
    sfs_status_t status;
    sfs_cursor_t cursor = SFS_CURSOR_BEGIN;
    sfs_record_info_t record;
    sfs_error_t error;
    uint8_t buffer[80];
    uint64_t sequence;
    size_t index;

    CHECK(directory != NULL);
    memset(payload, 0x5a, sizeof(payload));
    store = open_store_with_quota(directory,
                                  TEST_SEGMENT_SIZE,
                                  TEST_SEGMENT_SIZE * 2u);
    CHECK(store != NULL);
    for (index = 0u; index < 3u; ++index) {
        payload[0] = (uint8_t)index;
        CHECK(append_payload(store,
                             0u,
                             payload,
                             sizeof(payload),
                             SFS_DURABILITY_SYNC,
                             &sequence,
                             &error) == SFS_OK);
        CHECK(sequence == index + 1u);
    }
    memset(&status, 0, sizeof(status));
    status.struct_size = sizeof(status);
    CHECK(sfs_status(store, &status, &error) == SFS_OK);
    CHECK(status.partitions[0].allocated_bytes == TEST_SEGMENT_SIZE * 2u);
    CHECK(status.partitions[0].segment_count == 2u);
    CHECK(status.partitions[0].first_segment_id == 2u);
    CHECK(status.partitions[0].active_segment_id == 3u);
    CHECK(status.partitions[0].evicted_segments == 1u);
    CHECK(status.partitions[0].evicted_records == 1u);
    CHECK(status.partitions[0].record_count == 2u);
    CHECK(status.partitions[0].first_sequence == 2u);

    cursor = (sfs_cursor_t)SFS_CURSOR_PARTITION(0u);
    cursor.after_sequence = 0u;
    cursor.segment_id = 1u;
    cursor.offset = SFS_SEGMENT_HEADER_SIZE;
    memset(&record, 0, sizeof(record));
    record.struct_size = sizeof(record);
    CHECK(sfs_scan(store, &cursor, buffer, sizeof(buffer), &record, &error) ==
          SFS_OK);
    CHECK(record.sequence == 2u);
    CHECK((record.flags & SFS_RECORD_GAP_BEFORE) != 0u);
    CHECK(record.gap_first_sequence == 1u);
    CHECK(record.gap_last_sequence == 1u);

    cursor = (sfs_cursor_t)SFS_CURSOR_PARTITION(0u);
    memset(&record, 0, sizeof(record));
    record.struct_size = sizeof(record);
    CHECK(sfs_scan(store, &cursor, buffer, sizeof(buffer), &record, &error) ==
          SFS_OK);
    CHECK(record.sequence == 2u);
    CHECK((record.flags & SFS_RECORD_GAP_BEFORE) != 0u);
    CHECK(record.gap_first_sequence == 1u);
    CHECK(record.gap_last_sequence == 1u);

    cursor = (sfs_cursor_t)SFS_CURSOR_BEGIN;
    memset(&record, 0, sizeof(record));
    record.struct_size = sizeof(record);
    CHECK(sfs_scan(store, &cursor, buffer, sizeof(buffer), &record, &error) ==
          SFS_OK);
    CHECK(record.sequence == 2u);
    CHECK((record.flags & SFS_RECORD_GAP_BEFORE) != 0u);
    CHECK(record.gap_first_sequence == 1u);
    CHECK(record.gap_last_sequence == 1u);
    CHECK(buffer[0] == 1u);
    record.struct_size = sizeof(record);
    CHECK(sfs_scan(store, &cursor, buffer, sizeof(buffer), &record, &error) ==
          SFS_OK);
    CHECK(record.sequence == 3u);
    CHECK(record.flags == 0u);
    CHECK(buffer[0] == 2u);
    record.struct_size = sizeof(record);
    CHECK(sfs_scan(store, &cursor, buffer, sizeof(buffer), &record, &error) ==
          SFS_END);
    CHECK(sfs_close(store, &error) == SFS_OK);

    store = open_store_with_quota(directory,
                                  TEST_SEGMENT_SIZE,
                                  TEST_SEGMENT_SIZE * 2u);
    CHECK(store != NULL);
    status.struct_size = sizeof(status);
    CHECK(sfs_status(store, &status, &error) == SFS_OK);
    CHECK(status.partitions[0].evicted_segments == 1u);
    CHECK(status.partitions[0].evicted_records == 1u);
    CHECK(status.partitions[0].record_count == 2u);
    CHECK(status.next_sequence == 4u);
    CHECK(sfs_close(store, &error) == SFS_OK);
    remove_temp_directory(directory);
}

static void test_multi_partition_global_order_receipt_and_physical_cursor(void)
{
    static const uint8_t first[] = {0x11u, 0x12u};
    static const uint8_t second[] = {0x21u, 0x22u, 0x23u};
    static const uint8_t third[] = {0x31u};
    const uint32_t expected_partitions[] = {1u, 0u, 1u};
    const uint8_t *expected_payloads[] = {first, second, third};
    const uint32_t expected_lengths[] = {
        sizeof(first), sizeof(second), sizeof(third)};
    char *directory = make_temp_directory();
    sfs_store_t *store;
    sfs_record_info_t receipts[3];
    sfs_record_info_t record;
    sfs_cursor_t cursor;
    sfs_status_t status;
    sfs_error_t error;
    uint8_t buffer[8];
    size_t index;

    CHECK(directory != NULL);
    store = open_two_partition_store(directory, TEST_SEGMENT_SIZE);
    CHECK(store != NULL);
    memset(receipts, 0, sizeof(receipts));
    receipts[0].struct_size = sizeof(receipts[0]);
    CHECK(sfs_append(store,
                     1u,
                     first,
                     sizeof(first),
                     SFS_DURABILITY_MEMORY,
                     &receipts[0],
                     &error) == SFS_OK);
    receipts[1].struct_size = sizeof(receipts[1]);
    CHECK(sfs_append(store,
                     0u,
                     second,
                     sizeof(second),
                     SFS_DURABILITY_MEMORY,
                     &receipts[1],
                     &error) == SFS_OK);
    receipts[2].struct_size = sizeof(receipts[2]);
    CHECK(sfs_append(store,
                     1u,
                     third,
                     sizeof(third),
                     SFS_DURABILITY_SYNC,
                     &receipts[2],
                     &error) == SFS_OK);
    for (index = 0u; index < 3u; ++index) {
        CHECK(receipts[index].sequence == index + 1u);
        CHECK(receipts[index].partition_id == expected_partitions[index]);
        CHECK(receipts[index].segment_id == 1u);
        CHECK(receipts[index].payload_length == expected_lengths[index]);
    }
    CHECK(receipts[0].frame_offset == 64u);
    CHECK(receipts[1].frame_offset == 64u);
    CHECK(receipts[2].frame_offset == 104u);

    memset(&cursor, 0, sizeof(cursor));
    cursor.partition_id = receipts[1].partition_id;
    cursor.segment_id = receipts[1].segment_id;
    cursor.offset = receipts[1].frame_offset;
    memset(&record, 0, sizeof(record));
    record.struct_size = sizeof(record);
    CHECK(sfs_scan(store, &cursor, NULL, 0u, &record, &error) ==
          SFS_BUFFER_TOO_SMALL);
    CHECK(record.payload_length == sizeof(second));
    CHECK(cursor.offset == receipts[1].frame_offset);
    record.struct_size = sizeof(record);
    CHECK(sfs_scan(store, &cursor, buffer, sizeof(buffer), &record, &error) ==
          SFS_OK);
    CHECK(record.sequence == receipts[1].sequence);
    CHECK(memcmp(buffer, second, sizeof(second)) == 0);

    cursor = (sfs_cursor_t)SFS_CURSOR_BEGIN;
    for (index = 0u; index < 3u; ++index) {
        memset(&record, 0, sizeof(record));
        record.struct_size = sizeof(record);
        CHECK(sfs_scan(store,
                       &cursor,
                       buffer,
                       sizeof(buffer),
                       &record,
                       &error) == SFS_OK);
        CHECK(record.sequence == index + 1u);
        CHECK(record.partition_id == expected_partitions[index]);
        CHECK(record.flags == 0u);
        CHECK(record.payload_length == expected_lengths[index]);
        CHECK(memcmp(buffer, expected_payloads[index], expected_lengths[index]) ==
              0);
    }
    record.struct_size = sizeof(record);
    CHECK(sfs_scan(store, &cursor, buffer, sizeof(buffer), &record, &error) ==
          SFS_END);
    memset(&status, 0, sizeof(status));
    status.struct_size = sizeof(status);
    CHECK(sfs_status(store, &status, &error) == SFS_OK);
    CHECK(status.record_count == 3u);
    CHECK(status.next_sequence == 4u);
    CHECK(status.partitions[0].record_count == 1u);
    CHECK(status.partitions[1].record_count == 2u);
    CHECK(sfs_close(store, &error) == SFS_OK);

    store = open_two_partition_store(directory, TEST_SEGMENT_SIZE);
    CHECK(store != NULL);
    status.struct_size = sizeof(status);
    CHECK(sfs_status(store, &status, &error) == SFS_OK);
    CHECK(status.record_count == 3u);
    CHECK(status.next_sequence == 4u);
    CHECK(sfs_close(store, &error) == SFS_OK);
    remove_temp_directory(directory);
}

static void test_global_scan_rewinds_eviction_and_append_after_end(void)
{
    char *directory = make_temp_directory();
    sfs_store_t *store;
    sfs_error_t error;
    sfs_record_info_t receipts[513], record;
    sfs_status_t status;
    sfs_cursor_t cursor = SFS_CURSOR_BEGIN;
    const uint64_t positions[] = {0u, 48u, 0u, 31u, 7u, 63u, 12u};
    uint64_t value, payload, expected;
    size_t index;
    int pass;
    CHECK(directory != NULL);
    store = open_two_partition_store(directory, 2048u);
    CHECK(store != NULL);
    memset(receipts, 0, sizeof(receipts));
    memset(&record, 0, sizeof(record));
    record.struct_size = sizeof(record);
    for (value = 1u; value <= 64u; ++value) {
        receipts[value - 1u].struct_size = sizeof(record);
        CHECK(sfs_append(store, (uint32_t)(value % 2u), &value, sizeof(value),
                         SFS_DURABILITY_MEMORY, &receipts[value - 1u], &error) == SFS_OK);
    }
    for (index = 0u; index < sizeof(positions) / sizeof(positions[0]); ++index) {
        cursor = (sfs_cursor_t)SFS_CURSOR_BEGIN;
        cursor.after_sequence = positions[index];
        CHECK(sfs_scan(store, &cursor, NULL, 0u, &record, &error) == SFS_BUFFER_TOO_SMALL);
        CHECK(cursor.after_sequence == positions[index]);
        CHECK(sfs_scan(store, &cursor, &payload, sizeof(payload), &record, &error) == SFS_OK);
        CHECK(record.sequence == positions[index] + 1u);
        CHECK(payload == record.sequence);
        CHECK(record.flags == 0u);
    }
    /* Sequence-only cursors select the first later record in that partition,
       including rewinds, and then retain a physical address for subsequent reads. */
    for (index = 0u; index < sizeof(positions) / sizeof(positions[0]); ++index) {
        cursor = (sfs_cursor_t)SFS_CURSOR_PARTITION(0u);
        cursor.after_sequence = positions[index];
        expected = (positions[index] / 2u + 1u) * 2u;
        CHECK(sfs_scan(store, &cursor, NULL, 0u, &record, &error) == SFS_BUFFER_TOO_SMALL);
        CHECK(cursor.after_sequence == positions[index] && cursor.segment_id == 0u);
        CHECK(sfs_scan(store, &cursor, &payload, sizeof(payload), &record, &error) == SFS_OK);
        CHECK(record.sequence == expected && payload == expected);
        CHECK(record.partition_id == 0u && record.flags == 0u);
        CHECK(cursor.segment_id != 0u && cursor.offset > record.frame_offset);
    }
    cursor = (sfs_cursor_t)SFS_CURSOR_BEGIN;
    cursor.after_sequence = 64u;
    CHECK(sfs_scan(store, &cursor, &payload, sizeof(payload), &record, &error) == SFS_END);
    for (value = 65u; value <= 512u; ++value) {
        receipts[value - 1u].struct_size = sizeof(record);
        CHECK(sfs_append(store, (uint32_t)(value % 2u), &value, sizeof(value),
                         SFS_DURABILITY_MEMORY, &receipts[value - 1u], &error) == SFS_OK);
    }
    memset(&status, 0, sizeof(status));
    status.struct_size = sizeof(status);
    CHECK(sfs_status(store, &status, &error) == SFS_OK);
    CHECK(status.partitions[0].evicted_records > 0u);
    CHECK(status.partitions[1].evicted_records > 0u);
    cursor = (sfs_cursor_t)SFS_CURSOR_PARTITION(0u);
    cursor.after_sequence = 1u;
    CHECK(sfs_scan(store, &cursor, &payload, sizeof(payload), &record, &error) == SFS_OK);
    CHECK(record.sequence == status.partitions[0].first_sequence);
    CHECK((record.flags & SFS_RECORD_GAP_BEFORE) != 0u);
    cursor = (sfs_cursor_t)SFS_CURSOR_PARTITION(0u);
    cursor.after_sequence = 400u;
    CHECK(sfs_scan(store, &cursor, &payload, sizeof(payload), &record, &error) == SFS_OK);
    CHECK(record.sequence == 402u && record.flags == 0u);
    cursor = (sfs_cursor_t)SFS_CURSOR_PARTITION(7u);
    cursor.after_sequence = 1u;
    CHECK(sfs_scan(store, &cursor, &payload, sizeof(payload), &record, &error) == SFS_ERR_PARTITION_DISABLED);
    /* The old per-partition positions point into evicted segments. Both a live
       scan and a cold reader must enumerate exactly the retained originals. */
    for (pass = 0; pass < 2; ++pass) {
        cursor = (sfs_cursor_t)SFS_CURSOR_BEGIN;
        expected = 1u;
        for (index = 0u; index < 512u; ++index) {
            const sfs_record_info_t *receipt = &receipts[index];
            if (receipt->segment_id < status.partitions[receipt->partition_id].first_segment_id) {
                continue;
            }
            CHECK(sfs_scan(store, &cursor, &payload, sizeof(payload), &record, &error) == SFS_OK);
            CHECK(record.sequence == receipt->sequence);
            CHECK(payload == receipt->sequence);
            CHECK(record.partition_id == receipt->partition_id);
            CHECK(record.frame_offset == receipt->frame_offset);
            CHECK(record.segment_id == receipt->segment_id);
            CHECK(((record.flags & SFS_RECORD_GAP_BEFORE) != 0u) == (record.sequence > expected));
            expected = record.sequence + 1u;
        }
        CHECK(sfs_scan(store, &cursor, &payload, sizeof(payload), &record, &error) == SFS_END);
        if (pass == 0) {
            CHECK(sfs_close(store, &error) == SFS_OK);
            store = open_two_partition_store(directory, 2048u);
            CHECK(store != NULL);
        }
    }
    value = 513u;
    receipts[512].struct_size = sizeof(record);
    CHECK(sfs_append(store, 1u, &value, sizeof(value), SFS_DURABILITY_MEMORY,
                     &receipts[512], &error) == SFS_OK);
    CHECK(sfs_scan(store, &cursor, &payload, sizeof(payload), &record, &error) == SFS_OK);
    CHECK(record.sequence == value && payload == value);
    CHECK(sfs_close(store, &error) == SFS_OK);
    remove_temp_directory(directory);
}

static void test_global_scan_position_does_not_cache_payload_or_crc(void)
{
    char *directory = make_temp_directory();
    char segment_path[1024];
    sfs_store_t *store;
    sfs_error_t error;
    sfs_record_info_t receipt, record;
    sfs_cursor_t cursor = SFS_CURSOR_BEGIN;
    uint64_t payload = 123u, readback = 0u;
    uint8_t byte;
    int descriptor;
    CHECK(directory != NULL);
    store = open_store(directory, 2048u);
    CHECK(store != NULL);
    memset(&receipt, 0, sizeof(receipt));
    receipt.struct_size = sizeof(receipt);
    record.struct_size = sizeof(record);
    CHECK(sfs_append(store, 0u, &payload, sizeof(payload), SFS_DURABILITY_SYNC, &receipt, &error) == SFS_OK);
    /* This establishes a read position without handing out a successful read. */
    CHECK(sfs_scan(store, &cursor, NULL, 0u, &record, &error) == SFS_BUFFER_TOO_SMALL);
    first_segment_path(segment_path, sizeof(segment_path), directory);
    descriptor = open(segment_path, O_RDWR);
    CHECK(descriptor >= 0);
    CHECK(pread(descriptor, &byte, 1u, (off_t)receipt.frame_offset + 24) == 1);
    byte ^= 0x80u;
    CHECK(pwrite(descriptor, &byte, 1u, (off_t)receipt.frame_offset + 24) == 1);
    CHECK(fsync(descriptor) == 0);
    CHECK(close(descriptor) == 0);
    CHECK(sfs_scan(store, &cursor, &readback, sizeof(readback), &record, &error) == SFS_ERR_CORRUPT);
    CHECK(cursor.after_sequence == 0u);
    CHECK(strstr(error.message, "CRC32C") != NULL);
    CHECK(sfs_close(store, &error) == SFS_OK);
    remove_temp_directory(directory);
}

static void test_second_writer_open_in_same_process_is_busy(void)
{
    char *directory = make_temp_directory();
    sfs_store_t *first;
    sfs_store_t *second = NULL;
    sfs_open_options_t options;
    sfs_error_t error;

    CHECK(directory != NULL);
    first = open_store(directory, TEST_SEGMENT_SIZE);
    CHECK(first != NULL);
    memset(&options, 0, sizeof(options));
    options.struct_size = sizeof(options);
    options.flags = SFS_OPEN_CREATE;
    options.directory = directory;
    options.segment_size = TEST_SEGMENT_SIZE;
    options.partition_quotas[0] = TEST_SEGMENT_SIZE * 4u;
    CHECK(sfs_open(&options, &second, &error) == SFS_ERR_BUSY);
    CHECK(second == NULL);
    CHECK(error.code == SFS_ERR_BUSY);
    CHECK(sfs_close(first, &error) == SFS_OK);

    second = open_store(directory, TEST_SEGMENT_SIZE);
    CHECK(second != NULL);
    CHECK(sfs_close(second, &error) == SFS_OK);
    remove_temp_directory(directory);
}

static long timeval_ms(struct timeval value)
{
    return value.tv_sec * 1000L + value.tv_usec / 1000L;
}

static uint64_t tree_bytes(const char *path)
{
    DIR *directory = opendir(path);
    uint64_t total = 0u;
    struct dirent *entry;
    if (directory == NULL) {
        return 0u;
    }
    while ((entry = readdir(directory)) != NULL) {
        char child[1024];
        struct stat status;
        if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) {
            continue;
        }
        (void)snprintf(child, sizeof(child), "%s/%s", path, entry->d_name);
        if (lstat(child, &status) != 0) {
            continue;
        }
        if (S_ISDIR(status.st_mode)) {
            total += tree_bytes(child);
        } else if (S_ISREG(status.st_mode)) {
            total += (uint64_t)status.st_size;
        }
    }
    (void)closedir(directory);
    return total;
}

static void run_log_payload_load(const char *tier, uint32_t count)
{
    char *directory = make_temp_directory();
    sfs_open_options_t options;
    sfs_store_t *store = NULL;
    sfs_error_t error;
    sfs_status_t status;
    uint8_t payload[256];
    struct timespec started;
    struct timespec finished;
    struct rusage before;
    struct rusage after;
    uint32_t index;
    long elapsed_ms;

    CHECK(directory != NULL);
    memset(&options, 0, sizeof(options));
    options.struct_size = sizeof(options);
    options.flags = SFS_OPEN_CREATE;
    options.directory = directory;
    options.segment_size = 1024u * 1024u;
    options.partition_quotas[2] = 32u * 1024u * 1024u;
    CHECK(sfs_open(&options, &store, &error) == SFS_OK);
    CHECK(store != NULL);
    memset(payload, 'L', sizeof(payload));
    CHECK(getrusage(RUSAGE_SELF, &before) == 0);
    CHECK(clock_gettime(CLOCK_MONOTONIC, &started) == 0);
    for (index = 0; index < count; index += 1) {
        payload[0] = (uint8_t)(index & 0xffu);
        CHECK(append_payload(store,
                             2u,
                             payload,
                             (uint32_t)sizeof(payload),
                             SFS_DURABILITY_MEMORY,
                             NULL,
                             &error) == SFS_OK);
    }
    CHECK(sfs_flush(store, &error) == SFS_OK);
    CHECK(clock_gettime(CLOCK_MONOTONIC, &finished) == 0);
    CHECK(getrusage(RUSAGE_SELF, &after) == 0);
    memset(&status, 0, sizeof(status));
    status.struct_size = sizeof(status);
    CHECK(sfs_status(store, &status, &error) == SFS_OK);
    CHECK(status.record_count == (uint64_t)count);
    CHECK(status.partitions[2].record_count == (uint64_t)count);
    elapsed_ms = (finished.tv_sec - started.tv_sec) * 1000L +
        (finished.tv_nsec - started.tv_nsec) / 1000000L;
    (void)fprintf(
        stderr,
        "AAB_LOG_LOAD native tier=%s offered=%u written=%" PRIu64
        " elapsedMs=%ld cpuUserMs=%ld cpuSysMs=%ld maxRssKb=%ld diskBytes=%" PRIu64
        " payloadBytes=%" PRIu64 "\n",
        tier,
        count,
        status.record_count,
        elapsed_ms,
        timeval_ms(after.ru_utime) - timeval_ms(before.ru_utime),
        timeval_ms(after.ru_stime) - timeval_ms(before.ru_stime),
        (long)after.ru_maxrss,
        tree_bytes(directory),
        status.payload_bytes);
    CHECK(sfs_close(store, &error) == SFS_OK);
    remove_temp_directory(directory);
}

static void test_log_payload_burst_append_and_scan(void)
{
    run_log_payload_load("low", 200u);
    run_log_payload_load("medium", 2000u);
    run_log_payload_load("high", 10000u);
}

static void test_interrupted_temporary_segment_creation_is_cleaned_on_open(void)
{
    static const char temporary_name[] =
        "/partition-0/.segment-00000000000000000002.creating";
    char *directory = make_temp_directory();
    char temporary_path[1024];
    static const uint8_t partial_header[] = {'S', 'F', 'S', 'S', 'E'};
    sfs_store_t *store;
    sfs_status_t status;
    sfs_error_t error;
    struct stat file_status;
    int descriptor;

    CHECK(directory != NULL);
    store = open_store(directory, TEST_SEGMENT_SIZE);
    CHECK(store != NULL);
    CHECK(sfs_close(store, &error) == SFS_OK);
    (void)snprintf(temporary_path,
                   sizeof(temporary_path),
                   "%s%s",
                   directory,
                   temporary_name);
    descriptor = open(temporary_path, O_WRONLY | O_CREAT | O_EXCL, 0600);
    CHECK(descriptor >= 0);
    CHECK(write(descriptor, partial_header, sizeof(partial_header)) ==
          (ssize_t)sizeof(partial_header));
    CHECK(fsync(descriptor) == 0);
    CHECK(close(descriptor) == 0);

    store = open_store(directory, TEST_SEGMENT_SIZE);
    CHECK(store != NULL);
    CHECK(lstat(temporary_path, &file_status) != 0);
    CHECK(errno == ENOENT);
    memset(&status, 0, sizeof(status));
    status.struct_size = sizeof(status);
    CHECK(sfs_status(store, &status, &error) == SFS_OK);
    CHECK(status.segment_count == 1u);
    CHECK(status.record_count == 0u);
    CHECK(status.partitions[0].active_segment_id == 1u);
    CHECK(sfs_close(store, &error) == SFS_OK);
    remove_temp_directory(directory);
}

int main(void)
{
    test_append_scan_and_status();
    test_repeated_reopen_preserves_records_and_sequence();
    test_sealed_segment_accepts_short_zero_tail();
    test_sealed_segment_rejects_short_nonzero_tail();
    test_every_tail_truncation_recovers_to_last_committed_frame();
    test_committed_payload_crc_corruption_is_rejected();
    test_committed_header_length_corruption_is_not_recovered_as_torn();
    test_full_record_and_segment_rotation();
    test_partition_quota_evicts_oldest_segment_and_reports_gap();
    test_multi_partition_global_order_receipt_and_physical_cursor();
    test_global_scan_rewinds_eviction_and_append_after_end();
    test_global_scan_position_does_not_cache_payload_or_crc();
    test_second_writer_open_in_same_process_is_busy();
    test_interrupted_temporary_segment_creation_is_cleaned_on_open();
    test_log_payload_burst_append_and_scan();
    if (failures != 0) {
        (void)fprintf(stderr, "%d test(s) failed\n", failures);
        return EXIT_FAILURE;
    }
    (void)printf("all segmented fact store tests passed\n");
    return EXIT_SUCCESS;
}
