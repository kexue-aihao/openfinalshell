/*
 * ofspty — the privileged PTY host for local shell sessions.
 *
 * Why this exists at all: Termux's libtermux.so cannot be used outside the app's own process. Its
 * JNI class runs `System.loadLibrary("termux")` in a static initializer, and loadLibrary resolves
 * purely by library-path search without consulting what is already loaded, so an app_process- or
 * su-launched helper always fails with UnsatisfiedLinkError. A privileged tier therefore needs its
 * own way to allocate a PTY — which is this file.
 *
 * It is deliberately a standalone binary rather than a JVM host: no AIDL, no classpath, no
 * app_process. The launcher (a Shizuku user service, or `su`) only has to start it and remember the
 * pid, so the same artifact serves both privileged tiers and is also the prerequisite for any future
 * proot userland.
 *
 * Wire protocol (all lengths big-endian):
 *   app -> host   HELLO  32-byte token
 *                 INPUT  raw bytes for the pty
 *                 RESIZE 4 bytes: rows (u16), cols (u16)
 *                 CLOSE  empty
 *   host -> app   ACK    empty, sent after a matching HELLO
 *                 DATA   raw bytes read from the pty
 *                 EXIT   4 bytes: wait status
 *
 * --port 0 makes the host bind an ephemeral port and print "PORT <n>" as the first stdout line.
 * The launcher reads it back, which removes the race a caller-chosen port would have between probing
 * for a free port and the host binding it.
 */

#define _GNU_SOURCE

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <pty.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/ioctl.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>

#define MSG_HELLO 1
#define MSG_INPUT 2
#define MSG_RESIZE 3
#define MSG_CLOSE 4
#define MSG_ACK 0x81
#define MSG_DATA 0x82
#define MSG_EXIT 0x83

#define TOKEN_LEN 32
#define MAX_PAYLOAD (64 * 1024)
#define MAX_ENV 64

static const char *g_token_hex = NULL;
static unsigned char g_token[TOKEN_LEN];

static void die(const char *what) {
    fprintf(stderr, "ofspty: %s: %s\n", what, strerror(errno));
    exit(1);
}

static int write_all(int fd, const void *buf, size_t len) {
    const unsigned char *p = buf;
    while (len > 0) {
        ssize_t n = write(fd, p, len);
        if (n < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        p += n;
        len -= (size_t)n;
    }
    return 0;
}

static int read_all(int fd, void *buf, size_t len) {
    unsigned char *p = buf;
    while (len > 0) {
        ssize_t n = read(fd, p, len);
        if (n < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        if (n == 0) return -1;
        p += n;
        len -= (size_t)n;
    }
    return 0;
}

static int send_msg(int fd, unsigned char type, const void *payload, uint32_t len) {
    unsigned char header[5];
    header[0] = type;
    header[1] = (unsigned char)(len >> 24);
    header[2] = (unsigned char)(len >> 16);
    header[3] = (unsigned char)(len >> 8);
    header[4] = (unsigned char)len;
    if (write_all(fd, header, 5) != 0) return -1;
    if (len > 0 && write_all(fd, payload, len) != 0) return -1;
    return 0;
}

/* Returns 0 on a complete message, -1 on EOF or error. */
static int recv_msg(int fd, unsigned char *type, unsigned char *payload, uint32_t *len) {
    unsigned char header[5];
    if (read_all(fd, header, 5) != 0) return -1;
    uint32_t size = ((uint32_t)header[1] << 24) | ((uint32_t)header[2] << 16) |
                    ((uint32_t)header[3] << 8) | (uint32_t)header[4];
    if (size > (uint32_t)MAX_PAYLOAD) return -1;
    if (size > 0 && read_all(fd, payload, size) != 0) return -1;
    *type = header[0];
    *len = size;
    return 0;
}

static int hex_nibble(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static void decode_token(const char *hex) {
    if (strlen(hex) != TOKEN_LEN * 2) {
        fprintf(stderr, "ofspty: --token must be %d hex characters\n", TOKEN_LEN * 2);
        exit(2);
    }
    for (int i = 0; i < TOKEN_LEN; i++) {
        int hi = hex_nibble(hex[i * 2]);
        int lo = hex_nibble(hex[i * 2 + 1]);
        if (hi < 0 || lo < 0) {
            fprintf(stderr, "ofspty: --token is not hexadecimal\n");
            exit(2);
        }
        g_token[i] = (unsigned char)((hi << 4) | lo);
    }
}

/* A constant-time compare: a token that leaks its own prefix is not much of a token. */
static int token_matches(const unsigned char *candidate) {
    unsigned char diff = 0;
    for (int i = 0; i < TOKEN_LEN; i++) diff |= (unsigned char)(candidate[i] ^ g_token[i]);
    return diff == 0;
}

static void set_window_size(int master, int rows, int cols) {
    struct winsize size;
    memset(&size, 0, sizeof(size));
    size.ws_row = (unsigned short)rows;
    size.ws_col = (unsigned short)cols;
    ioctl(master, TIOCSWINSZ, &size);
}

/*
 * Self-test: allocate a PTY, run `sh -c 'id -u'` under it, and print what the pty produced.
 *
 * This is what lets CI prove the load-bearing half of a privileged tier without a Shizuku
 * installation: the helper builds, ships, executes, and allocates a PTY with a usable window size,
 * and the uid it reports is the uid it will really run shells as.
 */
static int self_test(void) {
    int master = -1;
    struct winsize size;
    memset(&size, 0, sizeof(size));
    size.ws_row = 24;
    size.ws_col = 80;

    pid_t child = forkpty(&master, NULL, NULL, &size);
    if (child < 0) die("forkpty");
    if (child == 0) {
        execl("/system/bin/sh", "sh", "-c", "id -u", (char *)NULL);
        _exit(127);
    }

    char buffer[512];
    size_t used = 0;
    for (;;) {
        ssize_t n = read(master, buffer + used, sizeof(buffer) - used - 1);
        if (n > 0) {
            used += (size_t)n;
            if (used >= sizeof(buffer) - 1) break;
            continue;
        }
        /* On a pty, a closed master reads as EIO rather than as end-of-file. */
        if (n < 0 && errno == EINTR) continue;
        break;
    }
    int status = 0;
    waitpid(child, &status, 0);
    close(master);

    while (used > 0 && (buffer[used - 1] == '\n' || buffer[used - 1] == '\r')) used--;
    buffer[used] = '\0';
    printf("%s\n", buffer);
    return 0;
}

static int parse_int(const char *value, const char *what) {
    char *end = NULL;
    long parsed = strtol(value, &end, 10);
    if (end == value || *end != '\0' || parsed < 0 || parsed > 65535) {
        fprintf(stderr, "ofspty: invalid %s: %s\n", what, value);
        exit(2);
    }
    return (int)parsed;
}

int main(int argc, char **argv) {
    int port = -1;
    int rows = 24;
    int cols = 80;
    const char *shell = "/system/bin/sh";
    const char *cwd = NULL;
    const char *command = NULL;
    int exec_mode = 0;
    const char *env_entries[MAX_ENV];
    int env_count = 0;
    int listen_timeout_ms = 20000;

    for (int i = 1; i < argc; i++) {
        const char *arg = argv[i];
        const char *value = (i + 1 < argc) ? argv[i + 1] : NULL;
        if (strcmp(arg, "--self-test") == 0) {
            return self_test();
        } else if (strcmp(arg, "--port") == 0 && value) {
            port = parse_int(value, "--port");
            i++;
        } else if (strcmp(arg, "--rows") == 0 && value) {
            rows = parse_int(value, "--rows");
            i++;
        } else if (strcmp(arg, "--cols") == 0 && value) {
            cols = parse_int(value, "--cols");
            i++;
        } else if (strcmp(arg, "--shell") == 0 && value) {
            shell = value;
            i++;
        } else if (strcmp(arg, "--cwd") == 0 && value) {
            cwd = value;
            i++;
        } else if (strcmp(arg, "--command") == 0 && value) {
            command = value;
            i++;
        } else if (strcmp(arg, "--mode") == 0 && value) {
            exec_mode = strcmp(value, "exec") == 0;
            i++;
        } else if (strcmp(arg, "--env") == 0 && value) {
            if (env_count < MAX_ENV) env_entries[env_count++] = value;
            i++;
        } else if (strcmp(arg, "--token") == 0 && value) {
            g_token_hex = value;
            i++;
        } else if (strcmp(arg, "--listen-timeout-ms") == 0 && value) {
            listen_timeout_ms = parse_int(value, "--listen-timeout-ms");
            i++;
        } else {
            fprintf(stderr, "ofspty: unrecognised argument: %s\n", arg);
            return 2;
        }
    }

    if (port < 0 || g_token_hex == NULL) {
        fprintf(stderr, "ofspty: --port and --token are required\n");
        return 2;
    }
    if (exec_mode && command == NULL) {
        fprintf(stderr, "ofspty: --mode exec requires --command\n");
        return 2;
    }
    decode_token(g_token_hex);

    int listener = socket(AF_INET, SOCK_STREAM, 0);
    if (listener < 0) die("socket");
    int reuse = 1;
    setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));

    struct sockaddr_in address;
    memset(&address, 0, sizeof(address));
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    address.sin_port = htons((uint16_t)port);
    if (bind(listener, (struct sockaddr *)&address, sizeof(address)) != 0) die("bind");
    if (listen(listener, 1) != 0) die("listen");

    /* Report the resolved port so a `--port 0` caller never has to guess one. */
    socklen_t address_len = sizeof(address);
    if (getsockname(listener, (struct sockaddr *)&address, &address_len) == 0) {
        printf("PORT %d\n", ntohs(address.sin_port));
        fflush(stdout);
    }

    int client = -1;
    for (int waited = 0; waited < listen_timeout_ms; waited += 200) {
        struct pollfd waiting;
        waiting.fd = listener;
        waiting.events = POLLIN;
        int ready = poll(&waiting, 1, 200);
        if (ready > 0) {
            client = accept(listener, NULL, NULL);
            break;
        }
        if (ready < 0 && errno != EINTR) break;
    }
    close(listener);
    if (client < 0) {
        fprintf(stderr, "ofspty: no client connected within %d ms\n", listen_timeout_ms);
        return 3;
    }
    int nodelay = 1;
    setsockopt(client, IPPROTO_TCP, TCP_NODELAY, &nodelay, sizeof(nodelay));

    /* The handshake is the only authentication: loopback TCP is reachable by any app on the device. */
    unsigned char scratch[MAX_PAYLOAD];
    uint32_t length = 0;
    unsigned char type = 0;
    if (recv_msg(client, &type, scratch, &length) != 0 || type != MSG_HELLO || length != TOKEN_LEN) {
        fprintf(stderr, "ofspty: expected a %d-byte HELLO\n", TOKEN_LEN);
        return 3;
    }
    if (!token_matches(scratch)) {
        fprintf(stderr, "ofspty: token mismatch\n");
        return 3;
    }
    if (send_msg(client, MSG_ACK, NULL, 0) != 0) return 3;

    if (cwd != NULL && chdir(cwd) != 0) {
        /* Not fatal: the shell starts somewhere, and the caller chose the directory. */
        fprintf(stderr, "ofspty: chdir %s failed: %s\n", cwd, strerror(errno));
    }

    struct winsize size;
    memset(&size, 0, sizeof(size));
    size.ws_row = (unsigned short)rows;
    size.ws_col = (unsigned short)cols;

    int master = -1;
    pid_t child = forkpty(&master, NULL, NULL, &size);
    if (child < 0) die("forkpty");
    if (child == 0) {
        for (int i = 0; i < env_count; i++) {
            const char *entry = env_entries[i];
            const char *equals = strchr(entry, '=');
            if (equals == NULL) continue;
            size_t name_len = (size_t)(equals - entry);
            char name[256];
            if (name_len >= sizeof(name)) continue;
            memcpy(name, entry, name_len);
            name[name_len] = '\0';
            setenv(name, equals + 1, 1);
        }
        if (exec_mode) {
            execl(shell, shell, "-c", command, (char *)NULL);
        } else {
            execl(shell, shell, (char *)NULL);
        }
        _exit(127);
    }

    int child_status = 0;
    int child_reaped = 0;
    for (;;) {
        struct pollfd fds[2];
        fds[0].fd = master;
        fds[0].events = POLLIN;
        fds[1].fd = client;
        fds[1].events = POLLIN;
        int ready = poll(fds, 2, -1);
        if (ready < 0) {
            if (errno == EINTR) continue;
            break;
        }

        if (fds[0].revents & (POLLIN | POLLHUP | POLLERR)) {
            ssize_t n = read(master, scratch, sizeof(scratch));
            if (n > 0) {
                if (send_msg(client, MSG_DATA, scratch, (uint32_t)n) != 0) break;
            } else if (n < 0 && errno == EINTR) {
                continue;
            } else {
                /* EOF or EIO: the shell is gone. */
                break;
            }
        }

        if (fds[1].revents & (POLLIN | POLLHUP | POLLERR)) {
            if (recv_msg(client, &type, scratch, &length) != 0) break;
            if (type == MSG_INPUT) {
                if (length > 0 && write_all(master, scratch, length) != 0) break;
            } else if (type == MSG_RESIZE && length == 4) {
                int new_rows = ((int)scratch[0] << 8) | (int)scratch[1];
                int new_cols = ((int)scratch[2] << 8) | (int)scratch[3];
                set_window_size(master, new_rows, new_cols);
            } else if (type == MSG_CLOSE) {
                kill(child, SIGHUP);
                break;
            }
        }
    }

    if (!child_reaped) {
        /* The shell gets a moment to exit on its own before it is killed. */
        for (int waited = 0; waited < 500; waited += 50) {
            pid_t reaped = waitpid(child, &child_status, WNOHANG);
            if (reaped == child) {
                child_reaped = 1;
                break;
            }
            usleep(50 * 1000);
        }
        if (!child_reaped) {
            kill(child, SIGKILL);
            waitpid(child, &child_status, 0);
        }
    }
    /* Closing the master now would HUP a shell that is still running; it has been reaped by here. */
    close(master);

    /* waitpid fills the *encoded* wait status, not the exit code: a shell that exited with 3 leaves
     * 3 << 8 in this word. Report the code the shell conventions expect, so a caller comparing
     * against 0 or 127 sees what a shell would have returned. */
    int exit_code;
    if (WIFEXITED(child_status)) {
        exit_code = WEXITSTATUS(child_status);
    } else if (WIFSIGNALED(child_status)) {
        exit_code = 128 + WTERMSIG(child_status);
    } else {
        exit_code = child_status;
    }

    unsigned char exit_payload[4];
    exit_payload[0] = (unsigned char)(exit_code >> 24);
    exit_payload[1] = (unsigned char)(exit_code >> 16);
    exit_payload[2] = (unsigned char)(exit_code >> 8);
    exit_payload[3] = (unsigned char)exit_code;
    /* Best effort, and before the socket is closed: the client may already be gone, which is not an
     * error worth reporting. */
    send_msg(client, MSG_EXIT, exit_payload, 4);
    close(client);
    return 0;
}
