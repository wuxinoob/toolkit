/*
 * calc.exe — a sidecar backend that speaks the toolkit message protocol.
 *
 * The point of this example: the sidecar uses the SAME envelope as the host,
 * framed with the `line-json` codec (one JSON document per line). So the
 * plugin talks to its native helper and to the host with one vocabulary.
 *
 *   request   {"v":1,"kind":"req","id":N,"svc":"calc","act":"eval",
 *              "p":{"op":"add","sub":"mul","div","mod","a":A,"b":B}}
 *   response  {"v":1,"kind":"res","id":N,"p":{"result":R}}
 *             {"v":1,"kind":"err","id":N,"code":"div_by_zero","msg":"..."}
 *
 * Build:  gcc -O2 -o calc.exe calc.c
 *
 * The parser below is deliberately minimal: it scans for the fixed keys our
 * client emits. It is not a general JSON parser and does not need to be — the
 * contract is fixed on both sides.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static long find_int(const char *s, const char *key, long dflt) {
    char pat[64];
    snprintf(pat, sizeof pat, "\"%s\"", key);
    const char *p = strstr(s, pat);
    if (!p) return dflt;
    p = strchr(p + strlen(pat), ':');
    if (!p) return dflt;
    return strtol(p + 1, NULL, 10);
}

static int find_str(const char *s, const char *key, char *out, size_t n) {
    char pat[64];
    snprintf(pat, sizeof pat, "\"%s\"", key);
    const char *p = strstr(s, pat);
    if (!p) return 0;
    p = strchr(p + strlen(pat), ':');
    if (!p) return 0;
    p = strchr(p, '"');
    if (!p) return 0;
    p++;
    const char *e = strchr(p, '"');
    if (!e) return 0;
    size_t len = (size_t)(e - p);
    if (len >= n) len = n - 1;
    memcpy(out, p, len);
    out[len] = 0;
    return 1;
}

int main(void) {
    char line[65536];
    /* line buffered: the host polls for lines, so every reply must flush */
    setvbuf(stdout, NULL, _IOLBF, 0);

    while (fgets(line, sizeof line, stdin)) {
        long id = find_int(line, "id", 0);
        char op[16] = {0};
        if (!find_str(line, "op", op, sizeof op)) continue;

        long a = find_int(line, "a", 0);
        long b = find_int(line, "b", 0);
        long r = 0;
        const char *err = NULL;

        if (!strcmp(op, "add")) r = a + b;
        else if (!strcmp(op, "sub")) r = a - b;
        else if (!strcmp(op, "mul")) r = a * b;
        else if (!strcmp(op, "div")) { if (b == 0) err = "div_by_zero"; else r = a / b; }
        else if (!strcmp(op, "mod")) { if (b == 0) err = "div_by_zero"; else r = a % b; }
        else err = "unknown_op";

        if (err) {
            printf("{\"v\":1,\"kind\":\"err\",\"id\":%ld,\"code\":\"%s\",\"msg\":\"%s\"}\n", id, err, err);
        } else {
            printf("{\"v\":1,\"kind\":\"res\",\"id\":%ld,\"p\":{\"result\":%ld}}\n", id, r);
        }
        fflush(stdout);
    }
    return 0;
}
