#ifndef SFS_TEST_PLATFORM_H
#define SFS_TEST_PLATFORM_H

#include "../src/sfs_platform.h"
#include <stdio.h>
#ifdef _WIN32
#include <psapi.h>
#else
#include <sys/resource.h>
#include <time.h>
#endif

typedef struct test_resources {
    uint64_t elapsed_ms;
    uint64_t user_ms;
    uint64_t system_ms;
    uint64_t max_rss_kb;
} test_resources_t;

static inline char *test_temp_directory(void)
{
#ifdef _WIN32
    wchar_t root[MAX_PATH];
    wchar_t path[MAX_PATH];
    char *utf8;
    int length;
    if (GetTempPathW(MAX_PATH, root) == 0 ||
        GetTempFileNameW(root, L"sfs", 0, path) == 0 ||
        !DeleteFileW(path) || !CreateDirectoryW(path, NULL)) return NULL;
    length = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, path, -1, NULL, 0, NULL, NULL);
    if (length == 0) return NULL;
    utf8 = (char *)malloc((size_t)length);
    if (utf8 == NULL) return NULL;
    if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, path, -1,
                            utf8, length, NULL, NULL) == 0) { free(utf8); return NULL; }
    return utf8;
#else
    char *path = sfs_string_copy("/tmp/sfs-test-XXXXXX");
    int descriptor;
    if (path == NULL) return NULL;
    descriptor = mkstemp(path);
    if (descriptor < 0) { free(path); return NULL; }
    (void)close(descriptor);
    if (unlink(path) != 0 || mkdir(path, 0700) != 0) { free(path); return NULL; }
    return path;
#endif
}

static inline int test_remove_directory(const char *path)
{
#ifdef _WIN32
    wchar_t *wide = sfs_windows_path(path);
    BOOL result;
    if (wide == NULL) return -1;
    result = RemoveDirectoryW(wide); free(wide);
    return result ? 0 : -1;
#else
    return rmdir(path);
#endif
}

static inline int64_t test_read_at(sfs_file_t file, void *buffer, uint32_t length, uint64_t position)
{
#ifdef _WIN32
    LARGE_INTEGER offset;
    DWORD read_bytes;
    offset.QuadPart = (LONGLONG)position;
    if (!SetFilePointerEx(file, offset, NULL, FILE_BEGIN) ||
        !ReadFile(file, buffer, length, &read_bytes, NULL)) return -1;
    return read_bytes;
#else
    return pread(file, buffer, length, (off_t)position);
#endif
}
static inline int64_t test_write_at(sfs_file_t file, const void *buffer, uint32_t length, uint64_t position)
{
#ifdef _WIN32
    LARGE_INTEGER offset;
    DWORD written;
    offset.QuadPart = (LONGLONG)position;
    if (!SetFilePointerEx(file, offset, NULL, FILE_BEGIN) ||
        !WriteFile(file, buffer, length, &written, NULL)) return -1;
    return written;
#else
    return pwrite(file, buffer, length, (off_t)position);
#endif
}
static inline int test_truncate(const char *path, uint64_t size)
{
    sfs_file_t file = sfs_file_open(path, SFS_FILE_WRITE);
    int result;
    if (file == SFS_FILE_INVALID) return -1;
    result = sfs_file_resize(file, size);
    (void)sfs_file_close(file);
    return result;
}
static inline int test_resources(test_resources_t *sample)
{
#ifdef _WIN32
    FILETIME created, exited, kernel, user;
    PROCESS_MEMORY_COUNTERS memory;
    LARGE_INTEGER ticks, frequency;
    if (!GetProcessTimes(GetCurrentProcess(), &created, &exited, &kernel, &user) ||
        !K32GetProcessMemoryInfo(GetCurrentProcess(), &memory, sizeof(memory)) ||
        !QueryPerformanceCounter(&ticks) || !QueryPerformanceFrequency(&frequency)) return -1;
    sample->elapsed_ms = (uint64_t)(ticks.QuadPart / frequency.QuadPart) * 1000u +
                         (uint64_t)(ticks.QuadPart % frequency.QuadPart) * 1000u / (uint64_t)frequency.QuadPart;
    sample->user_ms = (((uint64_t)user.dwHighDateTime << 32) | user.dwLowDateTime) / 10000u;
    sample->system_ms = (((uint64_t)kernel.dwHighDateTime << 32) | kernel.dwLowDateTime) / 10000u;
    sample->max_rss_kb = memory.PeakWorkingSetSize / 1024u;
#else
    struct timespec now;
    struct rusage usage;
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0 || getrusage(RUSAGE_SELF, &usage) != 0) return -1;
    sample->elapsed_ms = (uint64_t)now.tv_sec * 1000u + (uint64_t)now.tv_nsec / 1000000u;
    sample->user_ms = (uint64_t)usage.ru_utime.tv_sec * 1000u + (uint64_t)usage.ru_utime.tv_usec / 1000u;
    sample->system_ms = (uint64_t)usage.ru_stime.tv_sec * 1000u + (uint64_t)usage.ru_stime.tv_usec / 1000u;
    sample->max_rss_kb = (uint64_t)usage.ru_maxrss;
#ifdef __APPLE__
    sample->max_rss_kb /= 1024u;
#endif
#endif
    return 0;
}
#endif
