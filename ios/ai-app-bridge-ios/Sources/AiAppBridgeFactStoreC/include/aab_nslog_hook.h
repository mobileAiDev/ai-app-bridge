#ifndef AAB_NSLOG_HOOK_H
#define AAB_NSLOG_HOOK_H

#ifdef __cplusplus
extern "C" {
#endif

typedef void (*aab_nslog_sink)(const char *message);

void aab_nslog_hook_start(aab_nslog_sink sink);
void aab_nslog_hook_stop(void);

#ifdef __cplusplus
}
#endif

#endif
