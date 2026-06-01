#include "storage_nvs.h"

#include <nvs.h>
#include <nvs_flash.h>
#include <string.h>

#define STORAGE_NAMESPACE "cocktail"
#define KEY_SETTINGS "settings"
#define KEY_STATS "stats"
#define KEY_LAST_ERROR "last_error"

esp_err_t storage_nvs_init(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }

    return err;
}

static esp_err_t storage_open(nvs_handle_t *handle)
{
    return nvs_open(STORAGE_NAMESPACE, NVS_READWRITE, handle);
}

esp_err_t storage_nvs_load_settings(app_settings_t *settings)
{
    nvs_handle_t handle;
    esp_err_t err = storage_open(&handle);
    if (err != ESP_OK) {
        return err;
    }

    size_t required_size = sizeof(*settings);
    err = nvs_get_blob(handle, KEY_SETTINGS, settings, &required_size);
    nvs_close(handle);
    return err;
}

esp_err_t storage_nvs_save_settings(const app_settings_t *settings)
{
    nvs_handle_t handle;
    esp_err_t err = storage_open(&handle);
    if (err != ESP_OK) {
        return err;
    }

    err = nvs_set_blob(handle, KEY_SETTINGS, settings, sizeof(*settings));
    if (err == ESP_OK) {
        err = nvs_commit(handle);
    }

    nvs_close(handle);
    return err;
}

esp_err_t storage_nvs_load_stats(system_stats_t *stats)
{
    nvs_handle_t handle;
    esp_err_t err = storage_open(&handle);
    if (err != ESP_OK) {
        return err;
    }

    size_t required_size = sizeof(*stats);
    err = nvs_get_blob(handle, KEY_STATS, stats, &required_size);
    nvs_close(handle);
    return err;
}

esp_err_t storage_nvs_save_stats(const system_stats_t *stats)
{
    nvs_handle_t handle;
    esp_err_t err = storage_open(&handle);
    if (err != ESP_OK) {
        return err;
    }

    err = nvs_set_blob(handle, KEY_STATS, stats, sizeof(*stats));
    if (err == ESP_OK) {
        err = nvs_commit(handle);
    }

    nvs_close(handle);
    return err;
}

esp_err_t storage_nvs_save_last_error(const char *last_error)
{
    nvs_handle_t handle;
    esp_err_t err = storage_open(&handle);
    if (err != ESP_OK) {
        return err;
    }

    err = nvs_set_str(handle, KEY_LAST_ERROR, last_error);
    if (err == ESP_OK) {
        err = nvs_commit(handle);
    }

    nvs_close(handle);
    return err;
}

esp_err_t storage_nvs_load_last_error(char *last_error, size_t buffer_len)
{
    nvs_handle_t handle;
    esp_err_t err = storage_open(&handle);
    if (err != ESP_OK) {
        return err;
    }

    size_t required_size = buffer_len;
    err = nvs_get_str(handle, KEY_LAST_ERROR, last_error, &required_size);
    nvs_close(handle);
    return err;
}
