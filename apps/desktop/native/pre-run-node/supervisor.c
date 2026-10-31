/* Cindy pre-run supervisor: native CLI forwarding, gate proof and owned tree.
 * No user JS is loaded here. The gate must explicitly enter and complete.
 * The protocol is cooperative, not a sandbox against hostile same-user code. */
#ifndef _WIN32
#define _GNU_SOURCE
#endif
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <errno.h>
#include <wchar.h>
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0601
#include <windows.h>
#include <sddl.h>
#include <io.h>
#include <fcntl.h>
typedef HANDLE Channel;
#define BAD_CHANNEL INVALID_HANDLE_VALUE
static CRITICAL_SECTION lock;
#define LOCK() EnterCriticalSection(&lock)
#define UNLOCK() LeaveCriticalSection(&lock)
static HANDLE job, parent_handle;
static PSECURITY_DESCRIPTOR pipe_security;
static HANDLE listener_ready;
static void delay(void) { Sleep(10); }
static wchar_t *wide(const char *s) {
  int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s, -1, NULL, 0);
  wchar_t *w = n ? calloc((size_t)n, sizeof(wchar_t)) : NULL;
  if (w) MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s, -1, w, n);
  return w;
}
/* getenv uses the CRT ANSI codepage even though wmain receives Unicode.
 * Preserve non-ASCII runtime/pipe paths rather than decoding them as UTF-8. */
static const char *environment(const char *name) {
  wchar_t *key = wide(name); if (!key) return NULL;
  const wchar_t *value = _wgetenv(key); free(key); if (!value) return NULL;
  int n = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1, NULL, 0, NULL, NULL);
  char *result = n ? malloc((size_t)n) : NULL;
  if (result) WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1, result, n, NULL, NULL);
  return result; /* Process-lifetime environment values. */
}
static int read_byte(Channel c, char *b) { DWORD n = 0; return ReadFile(c, b, 1, &n, NULL) && n == 1; }
static int send_bytes(Channel c, const char *s) { DWORD n = 0; size_t len = strlen(s); return WriteFile(c, s, (DWORD)len, &n, NULL) && n == len; }
static void close_channel(Channel c) { CloseHandle(c); }
static unsigned long peer_pid(Channel c) { ULONG pid = 0; return GetNamedPipeClientProcessId(c, &pid) ? pid : 0; }
#else
#include <unistd.h>
#include <signal.h>
#include <fcntl.h>
#include <pthread.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <sys/stat.h>
#include <time.h>
typedef int Channel;
#define BAD_CHANNEL (-1)
#define environment getenv
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
#define LOCK() pthread_mutex_lock(&lock)
#define UNLOCK() pthread_mutex_unlock(&lock)
static volatile sig_atomic_t cancelled;
static int listener;
static pid_t shell_pid;
static void delay(void) { struct timespec t = {0, 10000000}; nanosleep(&t, NULL); }
static void on_signal(int sig) { (void)sig; cancelled = 1; }
static int read_byte(Channel c, char *b) { ssize_t n; do { n = read(c, b, 1); } while (n < 0 && errno == EINTR); return n == 1; }
static int send_bytes(Channel c, const char *s) {
  size_t size = strlen(s), sent = 0;
  while (sent < size) { ssize_t n = write(c, s + sent, size - sent); if (n < 0 && errno == EINTR) continue; if (n <= 0) return 0; sent += (size_t)n; }
  return 1;
}
static void close_channel(Channel c) { close(c); }
static unsigned long peer_pid(Channel c) {
#ifdef __APPLE__
  pid_t pid = 0; socklen_t len = sizeof(pid);
  return getsockopt(c, SOL_LOCAL, LOCAL_PEERPID, &pid, &len) == 0 ? (unsigned long)pid : 0;
#else
  struct ucred cred; socklen_t len = sizeof(cred);
  return getsockopt(c, SOL_SOCKET, SO_PEERCRED, &cred, &len) == 0 && cred.uid == getuid() ? (unsigned long)cred.pid : 0;
#endif
}
#endif

/* Only one root launcher and one gate connection belong to a run. */
static struct { unsigned long root, launcher; int entered, completed, node_exit, exited, invalid, connections; Channel gate; } state = {0, 0, 0, -1, -1, 0, 0, 0, BAD_CHANNEL};
static const char *endpoint, *nonce;
static int read_line(Channel c, char *line, size_t size) {
  size_t n = 0; char b;
  while (n + 1 < size && read_byte(c, &b)) { if (b == '\n') { line[n] = 0; return 1; } line[n++] = b; }
  return 0;
}
static int request(Channel c, const char *line) {
  char response[16]; return send_bytes(c, line) && read_line(c, response, sizeof(response)) && strcmp(response, "ok") == 0;
}

/* Native peers attest the actual child exit; gate peers attest their own body. */
static void serve(Channel c) {
  unsigned long peer = peer_pid(c); char line[192], token[80], verb[16], trailing;
  unsigned long number; int local_gate = 0;
  while (read_line(c, line, sizeof(line))) {
    number = 0;
    int fields = sscanf(line, "%15s %79s %lu %c", verb, token, &number, &trailing);
    int ok = 0;
    LOCK();
    if (peer && fields >= 2 && strcmp(token, nonce) == 0) {
      if (strcmp(verb, "START") == 0 && state.root) state.invalid = 1;
      if (strcmp(verb, "START") == 0 && fields == 3 && number && !state.root && !state.invalid) {
        state.root = number; state.launcher = peer; ok = 1;
      } else if (strcmp(verb, "EXIT") == 0 && fields == 3 && peer == state.launcher && !state.exited && number <= 255) {
        state.node_exit = (int)number; state.exited = 1; ok = 1;
      } else if (strcmp(verb, "ENTER") == 0 && fields == 2 && peer == state.root && !state.entered && !state.exited) {
        state.entered = 1; state.gate = c; local_gate = 1; ok = 1;
      } else if (strcmp(verb, "COMPLETE") == 0 && fields == 3 && peer == state.root && local_gate && state.gate == c && state.completed == -1 && !state.exited && (number == 0 || number == 2)) {
        state.completed = (int)number; ok = 1;
      }
      /* Foreign fork/Worker clients cannot poison a healthy parent run. */
      if (!ok && (peer == state.root || peer == state.launcher)) state.invalid = 1;
    }
    UNLOCK();
    if (!send_bytes(c, ok ? "ok\n" : "error\n") || !ok) break;
  }
  LOCK();
  if (local_gate && state.completed == -1) state.invalid = 1;
  UNLOCK();
  close_channel(c);
}
#ifdef _WIN32
static DWORD WINAPI client_thread(void *arg) { serve((Channel)arg); return 0; }
static DWORD WINAPI accept_thread(void *arg) {
  (void)arg; wchar_t *name = wide(endpoint);
  SECURITY_ATTRIBUTES sa = {sizeof(sa), pipe_security, FALSE};
  for (;;) {
    Channel c = CreateNamedPipeW(name, PIPE_ACCESS_DUPLEX, PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 16, 512, 512, 0, &sa);
    if (c == BAD_CHANNEL) break;
    SetEvent(listener_ready);
    if (!ConnectNamedPipe(c, NULL) && GetLastError() != ERROR_PIPE_CONNECTED) { close_channel(c); continue; }
    LOCK(); int allowed = ++state.connections <= 16; UNLOCK();
    if (!allowed) { close_channel(c); continue; }
    HANDLE thread = CreateThread(NULL, 65536, client_thread, c, STACK_SIZE_PARAM_IS_A_RESERVATION, NULL);
    if (thread) CloseHandle(thread); else close_channel(c);
  }
  free(name); return 0;
}
static int start_server(void) {
  HANDLE token; DWORD size = 0; PTOKEN_USER user; LPWSTR sid = NULL;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return 0;
  GetTokenInformation(token, TokenUser, NULL, 0, &size); user = malloc(size);
  int ok = user && GetTokenInformation(token, TokenUser, user, size, &size) && ConvertSidToStringSidW(user->User.Sid, &sid);
  if (ok) {
    size_t n = wcslen(sid) + 32; wchar_t *dacl = calloc(n, sizeof(wchar_t));
    if (!dacl) ok = 0;
    else { swprintf(dacl, n, L"D:P(A;;GA;;;%ls)", sid); ok = ConvertStringSecurityDescriptorToSecurityDescriptorW(dacl, SDDL_REVISION_1, &pipe_security, NULL); free(dacl); }
  }
  if (sid) LocalFree(sid); free(user); CloseHandle(token);
  if (!ok) return 0;
  listener_ready = CreateEventW(NULL, TRUE, FALSE, NULL);
  HANDLE thread = CreateThread(NULL, 65536, accept_thread, NULL, STACK_SIZE_PARAM_IS_A_RESERVATION, NULL);
  if (!thread) return 0;
  CloseHandle(thread); return WaitForSingleObject(listener_ready, 1000) == WAIT_OBJECT_0;
}
static Channel connect_server(void) {
  wchar_t *name = wide(endpoint); Channel c = BAD_CHANNEL;
  if (!name) return c;
  for (int i = 0; i < 100; ++i) { c = CreateFileW(name, GENERIC_READ | GENERIC_WRITE, 0, NULL, OPEN_EXISTING, 0, NULL); if (c != BAD_CHANNEL) break; delay(); }
  free(name); return c;
}
/* CRT quoting preserves empty args, quotes and trailing backslashes. */
static wchar_t *command_line(int count, char **args) {
  size_t size = 1; for (int i = 0; i < count; ++i) size += 2 * strlen(args[i]) + 4;
  wchar_t *line = calloc(size * 2, sizeof(wchar_t)); if (!line) return NULL;
  size_t p = 0;
  for (int i = 0; i < count; ++i) {
    wchar_t *arg = wide(args[i]); if (!arg) { free(line); return NULL; }
    if (i) line[p++] = L' '; line[p++] = L'"';
    size_t slashes = 0;
    for (size_t j = 0;; ++j) {
      wchar_t b = arg[j];
      if (b == L'\\') { slashes++; continue; }
      size_t n = (b == L'"' || !b) ? slashes * 2 : slashes;
      while (n--) line[p++] = L'\\'; slashes = 0;
      if (!b) break;
      if (b == L'"') line[p++] = L'\\'; line[p++] = b;
    }
    line[p++] = L'"'; free(arg);
  }
  return line;
}
static int create_child(wchar_t *executable, wchar_t *command, PROCESS_INFORMATION *process, int suspended) {
  STARTUPINFOW info; memset(&info, 0, sizeof(info)); info.cb = sizeof(info);
  info.dwFlags |= STARTF_USESTDHANDLES;
  info.hStdInput = GetStdHandle(STD_INPUT_HANDLE); info.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE); info.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  return CreateProcessW(executable, command, NULL, NULL, TRUE, (suspended ? CREATE_SUSPENDED : 0) | CREATE_NO_WINDOW, NULL, NULL, &info, process);
}
#else
static void *client_thread(void *arg) { serve((Channel)(intptr_t)arg); return NULL; }
static void *accept_thread(void *arg) {
  (void)arg;
  for (;;) {
    Channel c = accept(listener, NULL, NULL); if (c < 0) { if (errno == EINTR) continue; break; }
    fcntl(c, F_SETFD, FD_CLOEXEC);
    LOCK(); int allowed = ++state.connections <= 16; UNLOCK();
    if (!allowed) { close(c); continue; }
    pthread_t thread; pthread_attr_t attr; pthread_attr_init(&attr); pthread_attr_setstacksize(&attr, 65536);
    int result = pthread_create(&thread, &attr, client_thread, (void *)(intptr_t)c); pthread_attr_destroy(&attr);
    if (!result) pthread_detach(thread); else close(c);
  }
  return NULL;
}
static int start_server(void) {
  struct sockaddr_un address; memset(&address, 0, sizeof(address)); address.sun_family = AF_UNIX;
  if (strlen(endpoint) >= sizeof(address.sun_path)) return 0;
  strcpy(address.sun_path, endpoint); listener = socket(AF_UNIX, SOCK_STREAM, 0); if (listener < 0) return 0;
  fcntl(listener, F_SETFD, FD_CLOEXEC);
  if (bind(listener, (struct sockaddr *)&address, sizeof(address)) || chmod(endpoint, 0600) || listen(listener, 16)) return 0;
  pthread_t thread; if (pthread_create(&thread, NULL, accept_thread, NULL)) return 0; pthread_detach(thread); return 1;
}
static Channel connect_server(void) {
  struct sockaddr_un address; memset(&address, 0, sizeof(address)); address.sun_family = AF_UNIX;
  if (strlen(endpoint) >= sizeof(address.sun_path)) return BAD_CHANNEL;
  strcpy(address.sun_path, endpoint); Channel c = socket(AF_UNIX, SOCK_STREAM, 0); if (c < 0) return BAD_CHANNEL;
  fcntl(c, F_SETFD, FD_CLOEXEC);
  if (connect(c, (struct sockaddr *)&address, sizeof(address))) { close(c); return BAD_CHANNEL; } return c;
}
#endif

static int exec_node(int count, char **args) {
  const char *node = environment("CINDY_PRE_RUN_NODE"); if (!node || count < 1) return 125;
  Channel control = connect_server(); if (control == BAD_CHANNEL) return 125;
  char frame[192]; int code = 125;
#ifdef _WIN32
  char **all = calloc((size_t)count + 1, sizeof(char *)); if (!all) return 125;
  all[0] = (char *)node; for (int i = 0; i < count; ++i) all[i + 1] = args[i];
  wchar_t *exe = wide(node), *line = command_line(count + 1, all); PROCESS_INFORMATION process;
  if (!exe || !line || !create_child(exe, line, &process, 1)) return 125;
  free(all); free(exe); free(line);
  snprintf(frame, sizeof(frame), "START %s %lu\n", nonce, process.dwProcessId);
  if (!request(control, frame) || ResumeThread(process.hThread) == (DWORD)-1) { TerminateProcess(process.hProcess, 125); }
  WaitForSingleObject(process.hProcess, INFINITE); DWORD value = 125; GetExitCodeProcess(process.hProcess, &value);
  code = value <= 255 ? (int)value : 125; CloseHandle(process.hThread); CloseHandle(process.hProcess);
#else
  int barrier[2]; if (pipe(barrier)) return 125;
  pid_t child = fork(); if (child < 0) return 125;
  if (!child) {
    close(barrier[1]); char ok; if (!read_byte(barrier[0], &ok) || ok != '1') _exit(125); close(barrier[0]);
    char **all = calloc((size_t)count + 2, sizeof(char *)); if (!all) _exit(125);
    all[0] = (char *)node; for (int i = 0; i < count; ++i) all[i + 1] = args[i];
    execv(node, all); _exit(125);
  }
  close(barrier[0]); snprintf(frame, sizeof(frame), "START %s %lu\n", nonce, (unsigned long)child);
  if (request(control, frame)) { if (write(barrier[1], "1", 1) != 1) kill(child, SIGKILL); } else kill(child, SIGKILL);
  close(barrier[1]); int status = 0; while (waitpid(child, &status, 0) < 0) { if (errno != EINTR) return 125; }
  code = WIFEXITED(status) ? WEXITSTATUS(status) : 125;
#endif
  snprintf(frame, sizeof(frame), "EXIT %s %d\n", nonce, code);
  if (!request(control, frame)) code = 125;
  close_channel(control); return code;
}

static int supervise(const char *command, const char *parent) {
  if (!start_server()) return 125;
  int shell_exit = 125, stopped = 0;
#ifdef _WIN32
  HANDLE report_handle = (HANDLE)_get_osfhandle(3); if (report_handle == INVALID_HANDLE_VALUE || !SetHandleInformation(report_handle, HANDLE_FLAG_INHERIT, 0)) return 125;
  job = CreateJobObjectW(NULL, NULL); if (!job) return 125;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits; memset(&limits, 0, sizeof(limits)); limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) return 125;
  parent_handle = OpenProcess(SYNCHRONIZE, FALSE, (DWORD)strtoul(parent, NULL, 10)); if (!parent_handle) return 125;
  const char *shell = environment("COMSPEC"); if (!shell) shell = "C:\\Windows\\System32\\cmd.exe";
  wchar_t *exe = wide(shell), *body = wide(command); if (!exe || !body) return 125;
  size_t size = wcslen(exe) + wcslen(body) + 32; wchar_t *line = calloc(size, sizeof(wchar_t)); if (!line) return 125;
  swprintf(line, size, L"\"%ls\" /d /s /c \"%ls\"", exe, body); PROCESS_INFORMATION process;
  if (!create_child(exe, line, &process, 1)) return 125;
  free(exe); free(body); free(line);
  if (!AssignProcessToJobObject(job, process.hProcess) || ResumeThread(process.hThread) == (DWORD)-1) { TerminateProcess(process.hProcess, 125); return 125; }
  for (;;) {
    if (WaitForSingleObject(parent_handle, 0) == WAIT_OBJECT_0) { stopped = 1; break; }
    if (WaitForSingleObject(process.hProcess, 10) == WAIT_OBJECT_0) { DWORD value; GetExitCodeProcess(process.hProcess, &value); shell_exit = value <= 255 ? (int)value : 125; break; }
  }
  TerminateJobObject(job, 125); CloseHandle(process.hThread); CloseHandle(process.hProcess); CloseHandle(parent_handle);
#else
  signal(SIGTERM, on_signal); signal(SIGINT, on_signal); signal(SIGPIPE, SIG_IGN);
  fcntl(3, F_SETFD, FD_CLOEXEC); pid_t owner = (pid_t)strtoul(parent, NULL, 10);
  if (owner <= 1 || getppid() != owner) return 125;
  shell_pid = fork(); if (shell_pid < 0) return 125;
  if (!shell_pid) { setpgid(0, 0); execl("/bin/sh", "sh", "-c", command, (char *)NULL); _exit(125); }
  setpgid(shell_pid, shell_pid);
  for (;;) {
    if (cancelled || getppid() != owner) { stopped = 1; break; }
    int status = 0; pid_t done = waitpid(shell_pid, &status, WNOHANG);
    if (done == shell_pid) { shell_exit = WIFEXITED(status) ? WEXITSTATUS(status) : 125; break; }
    if (done < 0 && errno != EINTR) { stopped = 1; break; }
    delay();
  }
  /* Also reap ordinary background descendants on successful shell termination.
   * A user deliberately calling setsid escapes POSIX process-group containment. */
  kill(-shell_pid, SIGKILL);
  if (stopped) { int status; while (waitpid(shell_pid, &status, 0) < 0 && errno == EINTR) {} }
#endif
  LOCK();
  int valid = !stopped && !state.invalid && state.entered && state.exited && state.completed == state.node_exit && state.node_exit == shell_exit && (shell_exit == 0 || shell_exit == 2);
  char report[256]; snprintf(report, sizeof(report), "{\"version\":1,\"entered\":%s,\"completed\":%d,\"nodeExit\":%d,\"shellExit\":%d,\"valid\":%s}\n", state.entered ? "true" : "false", state.completed, state.node_exit, shell_exit, valid ? "true" : "false");
  UNLOCK();
#ifdef _WIN32
  DWORD written; if (!WriteFile((HANDLE)_get_osfhandle(3), report, (DWORD)strlen(report), &written, NULL) || written != strlen(report)) valid = 0;
  CloseHandle(job);
#else
  if (!send_bytes(3, report)) valid = 0;
  unlink(endpoint);
#endif
  return valid ? shell_exit : 125;
}

static int run(int argc, char **argv) {
  endpoint = environment("CINDY_PRE_RUN_GATE_ENDPOINT"); nonce = environment("CINDY_PRE_RUN_GATE_NONCE");
  if (!endpoint || !nonce || strlen(nonce) != 36 || argc < 3) return 125;
#ifdef _WIN32
  InitializeCriticalSection(&lock);
#else
  signal(SIGPIPE, SIG_IGN);
#endif
  if (strcmp(argv[1], "--node") == 0) return exec_node(argc - 2, argv + 2);
  if (strcmp(argv[1], "--supervise") == 0 && argc == 4) {
    int result = supervise(argv[2], argv[3]);
#ifndef _WIN32
    unlink(endpoint);
    char *directory = strdup(endpoint);
    if (directory) {
      char *last = strrchr(directory, '/');
      if (last) {
        *last = 0; char *base = strrchr(directory, '/'); base = base ? base + 1 : directory;
        if (strncmp(base, "cindy-pre-run-node-", 19) == 0 || strncmp(base, "cindy-pre-run-socket-", 21) == 0) rmdir(directory);
      }
      free(directory);
    }
#endif
    return result;
  }
  return 125;
}
#ifdef _WIN32
int wmain(int argc, wchar_t **wide_args) {
  char **args = calloc((size_t)argc, sizeof(char *)); if (!args) return 125;
  for (int i = 0; i < argc; ++i) { int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide_args[i], -1, NULL, 0, NULL, NULL); args[i] = size ? malloc((size_t)size) : NULL; if (!args[i]) return 125; WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide_args[i], -1, args[i], size, NULL, NULL); }
  return run(argc, args);
}
#else
int main(int argc, char **argv) { return run(argc, argv); }
#endif
