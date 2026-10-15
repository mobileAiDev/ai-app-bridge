#ifndef SFS_PLATFORM_H
#define SFS_PLATFORM_H

/* Internal OS boundary. Paths are UTF-8; file contents and commit ordering stay
   in sfs.c. No operation changes the storage backend or retries an I/O error. */
#include <errno.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

enum { SFS_FILE_WRITE = 1, SFS_FILE_CREATE = 2, SFS_FILE_EXCLUSIVE = 4 };
typedef struct sfs_file_info {
    uint64_t size;
    bool directory;
} sfs_file_info_t;

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <stdio.h>
#include <wchar.h>

typedef HANDLE sfs_file_t;
#define SFS_FILE_INVALID INVALID_HANDLE_VALUE
typedef SRWLOCK sfs_mutex_t;
typedef INIT_ONCE sfs_once_t;
#define SFS_ONCE_INIT INIT_ONCE_STATIC_INIT
static __declspec(thread) DWORD sfs_windows_error;

static inline int sfs_os_error(void) { return (int)sfs_windows_error; }
static inline int sfs_windows_fail(DWORD code)
{
    sfs_windows_error = code;
    return -1;
}
static inline bool sfs_os_missing(int code)
{
    return code == ERROR_FILE_NOT_FOUND || code == ERROR_PATH_NOT_FOUND;
}
static inline bool sfs_os_lock_busy(int code)
{
    return code == ERROR_LOCK_VIOLATION || code == ERROR_SHARING_VIOLATION;
}
static inline const char *sfs_os_error_message(int code)
{
    static __declspec(thread) char message[512];
    wchar_t wide[256];
    DWORD count = FormatMessageW(FORMAT_MESSAGE_FROM_SYSTEM |
                                   FORMAT_MESSAGE_IGNORE_INSERTS,
                               NULL, (DWORD)code, 0, wide, 256, NULL);
    if (count == 0 || WideCharToMultiByte(CP_UTF8, 0, wide, -1, message,
                                         sizeof(message), NULL, NULL) == 0) {
        (void)snprintf(message, sizeof(message), "Win32 error %d", code);
    }
    return message;
}

/* Explicit UTF-8 -> UTF-16 conversion, absolute extended paths, and no ANSI
   code-page conversion. The prefix also makes Unicode paths beyond MAX_PATH
   independent of the embedding executable's longPathAware manifest. */
static inline wchar_t *sfs_windows_path(const char *path)
{
    int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1,
                                  NULL, 0);
    wchar_t *input;
    wchar_t *absolute;
    wchar_t *extended;
    DWORD required;
    DWORD written;
    size_t length;
    size_t index;
    bool unc;
    if (count == 0) { sfs_windows_fail(GetLastError()); return NULL; }
    input = (wchar_t *)malloc((size_t)count * sizeof(wchar_t));
    if (input == NULL) { sfs_windows_fail(ERROR_NOT_ENOUGH_MEMORY); return NULL; }
    if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1,
                            input, count) == 0) {
        DWORD code = GetLastError(); free(input); sfs_windows_fail(code); return NULL;
    }
    for (index = 0; input[index] != L'\0'; ++index) {
        if (input[index] == L'/') input[index] = L'\\';
    }
    if (wcsncmp(input, L"\\\\?\\", 4) == 0) return input;
    required = GetFullPathNameW(input, 0, NULL, NULL);
    if (required == 0) {
        DWORD code = GetLastError(); free(input); sfs_windows_fail(code); return NULL;
    }
    absolute = (wchar_t *)malloc((size_t)required * sizeof(wchar_t));
    if (absolute == NULL) {
        free(input); sfs_windows_fail(ERROR_NOT_ENOUGH_MEMORY); return NULL;
    }
    written = GetFullPathNameW(input, required, absolute, NULL);
    free(input);
    if (written == 0 || written >= required) {
        DWORD code = written == 0 ? GetLastError() : ERROR_INSUFFICIENT_BUFFER;
        free(absolute); sfs_windows_fail(code); return NULL;
    }
    length = wcslen(absolute);
    unc = wcsncmp(absolute, L"\\\\", 2) == 0;
    extended = (wchar_t *)malloc((length + (unc ? 7u : 5u)) * sizeof(wchar_t));
    if (extended == NULL) {
        free(absolute); sfs_windows_fail(ERROR_NOT_ENOUGH_MEMORY); return NULL;
    }
    if (unc) {
        memcpy(extended, L"\\\\?\\UNC\\", 8u * sizeof(wchar_t));
        memcpy(extended + 8u, absolute + 2u, (length - 1u) * sizeof(wchar_t));
    } else {
        memcpy(extended, L"\\\\?\\", 4u * sizeof(wchar_t));
        memcpy(extended + 4u, absolute, (length + 1u) * sizeof(wchar_t));
    }
    free(absolute);
    return extended;
}

static inline sfs_file_t sfs_file_open(const char *path, unsigned flags)
{
    wchar_t *wide = sfs_windows_path(path);
    HANDLE file;
    DWORD disposition = (flags & SFS_FILE_EXCLUSIVE) ? CREATE_NEW :
                        ((flags & SFS_FILE_CREATE) ? OPEN_ALWAYS : OPEN_EXISTING);
    if (wide == NULL) return SFS_FILE_INVALID;
    file = CreateFileW(wide, GENERIC_READ | ((flags & SFS_FILE_WRITE) ? GENERIC_WRITE : 0),
                       FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                       NULL, disposition, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) sfs_windows_fail(GetLastError());
    free(wide);
    return file;
}
static inline int sfs_file_close(sfs_file_t file)
{
    return CloseHandle(file) ? 0 : sfs_windows_fail(GetLastError());
}
static inline int sfs_file_info(sfs_file_t file, sfs_file_info_t *info)
{
    BY_HANDLE_FILE_INFORMATION value;
    if (!GetFileInformationByHandle(file, &value)) return sfs_windows_fail(GetLastError());
    info->size = ((uint64_t)value.nFileSizeHigh << 32) | value.nFileSizeLow;
    info->directory = (value.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
    return 0;
}
static inline int sfs_path_info(const char *path, bool follow, sfs_file_info_t *info)
{
    wchar_t *wide = sfs_windows_path(path);
    HANDLE file;
    int result;
    if (wide == NULL) return -1;
    file = CreateFileW(wide, FILE_READ_ATTRIBUTES,
                       FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                       NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS |
                       (follow ? 0 : FILE_FLAG_OPEN_REPARSE_POINT), NULL);
    if (file == INVALID_HANDLE_VALUE) sfs_windows_fail(GetLastError());
    free(wide);
    if (file == INVALID_HANDLE_VALUE) return -1;
    result = sfs_file_info(file, info);
    (void)CloseHandle(file);
    return result;
}
static inline int sfs_directory_create(const char *path)
{
    wchar_t *wide = sfs_windows_path(path);
    BOOL result;
    if (wide == NULL) return -1;
    result = CreateDirectoryW(wide, NULL);
    if (!result) sfs_windows_fail(GetLastError());
    free(wide);
    return result ? 0 : -1;
}
static inline int sfs_file_resize(sfs_file_t file, uint64_t size)
{
    LARGE_INTEGER previous;
    LARGE_INTEGER offset;
    if (size > INT64_MAX) return sfs_windows_fail(ERROR_FILE_TOO_LARGE);
    if (!GetFileSizeEx(file, &previous)) return sfs_windows_fail(GetLastError());
    offset.QuadPart = (LONGLONG)size;
    if (!SetFilePointerEx(file, offset, NULL, FILE_BEGIN) || !SetEndOfFile(file))
        return sfs_windows_fail(GetLastError());
    /* Unlike ftruncate, SetEndOfFile documents newly extended bytes as
       undefined. Write the zero range explicitly; v1 requires a zero tail. */
    if (previous.QuadPart < offset.QuadPart) {
        static const uint8_t zeros[65536] = {0};
        uint64_t remaining = size - (uint64_t)previous.QuadPart;
        if (!SetFilePointerEx(file, previous, NULL, FILE_BEGIN))
            return sfs_windows_fail(GetLastError());
        while (remaining != 0) {
            DWORD count = remaining < sizeof(zeros) ? (DWORD)remaining : (DWORD)sizeof(zeros);
            DWORD written;
            if (!WriteFile(file, zeros, count, &written, NULL))
                return sfs_windows_fail(GetLastError());
            if (written != count) return sfs_windows_fail(ERROR_WRITE_FAULT);
            remaining -= written;
        }
    }
    return 0;
}
static inline int sfs_file_sync(sfs_file_t file)
{
    return FlushFileBuffers(file) ? 0 : sfs_windows_fail(GetLastError());
}
static inline int sfs_file_lock(sfs_file_t file)
{
    OVERLAPPED offset = {0};
    return LockFileEx(file, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
                     0, 1, 0, &offset) ? 0 : sfs_windows_fail(GetLastError());
}
static inline uint8_t *sfs_file_map(sfs_file_t file, size_t length, bool writable)
{
    HANDLE section = CreateFileMappingW(file, NULL, writable ? PAGE_READWRITE : PAGE_READONLY,
                                        0, 0, NULL);
    uint8_t *view;
    if (section == NULL) { sfs_windows_fail(GetLastError()); return NULL; }
    view = (uint8_t *)MapViewOfFile(section, writable ? FILE_MAP_WRITE : FILE_MAP_READ,
                                    0, 0, length);
    if (view == NULL) sfs_windows_fail(GetLastError());
    (void)CloseHandle(section);
    return view;
}
static inline int sfs_file_unmap(void *mapping, size_t length)
{
    (void)length;
    return UnmapViewOfFile(mapping) ? 0 : sfs_windows_fail(GetLastError());
}
static inline int sfs_map_sync(sfs_file_t file, void *mapping, size_t length)
{
    /* FlushViewOfFile alone does not wait for the hardware cache. The body
       must reach disk before sfs.c exposes its commit marker, in both phases. */
    if (!FlushViewOfFile(mapping, length) || !FlushFileBuffers(file))
        return sfs_windows_fail(GetLastError());
    return 0;
}
static inline int sfs_file_remove(const char *path)
{
    wchar_t *wide = sfs_windows_path(path);
    BOOL result;
    if (wide == NULL) return -1;
    result = DeleteFileW(wide);
    if (!result) sfs_windows_fail(GetLastError());
    free(wide);
    return result ? 0 : -1;
}
static inline int sfs_file_rename(const char *source, const char *destination, bool replace)
{
    wchar_t *from = sfs_windows_path(source);
    wchar_t *to;
    BOOL result;
    if (from == NULL) return -1;
    to = sfs_windows_path(destination);
    if (to == NULL) { free(from); return -1; }
    result = MoveFileExW(from, to, MOVEFILE_WRITE_THROUGH |
                         (replace ? MOVEFILE_REPLACE_EXISTING : 0));
    if (!result) sfs_windows_fail(GetLastError());
    free(from); free(to);
    return result ? 0 : -1;
}
static inline int sfs_directory_sync(const char *path)
{
    wchar_t *wide = sfs_windows_path(path);
    HANDLE directory;
    int result;
    if (wide == NULL) return -1;
    directory = CreateFileW(wide, GENERIC_READ | GENERIC_WRITE,
                            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                            NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, NULL);
    if (directory == INVALID_HANDLE_VALUE) sfs_windows_fail(GetLastError());
    free(wide);
    if (directory == INVALID_HANDLE_VALUE) return -1;
    result = sfs_file_sync(directory);
    (void)CloseHandle(directory);
    return result;
}
static inline int sfs_mutex_init(sfs_mutex_t *mutex)
{
    InitializeSRWLock(mutex); return 0;
}
static inline void sfs_mutex_destroy(sfs_mutex_t *mutex) { (void)mutex; }
static inline void sfs_mutex_lock(sfs_mutex_t *mutex) { AcquireSRWLockExclusive(mutex); }
static inline void sfs_mutex_unlock(sfs_mutex_t *mutex) { ReleaseSRWLockExclusive(mutex); }
typedef struct sfs_once_callback { void (*initialize)(void); } sfs_once_callback_t;
static inline BOOL CALLBACK sfs_windows_once(PINIT_ONCE once, PVOID parameter, PVOID *context)
{
    sfs_once_callback_t *callback = (sfs_once_callback_t *)parameter;
    (void)once; (void)context; callback->initialize(); return TRUE;
}
static inline void sfs_once(sfs_once_t *once, void (*initialize)(void))
{
    sfs_once_callback_t callback = {initialize};
    (void)InitOnceExecuteOnce(once, sfs_windows_once, &callback, NULL);
}
static inline void sfs_release_fence(void) { MemoryBarrier(); }

typedef struct sfs_directory {
    HANDLE search;
    WIN32_FIND_DATAW entry;
    bool first;
    int error;
    char name[1024];
} sfs_directory_t;
static inline sfs_directory_t *sfs_directory_open(const char *path)
{
    size_t length = strlen(path);
    char *pattern = (char *)malloc(length + 3u);
    wchar_t *wide;
    sfs_directory_t *directory;
    if (pattern == NULL) { sfs_windows_fail(ERROR_NOT_ENOUGH_MEMORY); return NULL; }
    memcpy(pattern, path, length); memcpy(pattern + length, "/*", 3u);
    wide = sfs_windows_path(pattern); free(pattern);
    if (wide == NULL) return NULL;
    directory = (sfs_directory_t *)calloc(1, sizeof(*directory));
    if (directory == NULL) { free(wide); sfs_windows_fail(ERROR_NOT_ENOUGH_MEMORY); return NULL; }
    directory->search = FindFirstFileW(wide, &directory->entry);
    if (directory->search == INVALID_HANDLE_VALUE) {
        DWORD code = GetLastError();
        free(wide);
        /* A valid empty directory has no matching files. Missing directories
           and all other enumeration errors remain errors. */
        if (code == ERROR_FILE_NOT_FOUND) return directory;
        free(directory); sfs_windows_fail(code); return NULL;
    }
    free(wide);
    directory->first = true;
    return directory;
}
static inline const char *sfs_directory_next(sfs_directory_t *directory)
{
    if (directory->search == INVALID_HANDLE_VALUE) return NULL;
    if (!directory->first && !FindNextFileW(directory->search, &directory->entry)) {
        DWORD code = GetLastError();
        directory->error = code == ERROR_NO_MORE_FILES ? 0 : (int)code;
        return NULL;
    }
    directory->first = false;
    if (!WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, directory->entry.cFileName,
                             -1, directory->name, sizeof(directory->name), NULL, NULL)) {
        directory->error = (int)GetLastError(); return NULL;
    }
    return directory->name;
}
static inline int sfs_directory_error(sfs_directory_t *directory) { return directory->error; }
static inline void sfs_directory_close(sfs_directory_t *directory)
{
    if (directory->search != INVALID_HANDLE_VALUE) (void)FindClose(directory->search);
    free(directory);
}

#else

#include <dirent.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <sys/file.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

typedef int sfs_file_t;
#define SFS_FILE_INVALID (-1)
typedef pthread_mutex_t sfs_mutex_t;
typedef pthread_once_t sfs_once_t;
#define SFS_ONCE_INIT PTHREAD_ONCE_INIT
static inline int sfs_os_error(void) { return errno; }
static inline bool sfs_os_missing(int code) { return code == ENOENT; }
static inline bool sfs_os_lock_busy(int code)
{
    return code == EWOULDBLOCK || code == EAGAIN || code == EACCES;
}
static inline const char *sfs_os_error_message(int code) { return strerror(code); }
static inline sfs_file_t sfs_file_open(const char *path, unsigned flags)
{
    return open(path, ((flags & SFS_FILE_WRITE) ? O_RDWR : O_RDONLY) |
                     ((flags & SFS_FILE_CREATE) ? O_CREAT : 0) |
                     ((flags & SFS_FILE_EXCLUSIVE) ? O_EXCL : 0), 0600);
}
static inline int sfs_file_close(sfs_file_t file) { return close(file); }
static inline int sfs_file_info(sfs_file_t file, sfs_file_info_t *info)
{
    struct stat status;
    if (fstat(file, &status) != 0) return -1;
    if (status.st_size < 0) { errno = EIO; return -1; }
    info->size = (uint64_t)status.st_size;
    info->directory = S_ISDIR(status.st_mode);
    return 0;
}
static inline int sfs_path_info(const char *path, bool follow, sfs_file_info_t *info)
{
    struct stat status;
    if ((follow ? stat(path, &status) : lstat(path, &status)) != 0) return -1;
    info->size = (uint64_t)status.st_size;
    info->directory = S_ISDIR(status.st_mode);
    return 0;
}
static inline int sfs_directory_create(const char *path) { return mkdir(path, 0700); }
static inline int sfs_file_resize(sfs_file_t file, uint64_t size) { return ftruncate(file, (off_t)size); }
static inline int sfs_file_sync(sfs_file_t file) { return fsync(file); }
static inline int sfs_file_lock(sfs_file_t file) { return flock(file, LOCK_EX | LOCK_NB); }
static inline uint8_t *sfs_file_map(sfs_file_t file, size_t length, bool writable)
{
    void *mapping = mmap(NULL, length, PROT_READ | (writable ? PROT_WRITE : 0), MAP_SHARED, file, 0);
    return mapping == MAP_FAILED ? NULL : (uint8_t *)mapping;
}
static inline int sfs_file_unmap(void *mapping, size_t length) { return munmap(mapping, length); }
static inline int sfs_map_sync(sfs_file_t file, void *mapping, size_t length)
{
    (void)file; return msync(mapping, length, MS_SYNC);
}
static inline int sfs_file_remove(const char *path) { return unlink(path); }
static inline int sfs_file_rename(const char *source, const char *destination, bool replace)
{
    if (replace) return rename(source, destination);
    /* Used only for publishing files, never directories. The destination link
       is created exclusively; unlike a preflight exists() check it cannot
       overwrite a concurrently created destination. */
    if (link(source, destination) != 0) return -1;
    return unlink(source);
}
static inline int sfs_directory_sync(const char *path)
{
    int directory = open(path, O_RDONLY);
    int result;
    int saved;
    if (directory < 0) return -1;
    result = fsync(directory); saved = errno;
    (void)close(directory); errno = saved;
    return result;
}
static inline int sfs_mutex_init(sfs_mutex_t *mutex) { return pthread_mutex_init(mutex, NULL); }
static inline void sfs_mutex_destroy(sfs_mutex_t *mutex) { (void)pthread_mutex_destroy(mutex); }
static inline void sfs_mutex_lock(sfs_mutex_t *mutex) { (void)pthread_mutex_lock(mutex); }
static inline void sfs_mutex_unlock(sfs_mutex_t *mutex) { (void)pthread_mutex_unlock(mutex); }
static inline void sfs_once(sfs_once_t *once, void (*initialize)(void)) { (void)pthread_once(once, initialize); }
static inline void sfs_release_fence(void) { atomic_thread_fence(memory_order_release); }
typedef struct sfs_directory { DIR *handle; int error; } sfs_directory_t;
static inline sfs_directory_t *sfs_directory_open(const char *path)
{
    sfs_directory_t *directory = (sfs_directory_t *)calloc(1, sizeof(*directory));
    if (directory == NULL) return NULL;
    directory->handle = opendir(path);
    if (directory->handle == NULL) { int saved = errno; free(directory); errno = saved; return NULL; }
    return directory;
}
static inline const char *sfs_directory_next(sfs_directory_t *directory)
{
    struct dirent *entry;
    errno = 0;
    entry = readdir(directory->handle);
    if (entry == NULL) { directory->error = errno; return NULL; }
    return entry->d_name;
}
static inline int sfs_directory_error(sfs_directory_t *directory) { return directory->error; }
static inline void sfs_directory_close(sfs_directory_t *directory)
{
    (void)closedir(directory->handle); free(directory);
}
#endif

static inline char *sfs_string_copy(const char *text)
{
    size_t length = strlen(text) + 1u;
    char *copy = (char *)malloc(length);
    if (copy != NULL) memcpy(copy, text, length);
    return copy;
}

/* Same-volume publication is the Windows directory-entry durability boundary.
   Delete durability is not used to establish retention: the manifest's durable
   first-retained id precedes deletion. POSIX retains its best-effort directory
   sync inside FactStore; the Host helper below is stricter and reports errors. */
static inline int sfs_durable_rename(const char *source, const char *destination,
                                   bool replace)
{
    if (sfs_file_rename(source, destination, replace) != 0) return -1;
#ifndef _WIN32
    {
        char *source_parent = sfs_string_copy(source);
        char *destination_parent = sfs_string_copy(destination);
        char *separator;
        int result;
        int saved;
        if (source_parent == NULL || destination_parent == NULL) {
            free(source_parent); free(destination_parent); errno = ENOMEM; return -1;
        }
        separator = strrchr(source_parent, '/');
        if (separator == NULL) { free(source_parent); source_parent = sfs_string_copy("."); }
        else if (separator == source_parent) separator[1] = '\0';
        else *separator = '\0';
        separator = strrchr(destination_parent, '/');
        if (separator == NULL) { free(destination_parent); destination_parent = sfs_string_copy("."); }
        else if (separator == destination_parent) separator[1] = '\0';
        else *separator = '\0';
        if (source_parent == NULL || destination_parent == NULL) {
            free(source_parent); free(destination_parent); errno = ENOMEM; return -1;
        }
        result = sfs_directory_sync(destination_parent);
        if (result == 0 && strcmp(source_parent, destination_parent) != 0)
            result = sfs_directory_sync(source_parent);
        saved = errno; free(source_parent); free(destination_parent); errno = saved;
        return result;
    }
#else
    return 0;
#endif
}
#endif
