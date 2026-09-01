#include "aab_nslog_hook.h"
#include "fishhook.h"

#import <Foundation/Foundation.h>

#include <stdarg.h>

static void (*aab_orig_nslog)(NSString *format, ...) = NULL;
static aab_nslog_sink aab_sink = NULL;

static void aab_my_nslog(NSString *format, ...) {
    va_list args;
    va_start(args, format);
    NSString *message = [[NSString alloc] initWithFormat:format arguments:args];
    va_end(args);
    if (aab_sink != NULL && message != nil) {
        aab_sink([message UTF8String]);
    }
    if (aab_orig_nslog != NULL) {
        aab_orig_nslog(@"%@", message);
    }
}

void aab_nslog_hook_start(aab_nslog_sink sink) {
    aab_sink = sink;
    struct aab_rebinding binding;
    binding.name = "NSLog";
    binding.replacement = (void *)aab_my_nslog;
    binding.replaced = (void **)&aab_orig_nslog;
    aab_rebind_symbols(&binding, 1);
}

void aab_nslog_hook_stop(void) {
    aab_sink = NULL;
}
