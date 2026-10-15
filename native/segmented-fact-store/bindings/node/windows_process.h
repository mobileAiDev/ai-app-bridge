#ifndef AAB_WINDOWS_PROCESS_H
#define AAB_WINDOWS_PROCESS_H

#include <node_api.h>

/* Host process ownership is separate from the FactStore C API. */
napi_status aab_windows_process_init(napi_env env, napi_value exports);

#endif
