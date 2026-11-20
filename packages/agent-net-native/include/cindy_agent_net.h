#ifndef CINDY_AGENT_NET_H
#define CINDY_AGENT_NET_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
typedef struct CindyAgentNetEngine CindyAgentNetEngine;
/* Serialize all operations on each handle; destroy only after pending calls finish. */
CindyAgentNetEngine *cindy_agent_net_create(const uint8_t *input, size_t length);
char *cindy_agent_net_command(CindyAgentNetEngine *handle, const uint8_t *input, size_t length);
void cindy_agent_net_free_string(char *value);
void cindy_agent_net_destroy(CindyAgentNetEngine *handle);
/* The engine's own turn, serialized with the handle like a command. Negative on failure; otherwise bit 0: the application
 * has something to read with the "poll" command; the other bits: milliseconds until the next call when nothing arrives. */
int64_t cindy_agent_net_pump(CindyAgentNetEngine *handle);
typedef struct CindyAgentNetWaiter CindyAgentNetWaiter;
/* Created like a command. Valid after the engine is destroyed; free once, after every wait on it has returned. */
CindyAgentNetWaiter *cindy_agent_net_waiter(CindyAgentNetEngine *handle);
/* Any thread, beside the handle's calls: 1 when a datagram is waiting on the engine's socket, 0 after timeout_ms. */
int32_t cindy_agent_net_wait(const CindyAgentNetWaiter *waiter, uint32_t timeout_ms);
void cindy_agent_net_waiter_free(CindyAgentNetWaiter *waiter);
char *cindy_agent_net_notification_open(const uint8_t *input, size_t length);
#ifdef __cplusplus
}
#endif
#endif
