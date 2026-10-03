/*
 * idle.exe — the sidecar backend for tests/fixtures/plugins/eyecare (Eye Care).
 *
 * Why a native helper at all: "is the user touching the keyboard?" is an OS
 * question (GetLastInputInfo), and a plugin has no syscall surface — no fs, no
 * native imports. The documented way to add backend logic is a helper binary
 * INSIDE the plugin folder, spoken to over the `stdio-line` scheme. So this
 * file is the plugin's entire backend.
 *
 * Protocol: one JSON document per line on stdout, in the host's unified
 * envelope (line-json codec). It is an `evt` — a fire-and-forget push — so the
 * plugin's main window can treat it exactly like a broadcast:
 *
 *   {"v":1,"kind":"evt","ch":"ec-idle","topic":"idle","p":{"idleMs":1234}}
 *
 * One long-lived process, not one spawn per sample: the Script Kit original
 * compiled and execFileSync'd a helper every second, which is ~1 process per
 * second. Here the process starts once and emits a sample every 250 ms.
 *
 * Build (mingw; also documented in README.md):
 *   gcc -O2 -mwindows -o idle.exe idle.c
 *
 * `-mwindows` is deliberate: this is a GUI-subsystem binary, so it can never
 * flash a console window even when the host has no console to inherit. stdout
 * still works, because the host redirects it to a pipe.
 */

#include <windows.h>
#include <stdio.h>

/* Sample interval. 250 ms is 4 Hz — finer than the default 1.2 s idle
 * threshold needs, and still only ~4 lines/s of pipe traffic. */
#define SAMPLE_MS 250

int main(void) {
    /* Unbuffered: a block-buffered stdout would hold samples in the CRT until
     * the buffer filled, so the plugin would see nothing for a long time. */
    setvbuf(stdout, NULL, _IONBF, 0);

    for (;;) {
        LASTINPUTINFO lii;
        DWORD idle = 0;
        lii.cbSize = sizeof(LASTINPUTINFO);
        if (GetLastInputInfo(&lii)) {
            /* GetTickCount wraps every ~49.7 days; the unsigned subtraction
             * stays correct across the wrap, which is why it is not cast to a
             * signed type. */
            idle = GetTickCount() - lii.dwTime;
        }
        printf("{\"v\":1,\"kind\":\"evt\",\"ch\":\"ec-idle\",\"topic\":\"idle\","
               "\"p\":{\"idleMs\":%lu}}\n",
               (unsigned long)idle);
        Sleep(SAMPLE_MS);
    }

    return 0;
}
