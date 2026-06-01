#include "stats.h"

#include <string.h>

void stats_load_defaults(system_stats_t *stats)
{
    memset(stats, 0, sizeof(*stats));
    strncpy(stats->last_reset_reason, "power_on", sizeof(stats->last_reset_reason) - 1);
}
