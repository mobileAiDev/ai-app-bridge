#include "windows_process.h"

#ifdef _WIN32
#include <windows.h>
#include <tlhelp32.h>
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    HANDLE job;
    DWORD pid;
} aab_process_scope;

static napi_value windows_error(napi_env env, const char *operation, DWORD code)
{
    char message[160];
    snprintf(message, sizeof(message), "%s failed (Win32 error %lu).", operation, (unsigned long)code);
    napi_throw_error(env, "windows_process_failed", message);
    return NULL;
}

static int read_pid(napi_env env, napi_value value, DWORD *pid)
{
    double number;
    if (napi_get_value_double(env, value, &number) != napi_ok || !(number >= 1 && number <= 4294967295.0) || number != (DWORD)number) {
        napi_throw_type_error(env, "invalid_process_id", "Expected a positive Windows process identifier.");
        return 0;
    }
    *pid = (DWORD)number;
    return 1;
}

static int start_text(HANDLE process, char text[32])
{
    FILETIME creation, exit, kernel, user;
    if (!GetProcessTimes(process, &creation, &exit, &kernel, &user)) return 0;
    ULARGE_INTEGER ticks;
    ticks.LowPart = creation.dwLowDateTime;
    ticks.HighPart = creation.dwHighDateTime;
    snprintf(text, 32, "%llu", (unsigned long long)ticks.QuadPart);
    return 1;
}

static napi_value process_start(napi_env env, napi_callback_info info)
{
    size_t argc = 1;
    napi_value argv[1], result;
    DWORD pid;
    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1 || !read_pid(env, argv[0], &pid)) return NULL;
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid);
    if (!process) {
        DWORD error = GetLastError();
        if (error != ERROR_INVALID_PARAMETER) return windows_error(env, "OpenProcess", error);
        napi_get_null(env, &result);
        return result;
    }
    char text[32];
    DWORD error = ERROR_SUCCESS;
    DWORD wait = WaitForSingleObject(process, 0);
    if (wait == WAIT_FAILED || (wait == WAIT_TIMEOUT && !start_text(process, text))) error = GetLastError();
    CloseHandle(process);
    if (error != ERROR_SUCCESS) return windows_error(env, "GetProcessTimes", error);
    if (wait == WAIT_OBJECT_0) napi_get_null(env, &result);
    else napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &result);
    return result;
}

static int owned_child(DWORD pid, DWORD *error)
{
    if (pid == GetCurrentProcessId()) return 1;
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) { *error = GetLastError(); return 0; }
    PROCESSENTRY32W entry;
    memset(&entry, 0, sizeof(entry));
    entry.dwSize = sizeof(entry);
    int owned = 0;
    for (BOOL found = Process32FirstW(snapshot, &entry); found; found = Process32NextW(snapshot, &entry)) {
        if (entry.th32ProcessID == pid) { owned = entry.th32ParentProcessID == GetCurrentProcessId(); break; }
    }
    CloseHandle(snapshot);
    if (!owned) *error = ERROR_ACCESS_DENIED;
    return owned;
}

static void scope_finalize(napi_env env, void *data, void *hint)
{
    (void)env;
    (void)hint;
    aab_process_scope *scope = data;
    if (scope->job) CloseHandle(scope->job);
    free(scope);
}

static DWORD scope_process_handles(HANDLE job, HANDLE **handles, DWORD *count)
{
    DWORD capacity = 16, error = ERROR_SUCCESS;
    JOBOBJECT_BASIC_PROCESS_ID_LIST *members;
    *handles = NULL;
    *count = 0;
    for (;;) {
        size_t bytes = offsetof(JOBOBJECT_BASIC_PROCESS_ID_LIST, ProcessIdList) + (size_t)capacity * sizeof(ULONG_PTR);
        if (bytes > MAXDWORD) return ERROR_NOT_ENOUGH_MEMORY;
        members = calloc(1, bytes);
        if (!members) return ERROR_NOT_ENOUGH_MEMORY;
        if (QueryInformationJobObject(job, JobObjectBasicProcessIdList, members, (DWORD)bytes, NULL)) break;
        error = GetLastError();
        DWORD required = members->NumberOfAssignedProcesses;
        free(members);
        if (error != ERROR_MORE_DATA) return error;
        if (required <= capacity) return ERROR_MORE_DATA;
        capacity = required;
    }
    HANDLE *opened = calloc(members->NumberOfProcessIdsInList, sizeof(HANDLE));
    if (!opened && members->NumberOfProcessIdsInList) { free(members); return ERROR_NOT_ENOUGH_MEMORY; }
    error = ERROR_SUCCESS;
    for (DWORD i = 0; i < members->NumberOfProcessIdsInList; i++) {
        HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, (DWORD)members->ProcessIdList[i]);
        if (!process) {
            error = GetLastError();
            if (error == ERROR_INVALID_PARAMETER) { error = ERROR_SUCCESS; continue; }
            break;
        }
        BOOL member;
        if (!IsProcessInJob(process, job, &member)) {
            error = GetLastError();
            CloseHandle(process);
            break;
        }
        // A member may have exited and its PID may have been reused between
        // enumeration and OpenProcess. Never wait on an unrelated replacement.
        if (member) opened[(*count)++] = process;
        else CloseHandle(process);
    }
    free(members);
    *handles = opened;
    return error;
}

static napi_value scope_close(napi_env env, napi_callback_info info)
{
    napi_value self, result;
    aab_process_scope *scope;
    if (napi_get_cb_info(env, info, NULL, NULL, &self, NULL) != napi_ok || napi_unwrap(env, self, (void **)&scope) != napi_ok) return NULL;
    if (scope->job) {
        // Explicit termination must not kill the caller before this native
        // operation returns. A caller-owned self scope ends at process exit.
        if (scope->pid == GetCurrentProcessId()) {
            napi_throw_error(env, "process_scope_self_close", "The caller cannot terminate its own process scope.");
            return NULL;
        }
        // Seal only a cancelling Job before taking its member snapshot. The
        // zero limit rejects new process associations, including descendants
        // in nested Jobs, so a concurrent spawn cannot escape the handle wait.
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
        DWORD error = ERROR_SUCCESS, count = 0;
        const char *operation = "QueryInformationJobObject for termination";
        if (!QueryInformationJobObject(scope->job, JobObjectExtendedLimitInformation, &limits, sizeof(limits), NULL)) error = GetLastError();
        if (!error) {
            limits.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
            limits.BasicLimitInformation.ActiveProcessLimit = 0;
            if (!SetInformationJobObject(scope->job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
                error = GetLastError(); operation = "SetInformationJobObject for termination";
            }
        }
        HANDLE *processes = NULL;
        if (!error) {
            error = scope_process_handles(scope->job, &processes, &count);
            operation = "Open process handles for termination";
        }
        // A failed observation must still request termination of this owned
        // Job. Keep the first failure: partial cleanup cannot prove completion.
        BOOL terminated = TerminateJobObject(scope->job, 1);
        if (!terminated && !error) { error = GetLastError(); operation = "TerminateJobObject"; }
        ULONGLONG deadline = GetTickCount64() + 5000;
        for (DWORD i = 0; terminated && i < count; i++) {
            ULONGLONG now = GetTickCount64();
            DWORD wait = WaitForSingleObject(processes[i], now < deadline ? (DWORD)(deadline - now) : 0);
            if (wait != WAIT_OBJECT_0 && !error) {
                error = wait == WAIT_FAILED ? GetLastError() : WAIT_TIMEOUT;
                operation = "WaitForSingleObject for termination";
            }
        }
        // ActiveProcesses can reach zero before process handles are signaled.
        // Conversely, an association rejected by the active-process limit can
        // stay counted until its last handle closes. Release our handles before
        // the final accounting check, after waiting on the actual processes.
        for (DWORD i = 0; i < count; i++) CloseHandle(processes[i]);
        free(processes);
        if (error) return windows_error(env, operation, error);
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
        for (;;) {
            if (!QueryInformationJobObject(scope->job, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), NULL))
                return windows_error(env, "QueryInformationJobObject", GetLastError());
            if (!accounting.ActiveProcesses) break;
            if (GetTickCount64() >= deadline) return windows_error(env, "TerminateJobObject wait", WAIT_TIMEOUT);
            Sleep(5);
        }
        if (!CloseHandle(scope->job)) return windows_error(env, "CloseHandle", GetLastError());
        scope->job = NULL;
    }
    napi_get_undefined(env, &result);
    return result;
}

static napi_value scope_release(napi_env env, napi_callback_info info)
{
    napi_value self, result;
    aab_process_scope *scope;
    if (napi_get_cb_info(env, info, NULL, NULL, &self, NULL) != napi_ok || napi_unwrap(env, self, (void **)&scope) != napi_ok) return NULL;
    if (scope->job) {
        // Natural completion transfers daemon lifetime back to the tool/user.
        // Unfinished scopes retain KILL_ON_JOB_CLOSE, including on Host death.
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
        if (!QueryInformationJobObject(scope->job, JobObjectExtendedLimitInformation, &limits, sizeof(limits), NULL))
            return windows_error(env, "QueryInformationJobObject for release", GetLastError());
        limits.BasicLimitInformation.LimitFlags &= ~JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (!SetInformationJobObject(scope->job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)))
            return windows_error(env, "SetInformationJobObject for release", GetLastError());
        if (!CloseHandle(scope->job)) return windows_error(env, "CloseHandle for release", GetLastError());
        scope->job = NULL;
    }
    napi_get_undefined(env, &result);
    return result;
}

static napi_value create_scope(napi_env env, napi_callback_info info)
{
    size_t argc = 1;
    napi_value argv[1], result, method;
    DWORD pid, error = ERROR_SUCCESS;
    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1 || !read_pid(env, argv[0], &pid)) return NULL;
    HANDLE process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid);
    if (!process) return windows_error(env, "OpenProcess for scope", GetLastError());
    // Callers attach only while their trusted SDK waits for its start frame.
    // No user code runs before this assignment has succeeded.
    if (!owned_child(pid, &error) || WaitForSingleObject(process, 0) != WAIT_TIMEOUT) {
        CloseHandle(process);
        return windows_error(env, "Owned live process validation", error ? error : ERROR_PROCESS_ABORTED);
    }
    aab_process_scope *scope = calloc(1, sizeof(*scope));
    if (!scope) { CloseHandle(process); return windows_error(env, "Allocate process scope", ERROR_NOT_ENOUGH_MEMORY); }
    scope->pid = pid;
    scope->job = CreateJobObjectW(NULL, NULL);
    if (!scope->job) error = GetLastError();
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
    memset(&limits, 0, sizeof(limits));
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!error && !SetInformationJobObject(scope->job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) error = GetLastError();
    if (!error && !AssignProcessToJobObject(scope->job, process)) error = GetLastError();
    CloseHandle(process);
    if (error) { if (scope->job) CloseHandle(scope->job); free(scope); return windows_error(env, "Create process scope", error); }
    if (napi_create_object(env, &result) != napi_ok || napi_wrap(env, result, scope, scope_finalize, NULL, NULL) != napi_ok) {
        scope_finalize(env, scope, NULL);
        return NULL;
    }
    if (napi_create_function(env, "close", NAPI_AUTO_LENGTH, scope_close, NULL, &method) != napi_ok || napi_set_named_property(env, result, "close", method) != napi_ok) return NULL;
    if (napi_create_function(env, "release", NAPI_AUTO_LENGTH, scope_release, NULL, &method) != napi_ok || napi_set_named_property(env, result, "release", method) != napi_ok) return NULL;
    return result;
}

static napi_value terminate_process(napi_env env, napi_callback_info info)
{
    size_t argc = 2, length;
    napi_value argv[2], result;
    DWORD pid;
    char expected[32], actual[32];
    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 2 || !read_pid(env, argv[0], &pid)) return NULL;
    if (pid == GetCurrentProcessId()) { napi_throw_error(env, "process_self_termination", "Use an independent control process."); return NULL; }
    if (napi_get_value_string_utf8(env, argv[1], NULL, 0, &length) != napi_ok || !length || length >= sizeof(expected)
        || napi_get_value_string_utf8(env, argv[1], expected, sizeof(expected), &length) != napi_ok || strlen(expected) != length) {
        napi_throw_type_error(env, "invalid_process_start", "Expected the recorded Windows creation time."); return NULL;
    }
    HANDLE process = OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid);
    if (!process) {
        DWORD error = GetLastError();
        if (error != ERROR_INVALID_PARAMETER) return windows_error(env, "OpenProcess for termination", error);
        napi_get_boolean(env, 0, &result); return result;
    }
    if (!start_text(process, actual)) { DWORD error = GetLastError(); CloseHandle(process); return windows_error(env, "GetProcessTimes", error); }
    int stopped = 0;
    DWORD error = ERROR_SUCCESS;
    // Identity and termination use the same kernel handle: a reused PID can
    // never redirect this operation to an unrelated replacement process.
    if (!strcmp(expected, actual) && WaitForSingleObject(process, 0) == WAIT_TIMEOUT) {
        if (!TerminateProcess(process, 1)) error = GetLastError();
        else {
            DWORD wait = WaitForSingleObject(process, 5000);
            if (wait != WAIT_OBJECT_0) error = wait == WAIT_FAILED ? GetLastError() : WAIT_TIMEOUT;
            else stopped = 1;
        }
    }
    CloseHandle(process);
    if (error) return windows_error(env, "TerminateProcess", error);
    napi_get_boolean(env, stopped, &result);
    return result;
}

napi_status aab_windows_process_init(napi_env env, napi_value exports)
{
    const napi_property_descriptor properties[] = {
        { "windowsProcessStart", NULL, process_start, NULL, NULL, NULL, napi_default, NULL },
        { "windowsCreateProcessScope", NULL, create_scope, NULL, NULL, NULL, napi_default, NULL },
        { "windowsTerminateProcess", NULL, terminate_process, NULL, NULL, NULL, napi_default, NULL }
    };
    return napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
}
#else
napi_status aab_windows_process_init(napi_env env, napi_value exports)
{
    (void)env;
    (void)exports;
    return napi_ok;
}
#endif
