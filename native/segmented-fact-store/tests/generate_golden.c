#define _POSIX_C_SOURCE 200809L

#include "sfs.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

static int append_and_check(sfs_store_t *store,
                            uint32_t partition_id,
                            const void *payload,
                            uint32_t payload_length,
                            sfs_durability_t durability,
                            uint64_t expected_sequence,
                            uint64_t expected_offset)
{
    sfs_record_info_t receipt;
    sfs_error_t error;
    sfs_result_t result;

    memset(&receipt, 0, sizeof(receipt));
    receipt.struct_size = sizeof(receipt);
    result = sfs_append(store,
                        partition_id,
                        payload,
                        payload_length,
                        durability,
                        &receipt,
                        &error);
    if (result != SFS_OK || receipt.sequence != expected_sequence ||
        receipt.partition_id != partition_id || receipt.segment_id != 1u ||
        receipt.frame_offset != expected_offset ||
        receipt.payload_length != payload_length) {
        (void)fprintf(stderr,
                      "append mismatch: result=%d message=%s sequence=%llu "
                      "partition=%u segment=%llu offset=%llu length=%u\n",
                      result,
                      error.message,
                      (unsigned long long)receipt.sequence,
                      receipt.partition_id,
                      (unsigned long long)receipt.segment_id,
                      (unsigned long long)receipt.frame_offset,
                      receipt.payload_length);
        return 1;
    }
    return 0;
}

int main(int argc, char **argv)
{
    static const uint8_t binary_payload[] = {0x00u, 0x01u, 0x7fu, 0x80u, 0xffu};
    static const uint8_t text_payload[] = {'h', 'e', 'l', 'l', 'o'};
    sfs_open_options_t options;
    sfs_store_t *store = NULL;
    sfs_error_t error;
    sfs_result_t result;
    struct stat status;

    if (argc != 2) {
        (void)fprintf(stderr, "usage: %s OUTPUT_DIRECTORY\n", argv[0]);
        return EXIT_FAILURE;
    }
    if (stat(argv[1], &status) != 0) {
        if (errno != ENOENT || mkdir(argv[1], 0700) != 0) {
            (void)fprintf(stderr, "cannot create output directory %s\n", argv[1]);
            return EXIT_FAILURE;
        }
    }

    memset(&options, 0, sizeof(options));
    options.struct_size = sizeof(options);
    options.flags = SFS_OPEN_CREATE;
    options.directory = argv[1];
    options.segment_size = 512u;
    options.partition_quotas[0] = 1024u;
    options.partition_quotas[1] = 1024u;
    result = sfs_open(&options, &store, &error);
    if (result != SFS_OK) {
        (void)fprintf(stderr, "open failed: %d %s\n", result, error.message);
        return EXIT_FAILURE;
    }
    if (append_and_check(store,
                         0u,
                         binary_payload,
                         sizeof(binary_payload),
                         SFS_DURABILITY_SYNC,
                         1u,
                         64u) != 0 ||
        append_and_check(store,
                         1u,
                         text_payload,
                         sizeof(text_payload),
                         SFS_DURABILITY_MEMORY,
                         2u,
                         64u) != 0 ||
        append_and_check(store,
                         0u,
                         NULL,
                         0u,
                         SFS_DURABILITY_SYNC,
                         3u,
                         104u) != 0) {
        (void)sfs_close(store, NULL);
        return EXIT_FAILURE;
    }
    result = sfs_close(store, &error);
    if (result != SFS_OK) {
        (void)fprintf(stderr, "close failed: %d %s\n", result, error.message);
        return EXIT_FAILURE;
    }
    return EXIT_SUCCESS;
}
