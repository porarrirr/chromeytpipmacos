#include "Bridge.h"
#include <fcntl.h>
#include <signal.h>
#include <sys/file.h>
#include <sys/stat.h>

static volatile sig_atomic_t stopping;
static int listener = -1;
static void stop(int signal_number) { (void)signal_number; stopping = 1; if (listener >= 0) close(listener); }

int main(int argc, char **argv) {
    char path[sizeof(((struct sockaddr_un *)0)->sun_path)];
    int testing = argc == 3 && !strcmp(argv[1], "--test-socket");
    if (testing) {
        if (strlen(argv[2]) >= sizeof(path)) return 1;
        strcpy(path, argv[2]);
    } else if (!default_socket(path, sizeof(path))) return 1;
    char lock_path[PATH_MAX];
    snprintf(lock_path, sizeof(lock_path), "%s.lock", path);
    umask(0077);
    int lock = open(lock_path, O_CREAT | O_RDWR | O_NOFOLLOW, 0600);
    if (lock < 0 || flock(lock, LOCK_EX | LOCK_NB)) return 1;
    struct stat existing;
    if (!lstat(path, &existing)) {
        if (!S_ISSOCK(existing.st_mode) || existing.st_uid != getuid()) return 1;
        if (unlink(path)) return 1;
    } else if (errno != ENOENT) return 1;
    struct sockaddr_un address;
    if (!socket_address(&address, path)) return 1;
    listener = socket(AF_UNIX, SOCK_STREAM, 0);
    if (listener < 0 || bind(listener, (struct sockaddr *)&address, sizeof(address)) || listen(listener, 8)) return 1;
    fcntl(listener, F_SETFD, FD_CLOEXEC);
    fcntl(lock, F_SETFD, FD_CLOEXEC);
    signal(SIGPIPE, SIG_IGN);
    struct sigaction action = {.sa_handler = stop};
    sigemptyset(&action.sa_mask);
    sigaction(SIGTERM, &action, NULL);
    sigaction(SIGINT, &action, NULL);
    if (testing) { puts("ready"); fflush(stdout); }
    while (!stopping) {
        int client = accept(listener, NULL, NULL);
        if (client < 0) { if (errno == EINTR) continue; if (stopping) break; return 1; }
        fcntl(client, F_SETFD, FD_CLOEXEC);
        client_timeout(client);
        uid_t uid; gid_t gid;
        VideoPacket packet = {0};
        int32_t ok = 0;
        if (!getpeereid(client, &uid, &gid) && uid == getuid() &&
            transfer(client, &packet, sizeof(packet), 0) && valid_packet(&packet)) {
            ok = testing || launch_player(&packet);
        }
        transfer(client, &ok, sizeof(ok), 1);
        close(client);
    }
    unlink(path);
    close(lock);
    return 0;
}
