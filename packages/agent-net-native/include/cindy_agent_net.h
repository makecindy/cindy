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
char *cindy_agent_net_notification_open(const uint8_t *input, size_t length);
#ifdef __cplusplus
}
#endif
#endif
