/* 只给 compare 对比用。KCP 没有设置最小 RTO 和流模式的函数，官方 README 的做法是直接改结构体字段。 */
#include "ikcp.h"

void agent_net_kcp_tune(ikcpcb *kcp, int min_rto, int stream)
{
	if (min_rto > 0)
		kcp->rx_minrto = min_rto;
	kcp->stream = stream;
}
