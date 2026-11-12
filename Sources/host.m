#include <mach-o/dyld.h>
#include <limits.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

int main(void) {
    char path[PATH_MAX];
    uint32_t length = sizeof(path);
    if (_NSGetExecutablePath(path, &length)) return 1;
    char *slash = strrchr(path, '/');
    if (!slash) return 1;
    *slash = 0;
    size_t used = strlen(path);
    if (used + sizeof("/YouTubeMacPiP") > sizeof(path)) return 1;
    memcpy(path + used, "/YouTubeMacPiP", sizeof("/YouTubeMacPiP"));
    execl(path, path, "--native-host", (char *)NULL);
    perror("YouTubeMacPiP");
    return 1;
}
