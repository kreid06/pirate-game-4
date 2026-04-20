/**
 * jwt_verify.h — Lightweight HS256 JWT verification for the C game server.
 *
 * No external dependencies. Uses OpenSSL's HMAC-SHA256, which is already
 * linked by the WebSocket TLS stack (libssl / libcrypto).
 *
 * Usage:
 *   JwtPayload p;
 *   JwtVerifyResult r = jwt_verify(token, getenv("JWT_SECRET"), &p);
 *   if (r == JWT_OK) { ... use p.player_id, p.display_name, p.guest ... }
 *
 * The game server calls this once per WebSocket handshake when the client
 * sends:  { "type": "auth", "token": "<access_token>" }
 * Access tokens expire in 15 minutes; the client is responsible for
 * refreshing via the auth server's POST /auth/refresh endpoint.
 */

#pragma once

#include <stdint.h>
#include <stdbool.h>
#include <string.h>
#include <time.h>
#include <openssl/hmac.h>
#include <openssl/sha.h>

/* ── Result codes ─────────────────────────────────────────────────────────── */
typedef enum {
    JWT_OK            = 0,
    JWT_ERR_FORMAT    = 1,  /* not three dot-separated base64url parts       */
    JWT_ERR_HEADER    = 2,  /* header not HS256 / JWT                        */
    JWT_ERR_SIGNATURE = 3,  /* HMAC mismatch                                 */
    JWT_ERR_EXPIRED   = 4,  /* exp claim is in the past                      */
    JWT_ERR_PAYLOAD   = 5,  /* missing required claims                       */
} JwtVerifyResult;

/* ── Parsed payload ───────────────────────────────────────────────────────── */
typedef struct {
    char     player_id[64];    /* UUID string                                */
    char     display_name[64]; /* username or guest display name             */
    bool     guest;            /* true = guest session                       */
    int64_t  exp;              /* expiry unix timestamp                      */
} JwtPayload;

/* ── Internal: base64url decode (no padding required) ───────────────────── */
static inline int _b64url_decode(const char *in, size_t in_len,
                                  uint8_t *out, size_t out_max) {
    static const int8_t T[256] = {
        ['A']=0,['B']=1,['C']=2,['D']=3,['E']=4,['F']=5,['G']=6,['H']=7,
        ['I']=8,['J']=9,['K']=10,['L']=11,['M']=12,['N']=13,['O']=14,['P']=15,
        ['Q']=16,['R']=17,['S']=18,['T']=19,['U']=20,['V']=21,['W']=22,['X']=23,
        ['Y']=24,['Z']=25,['a']=26,['b']=27,['c']=28,['d']=29,['e']=30,['f']=31,
        ['g']=32,['h']=33,['i']=34,['j']=35,['k']=36,['l']=37,['m']=38,['n']=39,
        ['o']=40,['p']=41,['q']=42,['r']=43,['s']=44,['t']=45,['u']=46,['v']=47,
        ['w']=48,['x']=49,['y']=50,['z']=51,['0']=52,['1']=53,['2']=54,['3']=55,
        ['4']=56,['5']=57,['6']=58,['7']=59,['8']=60,['9']=61,['-']=62,['_']=63,
        [0 ... 44]=-1,[46]=-1,[47]=-1,[58 ... 64]=-1,[91 ... 96]=-1,[123 ... 127]=-1
    };
    size_t out_len = 0;
    uint32_t buf = 0;
    int bits = 0;
    for (size_t i = 0; i < in_len; i++) {
        int8_t v = T[(uint8_t)in[i]];
        if (v < 0) return -1;
        buf = (buf << 6) | (uint32_t)v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            if (out_len >= out_max) return -1;
            out[out_len++] = (uint8_t)(buf >> bits);
        }
    }
    return (int)out_len;
}

/* ── Internal: extract JSON string value ────────────────────────────────── */
static inline bool _json_str(const char *json, const char *key,
                              char *out, size_t out_max) {
    /* Finds "key":"value" — simple enough for JWT payloads (no nesting). */
    char search[80];
    snprintf(search, sizeof(search), "\"%s\":\"", key);
    const char *p = strstr(json, search);
    if (!p) return false;
    p += strlen(search);
    size_t i = 0;
    while (*p && *p != '"' && i + 1 < out_max) out[i++] = *p++;
    out[i] = '\0';
    return i > 0;
}

static inline bool _json_int(const char *json, const char *key, int64_t *out) {
    char search[80];
    snprintf(search, sizeof(search), "\"%s\":", key);
    const char *p = strstr(json, search);
    if (!p) return false;
    p += strlen(search);
    *out = (int64_t)strtoll(p, NULL, 10);
    return true;
}

static inline bool _json_bool(const char *json, const char *key, bool *out) {
    char search[80];
    snprintf(search, sizeof(search), "\"%s\":", key);
    const char *p = strstr(json, search);
    if (!p) return false;
    p += strlen(search);
    *out = (strncmp(p, "true", 4) == 0);
    return true;
}

/* ── Public API ──────────────────────────────────────────────────────────── */

/**
 * Verify an HS256 JWT and populate *payload on success.
 *
 * @param token      Null-terminated JWT string (header.payload.signature)
 * @param secret     Shared secret (must match JWT_SECRET on the auth server)
 * @param payload    Output; only valid when JWT_OK is returned
 */
static inline JwtVerifyResult jwt_verify(const char *token,
                                          const char *secret,
                                          JwtPayload *payload) {
    if (!token || !secret || !payload) return JWT_ERR_FORMAT;

    /* ── Split into three parts ─────────────────────────────────────────── */
    const char *dot1 = strchr(token, '.');
    if (!dot1) return JWT_ERR_FORMAT;
    const char *dot2 = strchr(dot1 + 1, '.');
    if (!dot2) return JWT_ERR_FORMAT;

    size_t hdr_len = (size_t)(dot1 - token);
    size_t pay_len = (size_t)(dot2 - dot1 - 1);
    size_t sig_len = strlen(dot2 + 1);

    /* ── Verify signature ───────────────────────────────────────────────── */
    /* signed_data = header + "." + payload (raw base64url, no decode) */
    size_t signed_len = (size_t)(dot2 - token);

    uint8_t expected_sig[SHA256_DIGEST_LENGTH];
    unsigned int sig_out_len = 0;
    HMAC(EVP_sha256(),
         secret, (int)strlen(secret),
         (const uint8_t *)token, signed_len,
         expected_sig, &sig_out_len);

    uint8_t provided_sig[SHA256_DIGEST_LENGTH + 4];
    int decoded = _b64url_decode(dot2 + 1, sig_len,
                                  provided_sig, sizeof(provided_sig));
    if (decoded != SHA256_DIGEST_LENGTH) return JWT_ERR_SIGNATURE;

    /* Constant-time compare */
    uint8_t diff = 0;
    for (int i = 0; i < SHA256_DIGEST_LENGTH; i++)
        diff |= expected_sig[i] ^ provided_sig[i];
    if (diff != 0) return JWT_ERR_SIGNATURE;

    /* ── Decode header (quick alg check) ───────────────────────────────── */
    char hdr_json[256] = {0};
    if (_b64url_decode(token, hdr_len,
                       (uint8_t *)hdr_json, sizeof(hdr_json) - 1) < 0)
        return JWT_ERR_HEADER;
    if (!strstr(hdr_json, "\"HS256\"")) return JWT_ERR_HEADER;

    /* ── Decode payload ─────────────────────────────────────────────────── */
    char pay_json[1024] = {0};
    if (_b64url_decode(dot1 + 1, pay_len,
                       (uint8_t *)pay_json, sizeof(pay_json) - 1) < 0)
        return JWT_ERR_PAYLOAD;

    int64_t exp = 0;
    if (!_json_int(pay_json, "exp", &exp)) return JWT_ERR_PAYLOAD;
    if (exp < (int64_t)time(NULL))         return JWT_ERR_EXPIRED;

    if (!_json_str(pay_json, "player_id",
                   payload->player_id, sizeof(payload->player_id)))
        return JWT_ERR_PAYLOAD;

    _json_str(pay_json, "display_name",
              payload->display_name, sizeof(payload->display_name));

    bool guest = false;
    _json_bool(pay_json, "guest", &guest);
    payload->guest = guest;
    payload->exp   = exp;

    return JWT_OK;
}
