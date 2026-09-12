#define _DEFAULT_SOURCE
#define _DARWIN_C_SOURCE
#define _POSIX_C_SOURCE 200809L

#include "sfs.h"

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#define SFS_MIN_SEGMENT_SIZE 128u
#define SFS_FRAME_PREFIX_SIZE 24u
#define SFS_FRAME_COMMIT_SIZE 8u
#define SFS_MIN_FRAME_SIZE (SFS_FRAME_PREFIX_SIZE + SFS_FRAME_COMMIT_SIZE)

#define SFS_MANIFEST_FILE ".sfs-manifest"
#define SFS_LOCK_FILE ".sfs-lock"
#define SFS_MANIFEST_SIZE 4096u
#define SFS_MANIFEST_SLOT_SIZE 512u
#define SFS_MANIFEST_SLOT_COUNT 2u
#define SFS_MANIFEST_PARTITIONS_OFFSET 48u
#define SFS_MANIFEST_PARTITION_SIZE 48u
#define SFS_MANIFEST_CRC_OFFSET 432u
#define SFS_MANIFEST_COMMIT_OFFSET 504u

#define SFS_SEGMENT_CRC_OFFSET 48u
#define SFS_INTERNAL_TORN 100

static const uint8_t SFS_MANIFEST_MAGIC[8] = {
    'S', 'F', 'S', 'M', 'A', 'N', '0', '1'};
static const uint8_t SFS_SEGMENT_MAGIC[8] = {
    'S', 'F', 'S', 'S', 'E', 'G', '0', '1'};
static const uint64_t SFS_MANIFEST_COMMIT_MARKER = UINT64_C(0x314d4f434d534653);
static const uint64_t SFS_FRAME_COMMIT_MARKER = UINT64_C(0x314d4f4346534653);

typedef struct sfs_segment_meta {
    uint64_t id;
    uint64_t write_offset;
    uint64_t record_count;
    uint64_t payload_bytes;
    uint64_t first_sequence;
    uint64_t last_sequence;
} sfs_segment_meta_t;

typedef struct sfs_partition {
    bool enabled;
    uint64_t quota_bytes;
    char *directory;
    sfs_segment_meta_t *segments;
    size_t segment_count;
    size_t segment_capacity;
    int active_fd;
    uint8_t *active_map;
    uint64_t active_write_offset;
    uint64_t durable_offset;
    uint64_t next_segment_id;
    uint64_t first_retained_segment_id;
    uint64_t record_count;
    uint64_t payload_bytes;
    uint64_t first_sequence;
    uint64_t last_sequence;
    uint64_t evicted_segments;
    uint64_t evicted_records;
    uint64_t evicted_payload_bytes;
    /* Global scans merge partitions by sequence. Retain only the proven read
       position, never payloads or results; rewinds start from segment metadata. */
    uint64_t scan_after_sequence;
    uint64_t scan_segment_id;
    uint64_t scan_offset;
} sfs_partition_t;

struct sfs_store {
    pthread_mutex_t mutex;
    bool mutex_initialized;
    char *directory;
    int lock_fd;
    int manifest_fd;
    uint8_t *manifest_map;
    int manifest_active_slot;
    uint64_t manifest_generation;
    uint64_t segment_size;
    uint64_t next_sequence;
    uint32_t status_flags;
    uint32_t recovery_partition_id;
    uint64_t recovery_segment_id;
    uint64_t recovery_offset;
    uint64_t recovery_discarded_bytes;
    sfs_partition_t partitions[SFS_MAX_PARTITIONS];
};

typedef struct sfs_loaded_manifest_partition {
    uint64_t quota_bytes;
    uint64_t next_segment_id;
    uint64_t first_retained_segment_id;
    uint64_t evicted_segments;
    uint64_t evicted_records;
    uint64_t evicted_payload_bytes;
} sfs_loaded_manifest_partition_t;

typedef struct sfs_loaded_manifest {
    uint64_t generation;
    uint64_t next_sequence;
    uint64_t segment_size;
    sfs_loaded_manifest_partition_t partitions[SFS_MAX_PARTITIONS];
} sfs_loaded_manifest_t;

typedef struct sfs_frame_view {
    uint32_t total_length;
    uint32_t payload_length;
    uint64_t sequence;
    uint64_t payload_offset;
    uint64_t commit_offset;
} sfs_frame_view_t;

typedef struct sfs_candidate {
    bool present;
    uint32_t partition_id;
    size_t segment_index;
    uint64_t frame_offset;
    sfs_frame_view_t frame;
} sfs_candidate_t;

static pthread_once_t sfs_crc_once = PTHREAD_ONCE_INIT;
static uint32_t sfs_crc_table[256];

static void sfs_crc_initialize(void)
{
    uint32_t index;
    for (index = 0u; index < 256u; ++index) {
        uint32_t value = index;
        uint32_t bit;
        for (bit = 0u; bit < 8u; ++bit) {
            value = (value >> 1u) ^
                    ((value & 1u) != 0u ? UINT32_C(0x82f63b78) : 0u);
        }
        sfs_crc_table[index] = value;
    }
}

static uint32_t sfs_crc32c(const uint8_t *data, size_t length)
{
    uint32_t crc = UINT32_MAX;
    size_t index;
    (void)pthread_once(&sfs_crc_once, sfs_crc_initialize);
    for (index = 0u; index < length; ++index) {
        crc = sfs_crc_table[(crc ^ data[index]) & 0xffu] ^ (crc >> 8u);
    }
    return ~crc;
}

static uint32_t load_u32_le(const uint8_t *bytes)
{
    return ((uint32_t)bytes[0]) | ((uint32_t)bytes[1] << 8u) |
           ((uint32_t)bytes[2] << 16u) | ((uint32_t)bytes[3] << 24u);
}

static uint64_t load_u64_le(const uint8_t *bytes)
{
    return ((uint64_t)load_u32_le(bytes)) |
           ((uint64_t)load_u32_le(bytes + 4u) << 32u);
}

static void store_u32_le(uint8_t *bytes, uint32_t value)
{
    bytes[0] = (uint8_t)value;
    bytes[1] = (uint8_t)(value >> 8u);
    bytes[2] = (uint8_t)(value >> 16u);
    bytes[3] = (uint8_t)(value >> 24u);
}

static void store_u64_le(uint8_t *bytes, uint64_t value)
{
    store_u32_le(bytes, (uint32_t)value);
    store_u32_le(bytes + 4u, (uint32_t)(value >> 32u));
}

static uint64_t align_eight(uint64_t value)
{
    return (value + 7u) & ~UINT64_C(7);
}

static void clear_error(sfs_error_t *error)
{
    if (error != NULL) {
        memset(error, 0, sizeof(*error));
    }
}

static sfs_result_t set_error(sfs_error_t *error,
                              sfs_result_t result,
                              int system_code,
                              const char *format,
                              ...)
{
    if (error != NULL) {
        va_list arguments;
        memset(error, 0, sizeof(*error));
        error->code = result;
        error->system_code = system_code;
        va_start(arguments, format);
        (void)vsnprintf(error->message, sizeof(error->message), format, arguments);
        va_end(arguments);
    }
    return result;
}

static char *path_join(const char *left, const char *right)
{
    size_t left_length = strlen(left);
    size_t right_length = strlen(right);
    char *path;
    if (left_length > SIZE_MAX - right_length - 2u) {
        return NULL;
    }
    path = (char *)malloc(left_length + right_length + 2u);
    if (path == NULL) {
        return NULL;
    }
    (void)snprintf(path, left_length + right_length + 2u, "%s/%s", left, right);
    return path;
}

static char *partition_path(const char *directory, uint32_t partition_id)
{
    char name[32];
    (void)snprintf(name, sizeof(name), "partition-%u", partition_id);
    return path_join(directory, name);
}

static char *segment_path(const sfs_partition_t *partition, uint64_t segment_id)
{
    char name[48];
    (void)snprintf(name, sizeof(name), "segment-%020" PRIu64 ".sfs", segment_id);
    return path_join(partition->directory, name);
}

static char *temporary_segment_path(const sfs_partition_t *partition,
                                    uint64_t segment_id)
{
    char name[56];
    (void)snprintf(name,
                   sizeof(name),
                   ".segment-%020" PRIu64 ".creating",
                   segment_id);
    return path_join(partition->directory, name);
}

static sfs_result_t ensure_directory(const char *path,
                                     bool create,
                                     sfs_error_t *error)
{
    struct stat status;
    if (stat(path, &status) == 0) {
        if (!S_ISDIR(status.st_mode)) {
            return set_error(error,
                             SFS_ERR_IO,
                             ENOTDIR,
                             "path is not a directory: %s",
                             path);
        }
        return SFS_OK;
    }
    if (errno != ENOENT || !create) {
        int saved_errno = errno;
        return set_error(error,
                         SFS_ERR_IO,
                         saved_errno,
                         "cannot access directory %s: %s",
                         path,
                         strerror(saved_errno));
    }
    if (mkdir(path, 0700) != 0) {
        int saved_errno = errno;
        return set_error(error,
                         SFS_ERR_IO,
                         saved_errno,
                         "cannot create directory %s: %s",
                         path,
                         strerror(saved_errno));
    }
    return SFS_OK;
}

static void fsync_directory_best_effort(const char *path)
{
    int descriptor = open(path, O_RDONLY);
    if (descriptor >= 0) {
        (void)fsync(descriptor);
        (void)close(descriptor);
    }
}

static bool parse_segment_name(const char *name, uint64_t *out_id)
{
    static const char prefix[] = "segment-";
    static const char suffix[] = ".sfs";
    const size_t expected_length = (sizeof(prefix) - 1u) + 20u +
                                   (sizeof(suffix) - 1u);
    uint64_t value = 0u;
    size_t index;
    if (strlen(name) != expected_length ||
        memcmp(name, prefix, sizeof(prefix) - 1u) != 0 ||
        memcmp(name + expected_length - (sizeof(suffix) - 1u),
               suffix,
               sizeof(suffix) - 1u) != 0) {
        return false;
    }
    for (index = sizeof(prefix) - 1u;
         index < (sizeof(prefix) - 1u) + 20u;
         ++index) {
        uint8_t digit;
        if (name[index] < '0' || name[index] > '9') {
            return false;
        }
        digit = (uint8_t)(name[index] - '0');
        if (value > (UINT64_MAX - digit) / 10u) {
            return false;
        }
        value = value * 10u + digit;
    }
    if (value == 0u) {
        return false;
    }
    *out_id = value;
    return true;
}

static bool is_temporary_segment_name(const char *name)
{
    static const char prefix[] = ".segment-";
    static const char suffix[] = ".creating";
    const size_t expected_length = (sizeof(prefix) - 1u) + 20u +
                                   (sizeof(suffix) - 1u);
    size_t index;
    if (strlen(name) != expected_length ||
        memcmp(name, prefix, sizeof(prefix) - 1u) != 0 ||
        memcmp(name + expected_length - (sizeof(suffix) - 1u),
               suffix,
               sizeof(suffix) - 1u) != 0) {
        return false;
    }
    for (index = sizeof(prefix) - 1u;
         index < (sizeof(prefix) - 1u) + 20u;
         ++index) {
        if (name[index] < '0' || name[index] > '9') {
            return false;
        }
    }
    return true;
}

static sfs_result_t cleanup_temporary_segments(sfs_partition_t *partition,
                                               sfs_error_t *error)
{
    DIR *directory = opendir(partition->directory);
    struct dirent *entry;
    bool removed = false;
    if (directory == NULL) {
        int saved_errno = errno;
        return set_error(error,
                         SFS_ERR_IO,
                         saved_errno,
                         "cannot inspect temporary segments: %s",
                         strerror(saved_errno));
    }
    while ((entry = readdir(directory)) != NULL) {
        char *path;
        if (!is_temporary_segment_name(entry->d_name)) {
            continue;
        }
        path = path_join(partition->directory, entry->d_name);
        if (path == NULL) {
            (void)closedir(directory);
            return set_error(error,
                             SFS_ERR_NOMEM,
                             errno,
                             "cannot allocate temporary segment path");
        }
        if (unlink(path) != 0 && errno != ENOENT) {
            int saved_errno = errno;
            free(path);
            (void)closedir(directory);
            return set_error(error,
                             SFS_ERR_IO,
                             saved_errno,
                             "cannot remove interrupted segment creation: %s",
                             strerror(saved_errno));
        }
        free(path);
        removed = true;
    }
    (void)closedir(directory);
    if (removed) {
        fsync_directory_best_effort(partition->directory);
    }
    return SFS_OK;
}

static int compare_u64(const void *left, const void *right)
{
    uint64_t left_value = *(const uint64_t *)left;
    uint64_t right_value = *(const uint64_t *)right;
    return left_value < right_value ? -1 : (left_value > right_value ? 1 : 0);
}

static sfs_result_t reserve_segments(sfs_partition_t *partition,
                                     size_t required,
                                     sfs_error_t *error)
{
    sfs_segment_meta_t *resized;
    size_t capacity;
    if (required <= partition->segment_capacity) {
        return SFS_OK;
    }
    capacity = partition->segment_capacity == 0u ? 4u : partition->segment_capacity;
    while (capacity < required) {
        if (capacity > SIZE_MAX / 2u) {
            return set_error(error, SFS_ERR_NOMEM, 0, "segment index is too large");
        }
        capacity *= 2u;
    }
    resized = (sfs_segment_meta_t *)realloc(
        partition->segments, capacity * sizeof(*partition->segments));
    if (resized == NULL) {
        return set_error(error, SFS_ERR_NOMEM, errno, "cannot grow segment index");
    }
    partition->segments = resized;
    partition->segment_capacity = capacity;
    return SFS_OK;
}

static bool manifest_slot_decode(const uint8_t *slot,
                                 sfs_loaded_manifest_t *manifest)
{
    uint32_t partition_id;
    if (memcmp(slot, SFS_MANIFEST_MAGIC, sizeof(SFS_MANIFEST_MAGIC)) != 0 ||
        load_u32_le(slot + 8u) != SFS_FORMAT_VERSION ||
        load_u32_le(slot + 12u) != SFS_MANIFEST_SLOT_SIZE ||
        load_u32_le(slot + 40u) != SFS_MAX_PARTITIONS ||
        load_u64_le(slot + SFS_MANIFEST_COMMIT_OFFSET) !=
            SFS_MANIFEST_COMMIT_MARKER ||
        load_u32_le(slot + SFS_MANIFEST_CRC_OFFSET) !=
            sfs_crc32c(slot, SFS_MANIFEST_CRC_OFFSET)) {
        return false;
    }
    memset(manifest, 0, sizeof(*manifest));
    manifest->generation = load_u64_le(slot + 16u);
    manifest->next_sequence = load_u64_le(slot + 24u);
    manifest->segment_size = load_u64_le(slot + 32u);
    if (manifest->generation == 0u || manifest->next_sequence == 0u) {
        return false;
    }
    for (partition_id = 0u; partition_id < SFS_MAX_PARTITIONS; ++partition_id) {
        const uint8_t *entry = slot + SFS_MANIFEST_PARTITIONS_OFFSET +
                               partition_id * SFS_MANIFEST_PARTITION_SIZE;
        sfs_loaded_manifest_partition_t *target =
            &manifest->partitions[partition_id];
        target->quota_bytes = load_u64_le(entry);
        target->next_segment_id = load_u64_le(entry + 8u);
        target->first_retained_segment_id = load_u64_le(entry + 16u);
        target->evicted_segments = load_u64_le(entry + 24u);
        target->evicted_records = load_u64_le(entry + 32u);
        target->evicted_payload_bytes = load_u64_le(entry + 40u);
        if (target->quota_bytes != 0u &&
            (target->next_segment_id == 0u ||
             target->first_retained_segment_id == 0u)) {
            return false;
        }
    }
    return true;
}

static sfs_result_t manifest_save(sfs_store_t *store, sfs_error_t *error)
{
    int target_slot = store->manifest_active_slot < 0
                          ? 0
                          : (store->manifest_active_slot + 1) %
                                (int)SFS_MANIFEST_SLOT_COUNT;
    uint8_t *slot = store->manifest_map +
                    (size_t)target_slot * SFS_MANIFEST_SLOT_SIZE;
    uint32_t partition_id;
    uint64_t next_generation = store->manifest_generation + 1u;
    if (next_generation == 0u) {
        return set_error(error,
                         SFS_ERR_FULL,
                         0,
                         "manifest generation is exhausted");
    }
    memset(slot, 0, SFS_MANIFEST_SLOT_SIZE);
    memcpy(slot, SFS_MANIFEST_MAGIC, sizeof(SFS_MANIFEST_MAGIC));
    store_u32_le(slot + 8u, SFS_FORMAT_VERSION);
    store_u32_le(slot + 12u, SFS_MANIFEST_SLOT_SIZE);
    store_u64_le(slot + 16u, next_generation);
    store_u64_le(slot + 24u, store->next_sequence);
    store_u64_le(slot + 32u, store->segment_size);
    store_u32_le(slot + 40u, SFS_MAX_PARTITIONS);
    for (partition_id = 0u; partition_id < SFS_MAX_PARTITIONS; ++partition_id) {
        uint8_t *entry = slot + SFS_MANIFEST_PARTITIONS_OFFSET +
                         partition_id * SFS_MANIFEST_PARTITION_SIZE;
        const sfs_partition_t *source = &store->partitions[partition_id];
        store_u64_le(entry, source->quota_bytes);
        store_u64_le(entry + 8u, source->next_segment_id);
        store_u64_le(entry + 16u, source->first_retained_segment_id);
        store_u64_le(entry + 24u, source->evicted_segments);
        store_u64_le(entry + 32u, source->evicted_records);
        store_u64_le(entry + 40u, source->evicted_payload_bytes);
    }
    store_u32_le(slot + SFS_MANIFEST_CRC_OFFSET,
                 sfs_crc32c(slot, SFS_MANIFEST_CRC_OFFSET));
    atomic_thread_fence(memory_order_release);
    if (msync(store->manifest_map, SFS_MANIFEST_SIZE, MS_SYNC) != 0) {
        int saved_errno = errno;
        return set_error(error,
                         SFS_ERR_IO,
                         saved_errno,
                         "cannot flush manifest body: %s",
                         strerror(saved_errno));
    }
    store_u64_le(slot + SFS_MANIFEST_COMMIT_OFFSET,
                 SFS_MANIFEST_COMMIT_MARKER);
    atomic_thread_fence(memory_order_release);
    if (msync(store->manifest_map, SFS_MANIFEST_SIZE, MS_SYNC) != 0 ||
        fsync(store->manifest_fd) != 0) {
        int saved_errno = errno;
        return set_error(error,
                         SFS_ERR_IO,
                         saved_errno,
                         "cannot commit manifest: %s",
                         strerror(saved_errno));
    }
    store->manifest_active_slot = target_slot;
    store->manifest_generation = next_generation;
    return SFS_OK;
}

static sfs_result_t lock_store_directory(sfs_store_t *store, sfs_error_t *error)
{
    char *path = path_join(store->directory, SFS_LOCK_FILE);
    if (path == NULL) {
        return set_error(error, SFS_ERR_NOMEM, errno, "cannot allocate lock path");
    }
    store->lock_fd = open(path, O_RDWR | O_CREAT, 0600);
    free(path);
    if (store->lock_fd < 0) {
        int saved_errno = errno;
        return set_error(error,
                         SFS_ERR_IO,
                         saved_errno,
                         "cannot open store lock: %s",
                         strerror(saved_errno));
    }
    if (flock(store->lock_fd, LOCK_EX | LOCK_NB) != 0) {
        int saved_errno = errno;
        return set_error(error,
                         (saved_errno == EWOULDBLOCK || saved_errno == EAGAIN ||
                          saved_errno == EACCES)
                             ? SFS_ERR_BUSY
                             : SFS_ERR_IO,
                         saved_errno,
                         "store writer lock is busy");
    }
    return SFS_OK;
}

static sfs_result_t open_manifest(sfs_store_t *store,
                                  const sfs_open_options_t *options,
                                  sfs_error_t *error)
{
    char *path = path_join(store->directory, SFS_MANIFEST_FILE);
    struct stat status;
    bool new_manifest;
    int open_flags = O_RDWR;
    sfs_loaded_manifest_t decoded[2];
    bool valid[2] = {false, false};
    int selected = -1;
    uint32_t partition_id;
    if (path == NULL) {
        return set_error(error,
                         SFS_ERR_NOMEM,
                         errno,
                         "cannot allocate manifest path");
    }
    if ((options->flags & SFS_OPEN_CREATE) != 0u) {
        open_flags |= O_CREAT;
    }
    store->manifest_fd = open(path, open_flags, 0600);
    free(path);
    if (store->manifest_fd < 0) {
        int saved_errno = errno;
        return set_error(error,
                         SFS_ERR_IO,
                         saved_errno,
                         "cannot open manifest: %s",
                         strerror(saved_errno));
    }
    if (fstat(store->manifest_fd, &status) != 0) {
        int saved_errno = errno;
        return set_error(error,
                         SFS_ERR_IO,
                         saved_errno,
                         "cannot stat manifest: %s",
                         strerror(saved_errno));
    }
    new_manifest = status.st_size == 0;
    if (!new_manifest && status.st_size != (off_t)SFS_MANIFEST_SIZE) {
        return set_error(error,
                         SFS_ERR_CORRUPT,
                         0,
                         "manifest size is invalid");
    }
    if (new_manifest) {
        bool any_partition = false;
        if ((options->flags & SFS_OPEN_CREATE) == 0u) {
            return set_error(error,
                             SFS_ERR_IO,
                             ENOENT,
                             "store does not exist");
        }
        store->segment_size = options->segment_size == 0u
                                  ? SFS_DEFAULT_SEGMENT_SIZE
                                  : options->segment_size;
        if (store->segment_size < SFS_MIN_SEGMENT_SIZE ||
            store->segment_size > SIZE_MAX) {
            return set_error(error,
                             SFS_ERR_INVALID_ARGUMENT,
                             0,
                             "segment_size must be between %u and SIZE_MAX",
                             SFS_MIN_SEGMENT_SIZE);
        }
        store->next_sequence = 1u;
        for (partition_id = 0u; partition_id < SFS_MAX_PARTITIONS;
             ++partition_id) {
            sfs_partition_t *partition = &store->partitions[partition_id];
            partition->quota_bytes = options->partition_quotas[partition_id];
            partition->enabled = partition->quota_bytes != 0u;
            partition->next_segment_id = 1u;
            partition->first_retained_segment_id = 1u;
            if (partition->enabled) {
                any_partition = true;
                if (partition->quota_bytes < store->segment_size) {
                    return set_error(error,
                                     SFS_ERR_INVALID_ARGUMENT,
                                     0,
                                     "partition %u quota is smaller than one segment",
                                     partition_id);
                }
            }
        }
        if (!any_partition) {
            return set_error(error,
                             SFS_ERR_INVALID_ARGUMENT,
                             0,
                             "at least one partition quota must be non-zero");
        }
        if (ftruncate(store->manifest_fd, (off_t)SFS_MANIFEST_SIZE) != 0) {
            int saved_errno = errno;
            return set_error(error,
                             SFS_ERR_IO,
                             saved_errno,
                             "cannot size manifest: %s",
                             strerror(saved_errno));
        }
    }
    store->manifest_map = (uint8_t *)mmap(NULL,
                                          SFS_MANIFEST_SIZE,
                                          PROT_READ | PROT_WRITE,
                                          MAP_SHARED,
                                          store->manifest_fd,
                                          0);
    if (store->manifest_map == MAP_FAILED) {
        int saved_errno = errno;
        store->manifest_map = NULL;
        return set_error(error,
                         SFS_ERR_IO,
                         saved_errno,
                         "cannot map manifest: %s",
                         strerror(saved_errno));
    }
    if (new_manifest) {
        memset(store->manifest_map, 0, SFS_MANIFEST_SIZE);
        store->manifest_active_slot = -1;
        store->manifest_generation = 0u;
        return manifest_save(store, error);
    }
    valid[0] = manifest_slot_decode(store->manifest_map, &decoded[0]);
    valid[1] = manifest_slot_decode(store->manifest_map + SFS_MANIFEST_SLOT_SIZE,
                                    &decoded[1]);
    if (valid[0] && valid[1]) {
        selected = decoded[1].generation > decoded[0].generation ? 1 : 0;
    } else if (valid[0]) {
        selected = 0;
    } else if (valid[1]) {
        selected = 1;
    } else {
        uint32_t version0 = load_u32_le(store->manifest_map + 8u);
        uint32_t version1 = load_u32_le(store->manifest_map +
                                        SFS_MANIFEST_SLOT_SIZE + 8u);
        return set_error(error,
                         (version0 != 0u && version0 != SFS_FORMAT_VERSION) ||
                                 (version1 != 0u && version1 != SFS_FORMAT_VERSION)
                             ? SFS_ERR_FORMAT_VERSION
                             : SFS_ERR_CORRUPT,
                         0,
                         "manifest has no valid committed slot");
    }
    store->manifest_active_slot = selected;
    store->manifest_generation = decoded[selected].generation;
    store->segment_size = decoded[selected].segment_size;
    store->next_sequence = decoded[selected].next_sequence;
    if ((options->segment_size != 0u &&
         options->segment_size != store->segment_size) ||
        store->segment_size < SFS_MIN_SEGMENT_SIZE ||
        store->segment_size > SIZE_MAX) {
        return set_error(error,
                         SFS_ERR_INVALID_ARGUMENT,
                         0,
                         "configured segment_size does not match the store");
    }
    for (partition_id = 0u; partition_id < SFS_MAX_PARTITIONS; ++partition_id) {
        const sfs_loaded_manifest_partition_t *source =
            &decoded[selected].partitions[partition_id];
        sfs_partition_t *target = &store->partitions[partition_id];
        if (options->partition_quotas[partition_id] != 0u &&
            options->partition_quotas[partition_id] != source->quota_bytes) {
            return set_error(error,
                             SFS_ERR_INVALID_ARGUMENT,
                             0,
                             "partition %u quota does not match the store",
                             partition_id);
        }
        target->quota_bytes = source->quota_bytes;
        target->enabled = source->quota_bytes != 0u;
        target->next_segment_id = source->next_segment_id;
        target->first_retained_segment_id = source->first_retained_segment_id;
        target->evicted_segments = source->evicted_segments;
        target->evicted_records = source->evicted_records;
        target->evicted_payload_bytes = source->evicted_payload_bytes;
    }
    return SFS_OK;
}

static void encode_segment_header(uint8_t *header,
                                  uint32_t partition_id,
                                  uint64_t segment_id,
                                  uint64_t segment_size,
                                  uint64_t first_sequence)
{
    memset(header, 0, SFS_SEGMENT_HEADER_SIZE);
    memcpy(header, SFS_SEGMENT_MAGIC, sizeof(SFS_SEGMENT_MAGIC));
    store_u32_le(header + 8u, SFS_FORMAT_VERSION);
    store_u32_le(header + 12u, SFS_SEGMENT_HEADER_SIZE);
    store_u64_le(header + 16u, segment_id);
    store_u64_le(header + 24u, segment_size);
    store_u32_le(header + 32u, partition_id);
    store_u64_le(header + 40u, first_sequence);
    store_u32_le(header + SFS_SEGMENT_CRC_OFFSET,
                 sfs_crc32c(header, SFS_SEGMENT_CRC_OFFSET));
}

static sfs_result_t validate_segment_header(const uint8_t *header,
                                            uint32_t partition_id,
                                            uint64_t segment_id,
                                            uint64_t segment_size,
                                            uint64_t *out_first_sequence,
                                            sfs_error_t *error)
{
    uint32_t version;
    if (memcmp(header, SFS_SEGMENT_MAGIC, sizeof(SFS_SEGMENT_MAGIC)) != 0) {
        return set_error(error,
                         SFS_ERR_CORRUPT,
                         0,
                         "segment %" PRIu64 " has invalid magic",
                         segment_id);
    }
    version = load_u32_le(header + 8u);
    if (version != SFS_FORMAT_VERSION) {
        return set_error(error,
                         SFS_ERR_FORMAT_VERSION,
                         0,
                         "segment %" PRIu64 " uses format version %u",
                         segment_id,
                         version);
    }
    if (load_u32_le(header + 12u) != SFS_SEGMENT_HEADER_SIZE ||
        load_u64_le(header + 16u) != segment_id ||
        load_u64_le(header + 24u) != segment_size ||
        load_u32_le(header + 32u) != partition_id ||
        load_u32_le(header + SFS_SEGMENT_CRC_OFFSET) !=
            sfs_crc32c(header, SFS_SEGMENT_CRC_OFFSET)) {
        return set_error(error,
                         SFS_ERR_CORRUPT,
                         0,
                         "segment %" PRIu64 " header is corrupt",
                         segment_id);
    }
    *out_first_sequence = load_u64_le(header + 40u);
    if (*out_first_sequence == 0u) {
        return set_error(error,
                         SFS_ERR_CORRUPT,
                         0,
                         "segment %" PRIu64 " has invalid first sequence",
                         segment_id);
    }
    return SFS_OK;
}

static bool committed_marker_follows(const uint8_t *mapping,
                                     uint64_t file_size,
                                     uint64_t segment_size,
                                     uint64_t frame_offset)
{
    uint64_t limit = file_size < segment_size ? file_size : segment_size;
    uint64_t marker_offset = frame_offset + SFS_FRAME_PREFIX_SIZE;
    while (marker_offset <= limit && limit - marker_offset >= SFS_FRAME_COMMIT_SIZE) {
        if (load_u64_le(mapping + marker_offset) == SFS_FRAME_COMMIT_MARKER) {
            return true;
        }
        marker_offset += 8u;
    }
    return false;
}

static int decode_frame(const uint8_t *mapping,
                        uint64_t file_size,
                        uint64_t segment_size,
                        uint64_t offset,
                        sfs_frame_view_t *frame,
                        sfs_error_t *error)
{
    const uint8_t *prefix;
    uint64_t expected_length;
    uint64_t index;
    bool prefix_zero = true;
    if (offset == file_size) {
        return SFS_END;
    }
    if (offset > file_size) {
        return SFS_INTERNAL_TORN;
    }
    if (file_size - offset < SFS_FRAME_PREFIX_SIZE) {
        /*
         * A valid frame can leave 1..23 bytes at the end of a fixed-size
         * segment. A clean preallocated tail is all zero and is a normal EOF,
         * including after the segment has been sealed by rotation. Preserve
         * strict torn-write detection when any byte of that short tail was
         * actually touched.
         */
        for (index = offset; index < file_size; ++index) {
            if (mapping[index] != 0u) {
                return SFS_INTERNAL_TORN;
            }
        }
        return SFS_END;
    }
    prefix = mapping + offset;
    for (index = 0u; index < SFS_FRAME_PREFIX_SIZE; ++index) {
        if (prefix[index] != 0u) {
            prefix_zero = false;
            break;
        }
    }
    if (prefix_zero) {
        return committed_marker_follows(mapping,
                                        file_size,
                                        segment_size,
                                        offset)
                   ? set_error(error,
                               SFS_ERR_CORRUPT,
                               0,
                               "committed frame header at offset %" PRIu64
                               " was cleared",
                               offset)
                   : SFS_END;
    }
    frame->total_length = load_u32_le(prefix);
    frame->payload_length = load_u32_le(prefix + 4u);
    frame->sequence = load_u64_le(prefix + 8u);
    if (load_u32_le(prefix + 20u) != sfs_crc32c(prefix, 20u)) {
        return committed_marker_follows(mapping,
                                        file_size,
                                        segment_size,
                                        offset)
                   ? set_error(error,
                               SFS_ERR_CORRUPT,
                               0,
                               "committed frame header at offset %" PRIu64
                               " failed CRC32C",
                               offset)
                   : SFS_INTERNAL_TORN;
    }
    expected_length = align_eight(SFS_FRAME_PREFIX_SIZE +
                                  (uint64_t)frame->payload_length) +
                      SFS_FRAME_COMMIT_SIZE;
    if (frame->total_length != expected_length ||
        frame->total_length < SFS_MIN_FRAME_SIZE ||
        (frame->total_length & 7u) != 0u ||
        frame->total_length > segment_size - offset) {
        return committed_marker_follows(mapping,
                                        file_size,
                                        segment_size,
                                        offset)
                   ? set_error(error,
                               SFS_ERR_CORRUPT,
                               0,
                               "committed frame length at offset %" PRIu64
                               " is corrupt",
                               offset)
                   : SFS_INTERNAL_TORN;
    }
    frame->payload_offset = offset + SFS_FRAME_PREFIX_SIZE;
    frame->commit_offset = offset + frame->total_length - SFS_FRAME_COMMIT_SIZE;
    if (offset + frame->total_length > file_size) {
        return SFS_INTERNAL_TORN;
    }
    if (load_u64_le(mapping + frame->commit_offset) !=
        SFS_FRAME_COMMIT_MARKER) {
        return SFS_INTERNAL_TORN;
    }
    if (frame->sequence == 0u ||
        load_u32_le(prefix + 16u) !=
            sfs_crc32c(mapping + frame->payload_offset,
                       frame->payload_length)) {
        return set_error(error,
                         SFS_ERR_CORRUPT,
                         0,
                         "committed frame at offset %" PRIu64 " failed CRC32C",
                         offset);
    }
    for (index = frame->payload_offset + frame->payload_length;
         index < frame->commit_offset;
         ++index) {
        if (mapping[index] != 0u) {
            return set_error(error,
                             SFS_ERR_CORRUPT,
                             0,
                             "committed frame at offset %" PRIu64
                             " has non-zero alignment padding",
                             offset);
        }
    }
    return SFS_OK;
}

static sfs_result_t scan_segment_file(sfs_store_t *store,
                                      uint32_t partition_id,
                                      uint64_t segment_id,
                                      bool active,
                                      sfs_segment_meta_t *meta,
                                      sfs_error_t *error)
{
    sfs_partition_t *partition = &store->partitions[partition_id];
    char *path = segment_path(partition, segment_id);
    int descriptor;
    struct stat status;
    uint8_t *mapping;
    uint64_t file_size;
    uint64_t offset = SFS_SEGMENT_HEADER_SIZE;
    uint64_t previous_sequence = 0u;
    uint64_t header_first_sequence = 0u;
    int frame_result;
    if (path == NULL) {
        return set_error(error, SFS_ERR_NOMEM, errno, "cannot allocate segment path");
    }
    descriptor = open(path, O_RDWR);
    free(path);
    if (descriptor < 0) {
        int saved_errno = errno;
        return set_error(error,
                         SFS_ERR_IO,
                         saved_errno,
                         "cannot open segment %" PRIu64 ": %s",
                         segment_id,
                         strerror(saved_errno));
    }
    if (fstat(descriptor, &status) != 0 || status.st_size < 0) {
        int saved_errno = errno;
        (void)close(descriptor);
        return set_error(error,
                         SFS_ERR_IO,
                         saved_errno,
                         "cannot stat segment %" PRIu64,
                         segment_id);
    }
    file_size = (uint64_t)status.st_size;
    if (file_size < SFS_SEGMENT_HEADER_SIZE || file_size > store->segment_size ||
        (!active && file_size != store->segment_size)) {
        (void)close(descriptor);
        return set_error(error,
                         SFS_ERR_CORRUPT,
                         0,
                         "segment %" PRIu64 " has invalid file size",
                         segment_id);
    }
    mapping = (uint8_t *)mmap(NULL,
                              (size_t)file_size,
                              PROT_READ | PROT_WRITE,
                              MAP_SHARED,
                              descriptor,
                              0);
    if (mapping == MAP_FAILED) {
        int saved_errno = errno;
        (void)close(descriptor);
        return set_error(error,
                         SFS_ERR_IO,
                         saved_errno,
                         "cannot map segment %" PRIu64 ": %s",
                         segment_id,
                         strerror(saved_errno));
    }
    {
        sfs_result_t header_result = validate_segment_header(mapping,
                                                             partition_id,
                                                             segment_id,
                                                             store->segment_size,
                                                             &header_first_sequence,
                                                             error);
        if (header_result != SFS_OK) {
            (void)munmap(mapping, (size_t)file_size);
            (void)close(descriptor);
            return header_result;
        }
    }
    memset(meta, 0, sizeof(*meta));
    meta->id = segment_id;
    for (;;) {
        sfs_frame_view_t frame;
        frame_result = decode_frame(mapping,
                                    file_size,
                                    store->segment_size,
                                    offset,
                                    &frame,
                                    error);
        if (frame_result == SFS_END || frame_result == SFS_INTERNAL_TORN) {
            break;
        }
        if (frame_result != SFS_OK) {
            (void)munmap(mapping, (size_t)file_size);
            (void)close(descriptor);
            return (sfs_result_t)frame_result;
        }
        if (previous_sequence != 0u && frame.sequence <= previous_sequence) {
            (void)munmap(mapping, (size_t)file_size);
            (void)close(descriptor);
            return set_error(error,
                             SFS_ERR_CORRUPT,
                             0,
                             "segment %" PRIu64 " sequence order is corrupt",
                             segment_id);
        }
        if (meta->record_count == 0u) {
            meta->first_sequence = frame.sequence;
        }
        meta->last_sequence = frame.sequence;
        meta->record_count += 1u;
        meta->payload_bytes += frame.payload_length;
        previous_sequence = frame.sequence;
        offset += frame.total_length;
    }
    meta->write_offset = offset;
    if (frame_result == SFS_INTERNAL_TORN && !active) {
        (void)munmap(mapping, (size_t)file_size);
        (void)close(descriptor);
        return set_error(error,
                         SFS_ERR_CORRUPT,
                         0,
                         "sealed segment %" PRIu64 " has a torn tail",
                         segment_id);
    }
    if (active && (frame_result == SFS_INTERNAL_TORN ||
                   file_size != store->segment_size)) {
        uint64_t discarded = file_size > offset ? file_size - offset : 0u;
        (void)munmap(mapping, (size_t)file_size);
        if (ftruncate(descriptor, (off_t)store->segment_size) != 0) {
            int saved_errno = errno;
            (void)close(descriptor);
            return set_error(error,
                             SFS_ERR_IO,
                             saved_errno,
                             "cannot restore segment %" PRIu64 " size: %s",
                             segment_id,
                             strerror(saved_errno));
        }
        mapping = (uint8_t *)mmap(NULL,
                                  (size_t)store->segment_size,
                                  PROT_READ | PROT_WRITE,
                                  MAP_SHARED,
                                  descriptor,
                                  0);
        if (mapping == MAP_FAILED) {
            int saved_errno = errno;
            (void)close(descriptor);
            return set_error(error,
                             SFS_ERR_IO,
                             saved_errno,
                             "cannot remap recovered segment: %s",
                             strerror(saved_errno));
        }
        memset(mapping + offset, 0, (size_t)(store->segment_size - offset));
        if (msync(mapping, (size_t)store->segment_size, MS_SYNC) != 0 ||
            fsync(descriptor) != 0) {
            int saved_errno = errno;
            (void)munmap(mapping, (size_t)store->segment_size);
            (void)close(descriptor);
            return set_error(error,
                             SFS_ERR_IO,
                             saved_errno,
                             "cannot persist recovered tail: %s",
                             strerror(saved_errno));
        }
        store->status_flags |= SFS_STATUS_RECOVERED_TAIL;
        store->recovery_partition_id = partition_id;
        store->recovery_segment_id = segment_id;
        store->recovery_offset = offset;
        store->recovery_discarded_bytes += discarded;
        file_size = store->segment_size;
    }
    if (active) {
        partition->active_fd = descriptor;
        partition->active_map = mapping;
        partition->active_write_offset = offset;
        partition->durable_offset = offset;
    } else {
        (void)munmap(mapping, (size_t)file_size);
        (void)close(descriptor);
    }
    return SFS_OK;
}

static sfs_result_t enumerate_segment_ids(sfs_partition_t *partition,
                                          uint64_t **out_ids,
                                          size_t *out_count,
                                          sfs_error_t *error)
{
    DIR *directory = opendir(partition->directory);
    struct dirent *entry;
    uint64_t *ids = NULL;
    size_t count = 0u;
    size_t capacity = 0u;
    if (directory == NULL) {
        int saved_errno = errno;
        return set_error(error,
                         SFS_ERR_IO,
                         saved_errno,
                         "cannot list partition directory: %s",
                         strerror(saved_errno));
    }
    while ((entry = readdir(directory)) != NULL) {
        uint64_t id;
        if (!parse_segment_name(entry->d_name, &id)) {
            continue;
        }
        if (count == capacity) {
            size_t new_capacity = capacity == 0u ? 8u : capacity * 2u;
            uint64_t *resized =
                (uint64_t *)realloc(ids, new_capacity * sizeof(*ids));
            if (resized == NULL) {
                free(ids);
                (void)closedir(directory);
                return set_error(error,
                                 SFS_ERR_NOMEM,
                                 errno,
                                 "cannot allocate segment id list");
            }
            ids = resized;
            capacity = new_capacity;
        }
        ids[count++] = id;
    }
    (void)closedir(directory);
    qsort(ids, count, sizeof(*ids), compare_u64);
    *out_ids = ids;
    *out_count = count;
    return SFS_OK;
}

static sfs_result_t create_segment(sfs_store_t *store,
                                   uint32_t partition_id,
                                   sfs_error_t *error)
{
    sfs_partition_t *partition = &store->partitions[partition_id];
    uint64_t segment_id = partition->next_segment_id;
    char *path;
    char *temporary_path;
    int descriptor;
    uint8_t *mapping;
    sfs_segment_meta_t *meta;
    sfs_result_t result;
    if (segment_id == 0u || segment_id == UINT64_MAX) {
        return set_error(error,
                         SFS_ERR_FULL,
                         0,
                         "partition %u exhausted segment ids",
                         partition_id);
    }
    result = reserve_segments(partition, partition->segment_count + 1u, error);
    if (result != SFS_OK) {
        return result;
    }
    path = segment_path(partition, segment_id);
    temporary_path = temporary_segment_path(partition, segment_id);
    if (path == NULL || temporary_path == NULL) {
        free(path);
        free(temporary_path);
        return set_error(error, SFS_ERR_NOMEM, errno, "cannot allocate segment path");
    }
    descriptor = open(temporary_path, O_RDWR | O_CREAT | O_EXCL, 0600);
    if (descriptor < 0) {
        int saved_errno = errno;
        free(path);
        free(temporary_path);
        return set_error(error,
                         SFS_ERR_IO,
                         saved_errno,
                         "cannot create temporary segment %" PRIu64 ": %s",
                         segment_id,
                         strerror(saved_errno));
    }
    if (ftruncate(descriptor, (off_t)store->segment_size) != 0) {
        int saved_errno = errno;
        (void)close(descriptor);
        (void)unlink(temporary_path);
        free(path);
        free(temporary_path);
        return set_error(error,
                         SFS_ERR_IO,
                         saved_errno,
                         "cannot size segment %" PRIu64 ": %s",
                         segment_id,
                         strerror(saved_errno));
    }
    mapping = (uint8_t *)mmap(NULL,
                              (size_t)store->segment_size,
                              PROT_READ | PROT_WRITE,
                              MAP_SHARED,
                              descriptor,
                              0);
    if (mapping == MAP_FAILED) {
        int saved_errno = errno;
        (void)close(descriptor);
        (void)unlink(temporary_path);
        free(path);
        free(temporary_path);
        return set_error(error,
                         SFS_ERR_IO,
                         saved_errno,
                         "cannot map new segment: %s",
                         strerror(saved_errno));
    }
    encode_segment_header(mapping,
                          partition_id,
                          segment_id,
                          store->segment_size,
                          store->next_sequence);
    if (msync(mapping, SFS_SEGMENT_HEADER_SIZE, MS_SYNC) != 0 ||
        fsync(descriptor) != 0) {
        int saved_errno = errno;
        (void)munmap(mapping, (size_t)store->segment_size);
        (void)close(descriptor);
        (void)unlink(temporary_path);
        free(path);
        free(temporary_path);
        return set_error(error,
                         SFS_ERR_IO,
                         saved_errno,
                         "cannot commit new segment header: %s",
                         strerror(saved_errno));
    }
    {
        struct stat existing;
        int existing_result = lstat(path, &existing);
        if (existing_result == 0 || errno != ENOENT) {
            int saved_errno = existing_result == 0 ? EEXIST : errno;
            (void)munmap(mapping, (size_t)store->segment_size);
            (void)close(descriptor);
            (void)unlink(temporary_path);
            free(path);
            free(temporary_path);
            return set_error(error,
                             SFS_ERR_CORRUPT,
                             saved_errno,
                             "segment %" PRIu64 " already exists",
                             segment_id);
        }
    }
    if (rename(temporary_path, path) != 0) {
        int saved_errno = errno;
        (void)munmap(mapping, (size_t)store->segment_size);
        (void)close(descriptor);
        (void)unlink(temporary_path);
        free(path);
        free(temporary_path);
        return set_error(error,
                         SFS_ERR_IO,
                         saved_errno,
                         "cannot publish segment %" PRIu64 ": %s",
                         segment_id,
                         strerror(saved_errno));
    }
    fsync_directory_best_effort(partition->directory);
    free(path);
    free(temporary_path);
    meta = &partition->segments[partition->segment_count++];
    memset(meta, 0, sizeof(*meta));
    meta->id = segment_id;
    meta->write_offset = SFS_SEGMENT_HEADER_SIZE;
    partition->active_fd = descriptor;
    partition->active_map = mapping;
    partition->active_write_offset = SFS_SEGMENT_HEADER_SIZE;
    partition->durable_offset = SFS_SEGMENT_HEADER_SIZE;
    partition->next_segment_id += 1u;
    if (partition->segment_count == 1u) {
        partition->first_retained_segment_id = segment_id;
    }
    return manifest_save(store, error);
}

static sfs_result_t load_partition(sfs_store_t *store,
                                   uint32_t partition_id,
                                   bool create,
                                   sfs_error_t *error)
{
    sfs_partition_t *partition = &store->partitions[partition_id];
    uint64_t *ids = NULL;
    size_t id_count = 0u;
    size_t index;
    sfs_result_t result;
    partition->directory = partition_path(store->directory, partition_id);
    if (partition->directory == NULL) {
        return set_error(error,
                         SFS_ERR_NOMEM,
                         errno,
                         "cannot allocate partition directory path");
    }
    result = ensure_directory(partition->directory, create, error);
    if (result != SFS_OK) {
        return result;
    }
    result = cleanup_temporary_segments(partition, error);
    if (result != SFS_OK) {
        return result;
    }
    result = enumerate_segment_ids(partition, &ids, &id_count, error);
    if (result != SFS_OK) {
        return result;
    }
    for (index = 0u; index < id_count; ++index) {
        if (ids[index] < partition->first_retained_segment_id) {
            char *obsolete = segment_path(partition, ids[index]);
            if (obsolete == NULL || unlink(obsolete) != 0) {
                int saved_errno = errno;
                free(obsolete);
                free(ids);
                return set_error(error,
                                 SFS_ERR_IO,
                                 saved_errno,
                                 "cannot finish eviction of segment %" PRIu64,
                                 ids[index]);
            }
            free(obsolete);
            memmove(&ids[index],
                    &ids[index + 1u],
                    (id_count - index - 1u) * sizeof(*ids));
            --id_count;
            --index;
        }
    }
    if (id_count == 0u) {
        free(ids);
        return create_segment(store, partition_id, error);
    }
    if (ids[0] != partition->first_retained_segment_id) {
        uint64_t first_id = ids[0];
        free(ids);
        return set_error(error,
                         SFS_ERR_CORRUPT,
                         0,
                         "partition %u is missing retained segment %" PRIu64,
                         partition_id,
                         first_id);
    }
    for (index = 1u; index < id_count; ++index) {
        if (ids[index] != ids[index - 1u] + 1u) {
            free(ids);
            return set_error(error,
                             SFS_ERR_CORRUPT,
                             0,
                             "partition %u has a segment id gap",
                             partition_id);
        }
    }
    if (id_count > partition->quota_bytes / store->segment_size) {
        free(ids);
        return set_error(error,
                         SFS_ERR_CORRUPT,
                         0,
                         "partition %u exceeds its hard quota",
                         partition_id);
    }
    result = reserve_segments(partition, id_count, error);
    if (result != SFS_OK) {
        free(ids);
        return result;
    }
    for (index = 0u; index < id_count; ++index) {
        sfs_segment_meta_t meta;
        bool active = index + 1u == id_count;
        result = scan_segment_file(store,
                                   partition_id,
                                   ids[index],
                                   active,
                                   &meta,
                                   error);
        if (result != SFS_OK) {
            free(ids);
            return result;
        }
        partition->segments[partition->segment_count++] = meta;
        partition->record_count += meta.record_count;
        partition->payload_bytes += meta.payload_bytes;
        if (meta.record_count != 0u) {
            if (partition->first_sequence == 0u) {
                partition->first_sequence = meta.first_sequence;
            }
            partition->last_sequence = meta.last_sequence;
            if (meta.last_sequence >= store->next_sequence) {
                if (meta.last_sequence == UINT64_MAX) {
                    free(ids);
                    return set_error(error,
                                     SFS_ERR_FULL,
                                     0,
                                     "global sequence is exhausted");
                }
                store->next_sequence = meta.last_sequence + 1u;
            }
        }
    }
    if (ids[id_count - 1u] >= partition->next_segment_id) {
        if (ids[id_count - 1u] == UINT64_MAX) {
            free(ids);
            return set_error(error, SFS_ERR_FULL, 0, "segment id is exhausted");
        }
        partition->next_segment_id = ids[id_count - 1u] + 1u;
    }
    free(ids);
    return SFS_OK;
}

static sfs_result_t flush_partition(sfs_store_t *store,
                                    sfs_partition_t *partition,
                                    sfs_error_t *error)
{
    uint64_t offset;
    int first_error = 0;
    if (partition->active_map == NULL ||
        partition->durable_offset >= partition->active_write_offset) {
        return SFS_OK;
    }
    offset = partition->durable_offset;
    while (offset < partition->active_write_offset) {
        uint32_t total_length = load_u32_le(partition->active_map + offset);
        uint64_t marker_offset;
        if (total_length < SFS_MIN_FRAME_SIZE || (total_length & 7u) != 0u ||
            total_length > partition->active_write_offset - offset) {
            return set_error(error,
                             SFS_ERR_CORRUPT,
                             0,
                             "active frame layout is corrupt during flush");
        }
        marker_offset = offset + total_length - SFS_FRAME_COMMIT_SIZE;
        store_u64_le(partition->active_map + marker_offset, 0u);
        offset += total_length;
    }
    atomic_thread_fence(memory_order_release);
    if (msync(partition->active_map, (size_t)store->segment_size, MS_SYNC) != 0) {
        first_error = errno;
    }
    offset = partition->durable_offset;
    while (offset < partition->active_write_offset) {
        uint32_t total_length = load_u32_le(partition->active_map + offset);
        uint64_t marker_offset = offset + total_length - SFS_FRAME_COMMIT_SIZE;
        store_u64_le(partition->active_map + marker_offset,
                     SFS_FRAME_COMMIT_MARKER);
        offset += total_length;
    }
    atomic_thread_fence(memory_order_release);
    if (first_error == 0 &&
        (msync(partition->active_map,
               (size_t)store->segment_size,
               MS_SYNC) != 0 ||
         fsync(partition->active_fd) != 0)) {
        first_error = errno;
    }
    if (first_error != 0) {
        return set_error(error,
                         SFS_ERR_IO,
                         first_error,
                         "cannot flush segment: %s",
                         strerror(first_error));
    }
    partition->durable_offset = partition->active_write_offset;
    return SFS_OK;
}

static void close_active_segment(sfs_store_t *store, sfs_partition_t *partition)
{
    if (partition->active_map != NULL) {
        (void)munmap(partition->active_map, (size_t)store->segment_size);
        partition->active_map = NULL;
    }
    if (partition->active_fd >= 0) {
        (void)close(partition->active_fd);
        partition->active_fd = -1;
    }
}

static sfs_result_t evict_oldest_segment(sfs_store_t *store,
                                         uint32_t partition_id,
                                         sfs_error_t *error)
{
    sfs_partition_t *partition = &store->partitions[partition_id];
    sfs_segment_meta_t victim;
    char *path;
    sfs_result_t result;
    if (partition->segment_count == 0u) {
        return set_error(error, SFS_ERR_CORRUPT, 0, "no segment is available to evict");
    }
    victim = partition->segments[0];
    partition->evicted_segments += 1u;
    partition->evicted_records += victim.record_count;
    partition->evicted_payload_bytes += victim.payload_bytes;
    partition->first_retained_segment_id = victim.id + 1u;
    result = manifest_save(store, error);
    if (result != SFS_OK) {
        partition->evicted_segments -= 1u;
        partition->evicted_records -= victim.record_count;
        partition->evicted_payload_bytes -= victim.payload_bytes;
        partition->first_retained_segment_id = victim.id;
        return result;
    }
    path = segment_path(partition, victim.id);
    if (path == NULL || unlink(path) != 0) {
        int saved_errno = errno;
        free(path);
        return set_error(error,
                         SFS_ERR_IO,
                         saved_errno,
                         "cannot evict segment %" PRIu64 ": %s",
                         victim.id,
                         strerror(saved_errno));
    }
    free(path);
    fsync_directory_best_effort(partition->directory);
    partition->record_count -= victim.record_count;
    partition->payload_bytes -= victim.payload_bytes;
    memmove(&partition->segments[0],
            &partition->segments[1],
            (partition->segment_count - 1u) * sizeof(*partition->segments));
    partition->segment_count -= 1u;
    partition->first_sequence = partition->segment_count == 0u
                                    ? 0u
                                    : partition->segments[0].first_sequence;
    partition->last_sequence = partition->segment_count == 0u
                                   ? 0u
                                   : partition->segments[partition->segment_count - 1u]
                                         .last_sequence;
    return SFS_OK;
}

static sfs_result_t rotate_partition(sfs_store_t *store,
                                     uint32_t partition_id,
                                     sfs_error_t *error)
{
    sfs_partition_t *partition = &store->partitions[partition_id];
    sfs_result_t result = flush_partition(store, partition, error);
    if (result != SFS_OK) {
        return result;
    }
    close_active_segment(store, partition);
    while (partition->segment_count >=
           partition->quota_bytes / store->segment_size) {
        result = evict_oldest_segment(store, partition_id, error);
        if (result != SFS_OK) {
            return result;
        }
    }
    return create_segment(store, partition_id, error);
}

static sfs_result_t flush_locked(sfs_store_t *store, sfs_error_t *error)
{
    uint32_t partition_id;
    for (partition_id = 0u; partition_id < SFS_MAX_PARTITIONS; ++partition_id) {
        sfs_partition_t *partition = &store->partitions[partition_id];
        sfs_result_t result;
        if (!partition->enabled) {
            continue;
        }
        result = flush_partition(store, partition, error);
        if (result != SFS_OK) {
            return result;
        }
    }
    return manifest_save(store, error);
}

static sfs_result_t map_segment_for_read(sfs_store_t *store,
                                         uint32_t partition_id,
                                         size_t segment_index,
                                         const uint8_t **out_mapping,
                                         int *out_descriptor,
                                         bool *out_borrowed,
                                         sfs_error_t *error)
{
    sfs_partition_t *partition = &store->partitions[partition_id];
    sfs_segment_meta_t *meta = &partition->segments[segment_index];
    if (segment_index + 1u == partition->segment_count &&
        partition->active_map != NULL) {
        *out_mapping = partition->active_map;
        *out_descriptor = -1;
        *out_borrowed = true;
        return SFS_OK;
    }
    {
        char *path = segment_path(partition, meta->id);
        int descriptor;
        uint8_t *mapping;
        if (path == NULL) {
            return set_error(error,
                             SFS_ERR_NOMEM,
                             errno,
                             "cannot allocate scan path");
        }
        descriptor = open(path, O_RDONLY);
        free(path);
        if (descriptor < 0) {
            int saved_errno = errno;
            return set_error(error,
                             SFS_ERR_IO,
                             saved_errno,
                             "cannot open segment for scan: %s",
                             strerror(saved_errno));
        }
        mapping = (uint8_t *)mmap(NULL,
                                  (size_t)store->segment_size,
                                  PROT_READ,
                                  MAP_SHARED,
                                  descriptor,
                                  0);
        if (mapping == MAP_FAILED) {
            int saved_errno = errno;
            (void)close(descriptor);
            return set_error(error,
                             SFS_ERR_IO,
                             saved_errno,
                             "cannot map segment for scan: %s",
                             strerror(saved_errno));
        }
        *out_mapping = mapping;
        *out_descriptor = descriptor;
        *out_borrowed = false;
    }
    return SFS_OK;
}

static void unmap_segment_for_read(sfs_store_t *store,
                                   const uint8_t *mapping,
                                   int descriptor,
                                   bool borrowed)
{
    if (!borrowed) {
        (void)munmap((void *)mapping, (size_t)store->segment_size);
        (void)close(descriptor);
    }
}

static sfs_result_t candidate_in_partition(sfs_store_t *store,
                                           uint32_t partition_id,
                                           uint64_t after_sequence,
                                           sfs_candidate_t *candidate,
                                           sfs_error_t *error)
{
    sfs_partition_t *partition = &store->partitions[partition_id];
    size_t segment_index;
    bool resume = partition->scan_segment_id != 0u &&
                  after_sequence >= partition->scan_after_sequence;
    memset(candidate, 0, sizeof(*candidate));
    for (segment_index = 0u; segment_index < partition->segment_count;
         ++segment_index) {
        sfs_segment_meta_t *meta = &partition->segments[segment_index];
        const uint8_t *mapping;
        int descriptor;
        bool borrowed;
        uint64_t offset = SFS_SEGMENT_HEADER_SIZE;
        sfs_result_t result;
        if (meta->record_count == 0u || meta->last_sequence <= after_sequence) {
            continue;
        }
        if (resume && meta->id == partition->scan_segment_id) {
            offset = partition->scan_offset;
        }
        result = map_segment_for_read(store,
                                      partition_id,
                                      segment_index,
                                      &mapping,
                                      &descriptor,
                                      &borrowed,
                                      error);
        if (result != SFS_OK) {
            return result;
        }
        while (offset < meta->write_offset) {
            sfs_frame_view_t frame;
            int decoded = decode_frame(mapping,
                                       store->segment_size,
                                       store->segment_size,
                                       offset,
                                       &frame,
                                       error);
            if (decoded != SFS_OK) {
                unmap_segment_for_read(store, mapping, descriptor, borrowed);
                return decoded == SFS_END || decoded == SFS_INTERNAL_TORN
                           ? set_error(error,
                                       SFS_ERR_CORRUPT,
                                       0,
                                       "retained frame disappeared during scan")
                           : (sfs_result_t)decoded;
            }
            if (frame.sequence > after_sequence) {
                partition->scan_after_sequence = after_sequence;
                partition->scan_segment_id = meta->id;
                partition->scan_offset = offset;
                candidate->present = true;
                candidate->partition_id = partition_id;
                candidate->segment_index = segment_index;
                candidate->frame_offset = offset;
                candidate->frame = frame;
                unmap_segment_for_read(store, mapping, descriptor, borrowed);
                return SFS_OK;
            }
            offset += frame.total_length;
        }
        unmap_segment_for_read(store, mapping, descriptor, borrowed);
    }
    return SFS_OK;
}

static sfs_result_t copy_candidate(sfs_store_t *store,
                                   const sfs_candidate_t *candidate,
                                   void *buffer,
                                   uint32_t buffer_capacity,
                                   sfs_record_info_t *out_record,
                                   sfs_error_t *error)
{
    const uint8_t *mapping;
    int descriptor;
    bool borrowed;
    sfs_frame_view_t frame;
    int decoded;
    sfs_result_t result = map_segment_for_read(store,
                                               candidate->partition_id,
                                               candidate->segment_index,
                                               &mapping,
                                               &descriptor,
                                               &borrowed,
                                               error);
    if (result != SFS_OK) {
        return result;
    }
    decoded = decode_frame(mapping,
                           store->segment_size,
                           store->segment_size,
                           candidate->frame_offset,
                           &frame,
                           error);
    if (decoded != SFS_OK) {
        unmap_segment_for_read(store, mapping, descriptor, borrowed);
        return decoded == SFS_END || decoded == SFS_INTERNAL_TORN
                   ? set_error(error,
                               SFS_ERR_CORRUPT,
                               0,
                               "retained frame disappeared during scan")
                   : (sfs_result_t)decoded;
    }
    memset(out_record, 0, sizeof(*out_record));
    out_record->struct_size = sizeof(*out_record);
    out_record->payload_length = frame.payload_length;
    out_record->partition_id = candidate->partition_id;
    out_record->sequence = frame.sequence;
    out_record->segment_id =
        store->partitions[candidate->partition_id]
            .segments[candidate->segment_index]
            .id;
    out_record->frame_offset = candidate->frame_offset;
    if (buffer_capacity < frame.payload_length) {
        unmap_segment_for_read(store, mapping, descriptor, borrowed);
        return SFS_BUFFER_TOO_SMALL;
    }
    if (frame.payload_length != 0u) {
        memcpy(buffer, mapping + frame.payload_offset, frame.payload_length);
    }
    unmap_segment_for_read(store, mapping, descriptor, borrowed);
    return SFS_OK;
}

static size_t find_segment_index(const sfs_partition_t *partition,
                                 uint64_t segment_id)
{
    size_t index;
    for (index = 0u; index < partition->segment_count; ++index) {
        if (partition->segments[index].id >= segment_id) {
            return index;
        }
    }
    return partition->segment_count;
}

static sfs_result_t scan_partition_cursor(sfs_store_t *store,
                                          sfs_cursor_t *cursor,
                                          void *buffer,
                                          uint32_t buffer_capacity,
                                          sfs_record_info_t *out_record,
                                          sfs_error_t *error)
{
    sfs_partition_t *partition = &store->partitions[cursor->partition_id];
    size_t segment_index;
    uint64_t offset;
    bool cursor_segment_evicted = false;
    if (!partition->enabled) {
        return set_error(error,
                         SFS_ERR_PARTITION_DISABLED,
                         0,
                         "partition %u is disabled",
                         cursor->partition_id);
    }
    segment_index = cursor->segment_id == 0u
                        ? 0u
                        : find_segment_index(partition, cursor->segment_id);
    if (cursor->segment_id == 0u) {
        cursor_segment_evicted = partition->evicted_records != 0u;
    } else if (segment_index < partition->segment_count &&
               partition->segments[segment_index].id > cursor->segment_id) {
        cursor_segment_evicted = true;
    }
    offset = cursor->offset == 0u ? SFS_SEGMENT_HEADER_SIZE : cursor->offset;
    for (; segment_index < partition->segment_count; ++segment_index) {
        sfs_segment_meta_t *meta = &partition->segments[segment_index];
        const uint8_t *mapping;
        int descriptor;
        bool borrowed;
        sfs_frame_view_t frame;
        sfs_candidate_t candidate;
        int decoded;
        sfs_result_t result;
        if (cursor->segment_id != meta->id) {
            offset = SFS_SEGMENT_HEADER_SIZE;
        }
        if (offset >= meta->write_offset) {
            cursor->segment_id = meta->id;
            cursor->offset = meta->write_offset;
            continue;
        }
        result = map_segment_for_read(store,
                                      cursor->partition_id,
                                      segment_index,
                                      &mapping,
                                      &descriptor,
                                      &borrowed,
                                      error);
        if (result != SFS_OK) {
            return result;
        }
        decoded = decode_frame(mapping,
                               store->segment_size,
                               store->segment_size,
                               offset,
                               &frame,
                               error);
        unmap_segment_for_read(store, mapping, descriptor, borrowed);
        if (decoded != SFS_OK) {
            return decoded == SFS_END || decoded == SFS_INTERNAL_TORN
                       ? set_error(error,
                                   SFS_ERR_CORRUPT,
                                   0,
                                   "retained frame disappeared during scan")
                       : (sfs_result_t)decoded;
        }
        memset(&candidate, 0, sizeof(candidate));
        candidate.present = true;
        candidate.partition_id = cursor->partition_id;
        candidate.segment_index = segment_index;
        candidate.frame_offset = offset;
        candidate.frame = frame;
        result = copy_candidate(store,
                                &candidate,
                                buffer,
                                buffer_capacity,
                                out_record,
                                error);
        if (result == SFS_OK) {
            if (cursor_segment_evicted &&
                cursor->after_sequence != UINT64_MAX &&
                frame.sequence > cursor->after_sequence + 1u) {
                out_record->flags |= SFS_RECORD_GAP_BEFORE;
                out_record->gap_first_sequence = cursor->after_sequence + 1u;
                out_record->gap_last_sequence = frame.sequence - 1u;
            }
            cursor->segment_id = meta->id;
            cursor->offset = offset + frame.total_length;
            cursor->after_sequence = frame.sequence;
        }
        return result;
    }
    return SFS_END;
}

/* A sequence-only partition cursor seeks once, then becomes an ordinary
   physical cursor. The hint only avoids re-decoding excluded prefixes. */
static sfs_result_t seek_partition_cursor(sfs_store_t *store,
                                          sfs_cursor_t *cursor,
                                          void *buffer,
                                          uint32_t buffer_capacity,
                                          sfs_record_info_t *out_record,
                                          sfs_error_t *error)
{
    sfs_partition_t *partition = &store->partitions[cursor->partition_id];
    sfs_candidate_t candidate;
    sfs_result_t result;
    if (!partition->enabled) {
        return set_error(error, SFS_ERR_PARTITION_DISABLED, 0,
                         "partition %u is disabled", cursor->partition_id);
    }
    result = candidate_in_partition(store, cursor->partition_id,
                                    cursor->after_sequence, &candidate, error);
    if (result != SFS_OK) { return result; }
    if (!candidate.present) { return SFS_END; }
    result = copy_candidate(store, &candidate, buffer, buffer_capacity, out_record, error);
    if (result == SFS_OK) {
        if (partition->evicted_records != 0u && cursor->after_sequence < partition->first_sequence &&
            candidate.frame.sequence > cursor->after_sequence + 1u) {
            out_record->flags |= SFS_RECORD_GAP_BEFORE;
            out_record->gap_first_sequence = cursor->after_sequence + 1u;
            out_record->gap_last_sequence = candidate.frame.sequence - 1u;
        }
        cursor->after_sequence = candidate.frame.sequence;
        cursor->segment_id = out_record->segment_id;
        cursor->offset = candidate.frame_offset + candidate.frame.total_length;
    }
    return result;
}

static void cleanup_store(sfs_store_t *store)
{
    uint32_t partition_id;
    if (store == NULL) {
        return;
    }
    for (partition_id = 0u; partition_id < SFS_MAX_PARTITIONS; ++partition_id) {
        sfs_partition_t *partition = &store->partitions[partition_id];
        close_active_segment(store, partition);
        free(partition->segments);
        free(partition->directory);
    }
    if (store->manifest_map != NULL) {
        (void)munmap(store->manifest_map, SFS_MANIFEST_SIZE);
    }
    if (store->manifest_fd >= 0) {
        (void)close(store->manifest_fd);
    }
    if (store->lock_fd >= 0) {
        (void)close(store->lock_fd);
    }
    free(store->directory);
    if (store->mutex_initialized) {
        (void)pthread_mutex_destroy(&store->mutex);
    }
    free(store);
}

sfs_result_t sfs_open(const sfs_open_options_t *options,
                      sfs_store_t **out_store,
                      sfs_error_t *error)
{
    sfs_store_t *store;
    bool create;
    uint32_t partition_id;
    sfs_result_t result;
    clear_error(error);
    if (out_store != NULL) {
        *out_store = NULL;
    }
    if (options == NULL || out_store == NULL ||
        options->struct_size < sizeof(*options) || options->directory == NULL ||
        options->directory[0] == '\0' ||
        (options->flags & ~((uint32_t)SFS_OPEN_CREATE)) != 0u) {
        return set_error(error,
                         SFS_ERR_INVALID_ARGUMENT,
                         0,
                         "invalid open options");
    }
    create = (options->flags & SFS_OPEN_CREATE) != 0u;
    result = ensure_directory(options->directory, create, error);
    if (result != SFS_OK) {
        return result;
    }
    store = (sfs_store_t *)calloc(1u, sizeof(*store));
    if (store == NULL) {
        return set_error(error, SFS_ERR_NOMEM, errno, "cannot allocate store");
    }
    store->lock_fd = -1;
    store->manifest_fd = -1;
    store->manifest_active_slot = -1;
    store->recovery_partition_id = SFS_PARTITION_ALL;
    for (partition_id = 0u; partition_id < SFS_MAX_PARTITIONS; ++partition_id) {
        store->partitions[partition_id].active_fd = -1;
    }
    store->directory = strdup(options->directory);
    if (store->directory == NULL) {
        cleanup_store(store);
        return set_error(error, SFS_ERR_NOMEM, errno, "cannot copy store path");
    }
    if (pthread_mutex_init(&store->mutex, NULL) != 0) {
        cleanup_store(store);
        return set_error(error, SFS_ERR_NOMEM, errno, "cannot initialize store");
    }
    store->mutex_initialized = true;
    result = lock_store_directory(store, error);
    if (result != SFS_OK) {
        cleanup_store(store);
        return result;
    }
    result = open_manifest(store, options, error);
    if (result != SFS_OK) {
        cleanup_store(store);
        return result;
    }
    for (partition_id = 0u; partition_id < SFS_MAX_PARTITIONS; ++partition_id) {
        if (!store->partitions[partition_id].enabled) {
            continue;
        }
        result = load_partition(store, partition_id, create, error);
        if (result != SFS_OK) {
            cleanup_store(store);
            return result;
        }
    }
    result = manifest_save(store, error);
    if (result != SFS_OK) {
        cleanup_store(store);
        return result;
    }
    *out_store = store;
    return SFS_OK;
}

sfs_result_t sfs_append(sfs_store_t *store,
                        uint32_t partition_id,
                        const void *payload,
                        uint32_t payload_length,
                        sfs_durability_t durability,
                        sfs_record_info_t *out_record,
                        sfs_error_t *error)
{
    sfs_partition_t *partition;
    sfs_segment_meta_t *meta;
    uint64_t frame_length;
    uint64_t offset;
    uint64_t commit_offset;
    uint64_t sequence;
    sfs_result_t result = SFS_OK;
    clear_error(error);
    if (store == NULL || partition_id >= SFS_MAX_PARTITIONS ||
        (payload == NULL && payload_length != 0u) ||
        out_record == NULL || out_record->struct_size < sizeof(*out_record) ||
        (durability != SFS_DURABILITY_MEMORY &&
         durability != SFS_DURABILITY_SYNC)) {
        return set_error(error,
                         SFS_ERR_INVALID_ARGUMENT,
                         0,
                         "invalid append arguments");
    }
    memset(out_record, 0, sizeof(*out_record));
    out_record->struct_size = sizeof(*out_record);
    (void)pthread_mutex_lock(&store->mutex);
    partition = &store->partitions[partition_id];
    if (!partition->enabled) {
        result = set_error(error,
                           SFS_ERR_PARTITION_DISABLED,
                           0,
                           "partition %u is disabled",
                           partition_id);
        goto done;
    }
    frame_length = align_eight(SFS_FRAME_PREFIX_SIZE +
                               (uint64_t)payload_length) +
                   SFS_FRAME_COMMIT_SIZE;
    if (frame_length > store->segment_size - SFS_SEGMENT_HEADER_SIZE) {
        result = set_error(error,
                           SFS_ERR_FULL,
                           0,
                           "record does not fit in an empty segment");
        goto done;
    }
    if (store->next_sequence == UINT64_MAX) {
        result = set_error(error, SFS_ERR_FULL, 0, "global sequence is exhausted");
        goto done;
    }
    if (partition->active_map == NULL ||
        partition->active_write_offset > store->segment_size - frame_length) {
        result = rotate_partition(store, partition_id, error);
        if (result != SFS_OK) {
            goto done;
        }
    }
    sequence = store->next_sequence;
    offset = partition->active_write_offset;
    commit_offset = offset + frame_length - SFS_FRAME_COMMIT_SIZE;
    memset(partition->active_map + offset, 0, (size_t)frame_length);
    store_u32_le(partition->active_map + offset, (uint32_t)frame_length);
    store_u32_le(partition->active_map + offset + 4u, payload_length);
    store_u64_le(partition->active_map + offset + 8u, sequence);
    store_u32_le(partition->active_map + offset + 16u,
                 sfs_crc32c((const uint8_t *)payload, payload_length));
    store_u32_le(partition->active_map + offset + 20u,
                 sfs_crc32c(partition->active_map + offset, 20u));
    if (payload_length != 0u) {
        memcpy(partition->active_map + offset + SFS_FRAME_PREFIX_SIZE,
               payload,
               payload_length);
    }
    atomic_thread_fence(memory_order_release);
    store_u64_le(partition->active_map + commit_offset,
                 SFS_FRAME_COMMIT_MARKER);
    atomic_thread_fence(memory_order_release);
    partition->active_write_offset += frame_length;
    meta = &partition->segments[partition->segment_count - 1u];
    meta->write_offset = partition->active_write_offset;
    if (meta->record_count == 0u) {
        meta->first_sequence = sequence;
    }
    meta->last_sequence = sequence;
    meta->record_count += 1u;
    meta->payload_bytes += payload_length;
    if (partition->record_count == 0u) {
        partition->first_sequence = sequence;
    }
    partition->last_sequence = sequence;
    partition->record_count += 1u;
    partition->payload_bytes += payload_length;
    store->next_sequence += 1u;
    if (durability == SFS_DURABILITY_SYNC) {
        result = flush_locked(store, error);
        if (result != SFS_OK) {
            goto done;
        }
    }
    out_record->payload_length = payload_length;
    out_record->partition_id = partition_id;
    out_record->sequence = sequence;
    out_record->segment_id = meta->id;
    out_record->frame_offset = offset;
done:
    (void)pthread_mutex_unlock(&store->mutex);
    return result;
}

sfs_result_t sfs_scan(sfs_store_t *store,
                      sfs_cursor_t *cursor,
                      void *buffer,
                      uint32_t buffer_capacity,
                      sfs_record_info_t *out_record,
                      sfs_error_t *error)
{
    sfs_result_t result;
    clear_error(error);
    if (store == NULL || cursor == NULL || out_record == NULL ||
        out_record->struct_size < sizeof(*out_record) ||
        (buffer == NULL && buffer_capacity != 0u) || cursor->flags != 0u ||
        (cursor->partition_id != SFS_PARTITION_ALL &&
         cursor->partition_id >= SFS_MAX_PARTITIONS)) {
        return set_error(error,
                         SFS_ERR_INVALID_ARGUMENT,
                         0,
                         "invalid scan arguments");
    }
    (void)pthread_mutex_lock(&store->mutex);
    if (cursor->partition_id != SFS_PARTITION_ALL && cursor->segment_id == 0u &&
        cursor->offset == 0u && cursor->after_sequence != 0u) {
        result = seek_partition_cursor(store, cursor, buffer, buffer_capacity, out_record, error);
    } else if (cursor->partition_id != SFS_PARTITION_ALL) {
        result = scan_partition_cursor(store,
                                       cursor,
                                       buffer,
                                       buffer_capacity,
                                       out_record,
                                       error);
    } else {
        sfs_candidate_t best;
        uint32_t partition_id;
        memset(&best, 0, sizeof(best));
        result = SFS_OK;
        for (partition_id = 0u; partition_id < SFS_MAX_PARTITIONS;
             ++partition_id) {
            sfs_candidate_t candidate;
            if (!store->partitions[partition_id].enabled) {
                continue;
            }
            result = candidate_in_partition(store,
                                            partition_id,
                                            cursor->after_sequence,
                                            &candidate,
                                            error);
            if (result != SFS_OK) {
                break;
            }
            if (candidate.present &&
                (!best.present ||
                 candidate.frame.sequence < best.frame.sequence)) {
                best = candidate;
            }
        }
        if (result == SFS_OK && !best.present) {
            result = SFS_END;
        } else if (result == SFS_OK) {
            uint64_t expected = cursor->after_sequence + 1u;
            result = copy_candidate(store,
                                    &best,
                                    buffer,
                                    buffer_capacity,
                                    out_record,
                                    error);
            if (result == SFS_OK) {
                if (best.frame.sequence > expected) {
                    out_record->flags |= SFS_RECORD_GAP_BEFORE;
                    out_record->gap_first_sequence = expected;
                    out_record->gap_last_sequence = best.frame.sequence - 1u;
                }
                cursor->after_sequence = best.frame.sequence;
                cursor->segment_id = out_record->segment_id;
                cursor->offset = best.frame_offset + best.frame.total_length;
            }
        }
    }
    (void)pthread_mutex_unlock(&store->mutex);
    return result;
}

sfs_result_t sfs_status(sfs_store_t *store,
                        sfs_status_t *out_status,
                        sfs_error_t *error)
{
    uint32_t partition_id;
    clear_error(error);
    if (store == NULL || out_status == NULL ||
        out_status->struct_size < sizeof(*out_status)) {
        return set_error(error,
                         SFS_ERR_INVALID_ARGUMENT,
                         0,
                         "invalid status arguments");
    }
    (void)pthread_mutex_lock(&store->mutex);
    memset(out_status, 0, sizeof(*out_status));
    out_status->struct_size = sizeof(*out_status);
    out_status->format_version = SFS_FORMAT_VERSION;
    out_status->flags = store->status_flags;
    out_status->segment_size = store->segment_size;
    out_status->next_sequence = store->next_sequence;
    out_status->recovery_partition_id = store->recovery_partition_id;
    out_status->recovery_segment_id = store->recovery_segment_id;
    out_status->recovery_offset = store->recovery_offset;
    out_status->recovery_discarded_bytes = store->recovery_discarded_bytes;
    for (partition_id = 0u; partition_id < SFS_MAX_PARTITIONS; ++partition_id) {
        const sfs_partition_t *source = &store->partitions[partition_id];
        sfs_partition_status_t *target = &out_status->partitions[partition_id];
        target->partition_id = partition_id;
        target->quota_bytes = source->quota_bytes;
        target->evicted_segments = source->evicted_segments;
        target->evicted_records = source->evicted_records;
        target->evicted_payload_bytes = source->evicted_payload_bytes;
        if (!source->enabled) {
            continue;
        }
        target->flags = SFS_PARTITION_ENABLED;
        target->allocated_bytes = source->segment_count * store->segment_size;
        target->segment_count = source->segment_count;
        target->first_segment_id = source->segment_count == 0u
                                       ? 0u
                                       : source->segments[0].id;
        target->active_segment_id = source->segment_count == 0u
                                        ? 0u
                                        : source->segments[source->segment_count - 1u]
                                              .id;
        target->active_write_offset = source->active_write_offset;
        target->record_count = source->record_count;
        target->payload_bytes = source->payload_bytes;
        target->first_sequence = source->first_sequence;
        target->last_sequence = source->last_sequence;
        out_status->segment_count += source->segment_count;
        out_status->record_count += source->record_count;
        out_status->payload_bytes += source->payload_bytes;
    }
    (void)pthread_mutex_unlock(&store->mutex);
    return SFS_OK;
}

sfs_result_t sfs_flush(sfs_store_t *store, sfs_error_t *error)
{
    sfs_result_t result;
    clear_error(error);
    if (store == NULL) {
        return set_error(error,
                         SFS_ERR_INVALID_ARGUMENT,
                         0,
                         "store is null");
    }
    (void)pthread_mutex_lock(&store->mutex);
    result = flush_locked(store, error);
    (void)pthread_mutex_unlock(&store->mutex);
    return result;
}

sfs_result_t sfs_close(sfs_store_t *store, sfs_error_t *error)
{
    sfs_result_t result;
    clear_error(error);
    if (store == NULL) {
        return set_error(error,
                         SFS_ERR_INVALID_ARGUMENT,
                         0,
                         "store is null");
    }
    (void)pthread_mutex_lock(&store->mutex);
    result = flush_locked(store, error);
    (void)pthread_mutex_unlock(&store->mutex);
    cleanup_store(store);
    return result;
}
