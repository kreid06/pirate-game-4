#include "net/websocket_auth.h"
#include "util/log.h"
#include <openssl/bio.h>
#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <stdlib.h>
#include <string.h>

/* Base64url → standard base64 decode into out (NUL-terminated).
 * Returns decoded length, or -1 on error. out must be >= strlen(in)+4 bytes. */
int base64url_decode(const char *in, unsigned char *out, int out_size) {
    size_t in_len = strlen(in);
    /* Copy and transform: - -> +, _ -> / */
    char *tmp = malloc(in_len + 4);
    if (!tmp) return -1;
    for (size_t i = 0; i < in_len; i++) {
        if      (in[i] == '-') tmp[i] = '+';
        else if (in[i] == '_') tmp[i] = '/';
        else                   tmp[i] = in[i];
    }
    /* Add padding */
    size_t pad = (4 - (in_len % 4)) % 4;
    for (size_t i = 0; i < pad; i++) tmp[in_len + i] = '=';
    tmp[in_len + pad] = '\0';

    BIO *b64 = BIO_new(BIO_f_base64());
    BIO *mem = BIO_new_mem_buf(tmp, (int)(in_len + pad));
    BIO_push(b64, mem);
    BIO_set_flags(b64, BIO_FLAGS_BASE64_NO_NL);
    int decoded = BIO_read(b64, out, out_size - 1);
    BIO_free_all(b64);
    free(tmp);
    if (decoded < 0) decoded = 0;
    out[decoded] = '\0';
    return decoded;
}

/*
 * Extract the display_name claim from a JWT token.
 * Always verifies the HMAC-SHA256 signature; returns false immediately when
 * JWT_SECRET is not set so the server never accepts unsigned tokens.
 *
 * Returns true and fills display_name (up to name_size bytes) on success.
 * Returns false if JWT_SECRET is absent, the token is malformed, or signature
 * verification fails.
 */
bool jwt_extract_display_name(const char *token,
                              char *display_name, size_t name_size) {
    /* JWT format: header.payload.signature */
    const char *dot1 = strchr(token, '.');
    if (!dot1) return false;
    const char *dot2 = strchr(dot1 + 1, '.');
    if (!dot2) return false;

    /* ── Mandatory signature verification ────────────────────────────────── */
    /* Refuse the token outright when JWT_SECRET is absent — accepting unsigned
     * tokens would let any attacker forge an arbitrary display_name and load a
     * victim's save by triggering the duplicate-login kick.                    */
    const char *secret = getenv("JWT_SECRET");
    if (!secret || strlen(secret) == 0) {
        log_error("JWT_SECRET not set — refusing token (set EnvironmentFile in pirate-server.service)");
        return false;
    }
    /* Defence-in-depth: also refuse the publicly-known default placeholder.
     * The startup guard in main() should catch this before the server ever
     * accepts connections, but an extra check here makes the auth path safe
     * regardless of how the library is invoked.                              */
    if (strcmp(secret, "change-me-to-a-long-random-secret") == 0) {
        log_error("JWT_SECRET is the default placeholder — refusing token (rotate the secret)");
        return false;
    }
    {
        /* Signed message = everything before the second dot */
        size_t msg_len = (size_t)(dot2 - token);
        unsigned int sig_len = 0;
        unsigned char computed[EVP_MAX_MD_SIZE];
        HMAC(EVP_sha256(),
             secret, (int)strlen(secret),
             (const unsigned char *)token, msg_len,
             computed, &sig_len);

        /* Base64url-encode computed signature */
        BIO *b64 = BIO_new(BIO_f_base64());
        BIO *mem = BIO_new(BIO_s_mem());
        BIO_push(b64, mem);
        BIO_set_flags(b64, BIO_FLAGS_BASE64_NO_NL);
        BIO_write(b64, computed, (int)sig_len);
        BIO_flush(b64);
        const char *enc_data = NULL;
        long enc_len = BIO_get_mem_data(mem, &enc_data);

        /* Convert to base64url */
        char *enc = malloc((size_t)enc_len + 1);
        if (enc) {
            memcpy(enc, enc_data, (size_t)enc_len);
            enc[enc_len] = '\0';
            for (long i = 0; i < enc_len; i++) {
                if      (enc[i] == '+') enc[i] = '-';
                else if (enc[i] == '/') enc[i] = '_';
                else if (enc[i] == '=') { enc[i] = '\0'; enc_len = i; break; }
            }
            int match = (strncmp(dot2 + 1, enc, (size_t)enc_len) == 0);
            free(enc);
            BIO_free_all(b64);
            if (!match) {
                log_warn("JWT signature verification failed — rejecting token");
                return false;
            }
        } else {
            BIO_free_all(b64);
        }
    }

    /* ── Decode payload ───────────────────────────────────────────────────── */
    size_t payload_b64_len = (size_t)(dot2 - (dot1 + 1));
    char *payload_b64 = malloc(payload_b64_len + 5);
    if (!payload_b64) return false;
    strncpy(payload_b64, dot1 + 1, payload_b64_len);
    payload_b64[payload_b64_len] = '\0';

    unsigned char payload_json[1024] = {0};
    int decoded = base64url_decode(payload_b64, payload_json, (int)sizeof(payload_json));
    free(payload_b64);
    if (decoded <= 0) return false;

    /* ── Extract display_name ─────────────────────────────────────────────── */
    const char *key = "\"display_name\":\"";
    char *start = strstr((char *)payload_json, key);
    if (!start) return false;
    start += strlen(key);
    char *end = strchr(start, '"');
    if (!end) return false;
    size_t len = (size_t)(end - start);
    if (len == 0 || len >= name_size) return false;
    strncpy(display_name, start, len);
    display_name[len] = '\0';
    return true;
}
