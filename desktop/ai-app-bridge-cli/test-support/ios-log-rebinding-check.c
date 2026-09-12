#include <assert.h>
#include <mach/mach.h>
#include <stdbool.h>
#include <stdio.h>

static bool deny_protection;
static kern_return_t checked_vm_protect(vm_map_t task, vm_address_t address,
    vm_size_t size, boolean_t maximum, vm_prot_t protection) {
    return deny_protection ? KERN_PROTECTION_FAILURE
        : vm_protect(task, address, size, maximum, protection);
}
#define vm_protect checked_vm_protect
#include "../../../ios/ai-app-bridge-ios/Sources/AiAppBridgeFactStoreC/fishhook.c"
#undef vm_protect

int main(void) {
    vm_address_t page = 0;
    assert(vm_allocate(mach_task_self(), &page, vm_page_size, VM_FLAGS_ANYWHERE) == KERN_SUCCESS);
    void **slot = (void **)page;
    int original, replacement;
    void *replaced = NULL;
    *slot = &original;
    assert(vm_protect(mach_task_self(), page, vm_page_size, FALSE, VM_PROT_READ) == KERN_SUCCESS);
    struct aab_rebinding binding = {"test", &replacement, &replaced};
    struct rebindings_entry entries = {&binding, 1, NULL};
    section_t section = {0}; section.addr = page; section.size = sizeof(void *);
    nlist_t symbols[1] = {0}; uint32_t indices[1] = {0};
    char strings[] = "_test";

    // A denied permission change cannot write either the protected page or
    // the caller's original-function pointer.
    deny_protection = true;
    perform_rebinding_with_section(&entries, &section, 0, symbols, strings, indices);
    assert(*slot == &original && replaced == NULL);
    // This is a real read-only VM page, matching the physical-device crash.
    deny_protection = false;
    perform_rebinding_with_section(&entries, &section, 0, symbols, strings, indices);
    assert(*slot == &replacement && replaced == &original);
    perform_rebinding_with_section(&entries, &section, 0, symbols, strings, indices);
    assert(*slot == &replacement && replaced == &original);
    assert(vm_deallocate(mach_task_self(), page, vm_page_size) == KERN_SUCCESS);
    puts("PASS protected-page rebind, denied permission, repeated binding");
    return 0;
}
