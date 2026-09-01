// Copyright (c) 2013, Facebook, Inc.
// All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
// * Redistributions of source code must retain the above copyright notice,
// this list of conditions and the following disclaimer.
// * Redistributions in binary form must reproduce the above copyright notice,
// this list of conditions and the following disclaimer in the documentation
// and/or other materials provided with the distribution.
// * Neither the name Facebook nor the names of its contributors may be used to
// endorse or promote products derived from this software without specific
// prior written permission.

#ifndef AAB_FISHHOOK_H
#define AAB_FISHHOOK_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

struct aab_rebinding {
    const char *name;
    void *replacement;
    void **replaced;
};

int aab_rebind_symbols(struct aab_rebinding rebindings[], size_t rebindings_nel);

#ifdef __cplusplus
}
#endif

#endif
