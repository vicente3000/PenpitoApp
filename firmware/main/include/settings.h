#ifndef SETTINGS_H
#define SETTINGS_H

#include "app_types.h"

void settings_load_defaults(app_settings_t *settings);
void settings_sanitize(app_settings_t *settings);

#endif
