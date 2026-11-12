#pragma once
#include <errno.h>
#include <limits.h>
#include <math.h>
#include <mach-o/dyld.h>
#include <spawn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

#define BRIDGE_MAGIC 0x50495032u
typedef struct { uint32_t magic; char videoID[12]; double seconds; } VideoPacket;

static int transfer(int fd, void *buffer, size_t size, int writing) {
    char *cursor = buffer;
    while (size) {
        ssize_t count = writing ? write(fd, cursor, size) : read(fd, cursor, size);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) return 0;
        cursor += count; size -= (size_t)count;
    }
    return 1;
}

static int valid_packet(const VideoPacket *packet) {
    if (packet->magic != BRIDGE_MAGIC || packet->videoID[11] ||
        !isfinite(packet->seconds) || packet->seconds < 0 || packet->seconds > 31536000) return 0;
    for (int i = 0; i < 11; ++i) {
        unsigned char c = packet->videoID[i];
        if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
              (c >= '0' && c <= '9') || c == '-' || c == '_')) return 0;
    }
    return 1;
}

static int default_socket(char *path, size_t size) {
    const char *home = getenv("HOME");
    return home && snprintf(path, size, "%s/Library/Application Support/YouTubeMacPiP/bridge.sock", home) < (int)size;
}

static int socket_address(struct sockaddr_un *address, const char *path) {
    memset(address, 0, sizeof(*address));
    if (strlen(path) >= sizeof(address->sun_path)) return 0;
    address->sun_family = AF_UNIX;
    strcpy(address->sun_path, path);
    return 1;
}

static void client_timeout(int fd) {
    struct timeval timeout = {.tv_sec = 2};
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
}

static int launch_player(const VideoPacket *packet) {
    if (!valid_packet(packet)) return 0;
    char raw[PATH_MAX], bundle[PATH_MAX], url[256];
    uint32_t size = sizeof(raw);
    if (_NSGetExecutablePath(raw, &size) || !realpath(raw, bundle)) return 0;
    for (int i = 0; i < 3; ++i) { char *slash = strrchr(bundle, '/'); if (!slash) return 0; *slash = 0; }
    snprintf(url, sizeof(url), "chromeytpip://open?v=%s&t=%.6f", packet->videoID, packet->seconds);
    char *args[] = {"/usr/bin/open", "-a", bundle, url, NULL};
    extern char **environ;
    pid_t pid;
    if (posix_spawn(&pid, args[0], NULL, NULL, args, environ)) return 0;
    int status;
    while (waitpid(pid, &status, 0) < 0) if (errno != EINTR) return 0;
    return WIFEXITED(status) && WEXITSTATUS(status) == 0;
}
