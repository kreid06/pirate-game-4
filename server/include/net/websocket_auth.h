#pragma once
#include <stdbool.h>
#include <stddef.h>

/* Decode base64url string. Returns decoded length or -1 on error. out must be >= strlen(in)+4 bytes. */
int base64url_decode(const char *in, unsigned char *out, int out_size);

/* Extract display_name from JWT token. Returns true on success, false if malformed or sig fail. */
bool jwt_extract_display_name(const char *token, char *display_name, size_t name_size);
