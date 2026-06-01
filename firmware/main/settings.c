#include "settings.h"

#include <string.h>

void settings_load_defaults(app_settings_t *settings)
{
    memset(settings, 0, sizeof(*settings));

    settings->bottle_capacities_ml[0] = 1000.0f;
    settings->bottle_capacities_ml[1] = 1000.0f;
    settings->bottle_capacities_ml[2] = 1000.0f;
    settings->bottle_capacities_ml[3] = 1000.0f;

    settings->pump_rates_ml_per_sec[0] = 25.0f;
    settings->pump_rates_ml_per_sec[1] = 25.0f;
    settings->pump_rates_ml_per_sec[2] = 25.0f;
    settings->pump_rates_ml_per_sec[3] = 25.0f;

    settings->ice_level = 2;
    settings->auto_clean = false;
}

void settings_sanitize(app_settings_t *settings)
{
    for (size_t i = 0; i < APP_MAX_PUMPS; ++i) {
        if (settings->bottle_capacities_ml[i] < 100.0f) {
            settings->bottle_capacities_ml[i] = 100.0f;
        }

        if (settings->bottle_capacities_ml[i] > 2000.0f) {
            settings->bottle_capacities_ml[i] = 2000.0f;
        }

        if (settings->pump_rates_ml_per_sec[i] < 5.0f) {
            settings->pump_rates_ml_per_sec[i] = 5.0f;
        }

        if (settings->pump_rates_ml_per_sec[i] > 80.0f) {
            settings->pump_rates_ml_per_sec[i] = 80.0f;
        }
    }

    if (settings->ice_level > 3) {
        settings->ice_level = 3;
    }
}
