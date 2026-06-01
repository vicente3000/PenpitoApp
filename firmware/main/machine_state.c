#include "machine_state.h"

#include <stdio.h>
#include <string.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>

#include "sensors.h"

static machine_state_snapshot_t s_state;
static SemaphoreHandle_t s_mutex;
static machine_state_listener_t s_listener;

const char *machine_mode_to_string(machine_mode_t mode)
{
    switch (mode) {
    case MACHINE_MODE_OFF:
        return "OFF";
    case MACHINE_MODE_IDLE:
        return "IDLE";
    case MACHINE_MODE_PREPARING:
        return "PREPARING";
    case MACHINE_MODE_CLEANING:
        return "CLEANING";
    case MACHINE_MODE_ERROR:
        return "ERROR";
    default:
        return "UNKNOWN";
    }
}

const char *power_state_to_string(power_state_t power)
{
    return power == POWER_STATE_ON ? "ON" : "OFF";
}

const char *command_type_to_string(command_type_t command)
{
    switch (command) {
    case COMMAND_POWER_ON:
        return "power_on";
    case COMMAND_POWER_OFF:
        return "power_off";
    case COMMAND_GET_STATUS:
        return "get_status";
    case COMMAND_GET_SYSTEM_INFO:
        return "get_system_info";
    case COMMAND_LIST_RECIPES:
        return "list_recipes";
    case COMMAND_PREPARE_DRINK:
        return "prepare_drink";
    case COMMAND_UPDATE_SETTINGS:
        return "update_settings";
    case COMMAND_START_CLEANING:
        return "start_cleaning";
    case COMMAND_ACK_ERROR:
        return "ack_error";
    default:
        return "unknown";
    }
}

static void machine_state_publish(void)
{
    if (s_listener == NULL) {
        return;
    }

    machine_state_snapshot_t snapshot;
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    snapshot = s_state;
    xSemaphoreGive(s_mutex);
    s_listener(&snapshot);
}

void machine_state_init(void)
{
    s_mutex = xSemaphoreCreateMutex();
    memset(&s_state, 0, sizeof(s_state));
    s_state.power = POWER_STATE_OFF;
    s_state.mode = MACHINE_MODE_OFF;
    machine_state_refresh_sensors();
}

void machine_state_set_listener(machine_state_listener_t listener)
{
    s_listener = listener;
}

void machine_state_set_connected_client(bool connected)
{
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    s_state.connected_client = connected;
    xSemaphoreGive(s_mutex);
    machine_state_publish();
}

void machine_state_refresh_sensors(void)
{
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    s_state.cup_present = sensors_is_cup_present();
    s_state.lid_closed = sensors_is_lid_closed();
    xSemaphoreGive(s_mutex);
}

machine_state_snapshot_t machine_state_get_snapshot(void)
{
    machine_state_snapshot_t snapshot;
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    snapshot = s_state;
    xSemaphoreGive(s_mutex);
    return snapshot;
}

esp_err_t machine_state_power_on(void)
{
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    if (s_state.mode != MACHINE_MODE_OFF) {
        xSemaphoreGive(s_mutex);
        return ESP_ERR_INVALID_STATE;
    }

    s_state.power = POWER_STATE_ON;
    s_state.mode = MACHINE_MODE_IDLE;
    s_state.progress_pct = 0;
    s_state.estimated_remaining_sec = 0;
    xSemaphoreGive(s_mutex);
    machine_state_publish();
    return ESP_OK;
}

esp_err_t machine_state_power_off(void)
{
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    if (s_state.mode != MACHINE_MODE_IDLE) {
        xSemaphoreGive(s_mutex);
        return ESP_ERR_INVALID_STATE;
    }

    s_state.power = POWER_STATE_OFF;
    s_state.mode = MACHINE_MODE_OFF;
    s_state.current_recipe[0] = '\0';
    s_state.progress_pct = 0;
    s_state.estimated_remaining_sec = 0;
    xSemaphoreGive(s_mutex);
    machine_state_publish();
    return ESP_OK;
}

esp_err_t machine_state_begin_preparing(const char *recipe_id)
{
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    if (s_state.power != POWER_STATE_ON || s_state.mode != MACHINE_MODE_IDLE) {
        xSemaphoreGive(s_mutex);
        return ESP_ERR_INVALID_STATE;
    }

    s_state.mode = MACHINE_MODE_PREPARING;
    strncpy(s_state.current_recipe, recipe_id, sizeof(s_state.current_recipe) - 1);
    s_state.current_recipe[sizeof(s_state.current_recipe) - 1] = '\0';
    s_state.progress_pct = 0;
    xSemaphoreGive(s_mutex);
    machine_state_publish();
    return ESP_OK;
}

esp_err_t machine_state_begin_cleaning(void)
{
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    if (s_state.power != POWER_STATE_ON || s_state.mode != MACHINE_MODE_IDLE) {
        xSemaphoreGive(s_mutex);
        return ESP_ERR_INVALID_STATE;
    }

    s_state.mode = MACHINE_MODE_CLEANING;
    strncpy(s_state.current_recipe, "clean_cycle", sizeof(s_state.current_recipe) - 1);
    s_state.progress_pct = 0;
    xSemaphoreGive(s_mutex);
    machine_state_publish();
    return ESP_OK;
}

esp_err_t machine_state_complete_operation(void)
{
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    if (s_state.power != POWER_STATE_ON) {
        xSemaphoreGive(s_mutex);
        return ESP_ERR_INVALID_STATE;
    }

    s_state.mode = MACHINE_MODE_IDLE;
    s_state.current_recipe[0] = '\0';
    s_state.progress_pct = 0;
    s_state.estimated_remaining_sec = 0;
    xSemaphoreGive(s_mutex);
    machine_state_publish();
    return ESP_OK;
}

esp_err_t machine_state_set_progress(const char *recipe_id, uint8_t progress_pct, uint32_t remaining_sec)
{
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    if (recipe_id != NULL && recipe_id[0] != '\0') {
        strncpy(s_state.current_recipe, recipe_id, sizeof(s_state.current_recipe) - 1);
        s_state.current_recipe[sizeof(s_state.current_recipe) - 1] = '\0';
    }

    s_state.progress_pct = progress_pct;
    s_state.estimated_remaining_sec = remaining_sec;
    xSemaphoreGive(s_mutex);
    machine_state_publish();
    return ESP_OK;
}

void machine_state_set_error(const char *code, const char *message)
{
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    s_state.mode = MACHINE_MODE_ERROR;
    snprintf(s_state.last_error, sizeof(s_state.last_error), "%s:%s", code, message);
    xSemaphoreGive(s_mutex);
    machine_state_publish();
}

esp_err_t machine_state_ack_error(void)
{
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    if (s_state.mode != MACHINE_MODE_ERROR) {
        xSemaphoreGive(s_mutex);
        return ESP_ERR_INVALID_STATE;
    }

    s_state.last_error[0] = '\0';
    s_state.progress_pct = 0;
    s_state.estimated_remaining_sec = 0;
    s_state.current_recipe[0] = '\0';
    s_state.mode = (s_state.power == POWER_STATE_ON) ? MACHINE_MODE_IDLE : MACHINE_MODE_OFF;
    xSemaphoreGive(s_mutex);
    machine_state_publish();
    return ESP_OK;
}
