#ifndef STORAGE_NVS_H
#define STORAGE_NVS_H

#include <esp_err.h>

#include "app_types.h"

esp_err_t storage_nvs_init(void);
esp_err_t storage_nvs_load_settings(app_settings_t *settings);
esp_err_t storage_nvs_save_settings(const app_settings_t *settings);
esp_err_t storage_nvs_load_stats(system_stats_t *stats);
esp_err_t storage_nvs_save_stats(const system_stats_t *stats);
esp_err_t storage_nvs_save_last_error(const char *last_error);
esp_err_t storage_nvs_load_last_error(char *last_error, size_t buffer_len);

#endif
