#define _POSIX_C_SOURCE 200809L
#include "sfs.h"
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static uint64_t nanoseconds(void)
{
    struct timespec time;
    if (clock_gettime(CLOCK_MONOTONIC, &time) != 0) { abort(); }
    return (uint64_t)time.tv_sec * UINT64_C(1000000000) + (uint64_t)time.tv_nsec;
}

int main(int argc, char **argv)
{
    sfs_open_options_t options = {0};
    sfs_store_t *store = NULL;
    sfs_error_t error;
    sfs_record_info_t receipt = {0}, record = {0};
    sfs_cursor_t cursor = SFS_CURSOR_BEGIN;
    uint8_t payload[256], readback[256];
    uint64_t count, sequence, started, elapsed;
    if (argc != 3) { return 2; }
    count = strtoull(argv[2], NULL, 10);
    if (count == 0u || count > 100000u) { return 2; }
    options.struct_size = sizeof(options);
    options.flags = SFS_OPEN_CREATE;
    options.directory = argv[1];
    options.segment_size = 4u * 1024u * 1024u;
    options.partition_quotas[0] = 32u * 1024u * 1024u;
    options.partition_quotas[1] = 32u * 1024u * 1024u;
    receipt.struct_size = sizeof(receipt);
    record.struct_size = sizeof(record);
    if (sfs_open(&options, &store, &error) != SFS_OK) { return 1; }
    for (sequence = 1u; sequence <= count; ++sequence) {
        memset(payload, (int)(sequence % 251u), sizeof(payload));
        memcpy(payload, &sequence, sizeof(sequence));
        if (sfs_append(store, (uint32_t)(sequence % 2u), payload, sizeof(payload),
                       SFS_DURABILITY_MEMORY, &receipt, &error) != SFS_OK || receipt.sequence != sequence) { return 1; }
    }
    if (sfs_close(store, &error) != SFS_OK) { return 1; }
    if (sfs_open(&options, &store, &error) != SFS_OK) { return 1; }
    started = nanoseconds();
    for (sequence = 1u; sequence <= count; ++sequence) {
        memset(payload, (int)(sequence % 251u), sizeof(payload));
        memcpy(payload, &sequence, sizeof(sequence));
        if (sfs_scan(store, &cursor, readback, sizeof(readback), &record, &error) != SFS_OK ||
            record.sequence != sequence || record.partition_id != sequence % 2u ||
            record.flags != 0u || memcmp(readback, payload, sizeof(payload)) != 0) { return 1; }
    }
    if (sfs_scan(store, &cursor, readback, sizeof(readback), &record, &error) != SFS_END) { return 1; }
    elapsed = nanoseconds() - started;
    if (sfs_close(store, &error) != SFS_OK) { return 1; }
    (void)printf("{\"records\":%" PRIu64 ",\"payloadBytes\":256,\"coldScanMs\":%.3f}\n", count, (double)elapsed / 1e6);
    return 0;
}
