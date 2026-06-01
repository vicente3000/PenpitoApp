#ifndef RECIPE_ENGINE_H
#define RECIPE_ENGINE_H

#include <esp_err.h>

#include "app_types.h"

typedef void (*recipe_progress_callback_t)(const preparation_progress_t *progress);
typedef void (*recipe_event_callback_t)(const char *event_name, const char *recipe_id, const char *recipe_name);
typedef void (*recipe_error_callback_t)(const device_error_t *error);

void recipe_engine_init(recipe_progress_callback_t progress_cb,
                        recipe_event_callback_t event_cb,
                        recipe_error_callback_t error_cb);
esp_err_t recipe_engine_prepare(const recipe_t *recipe, const app_settings_t *settings, system_stats_t *stats);
esp_err_t recipe_engine_clean(const app_settings_t *settings, system_stats_t *stats);

#endif
