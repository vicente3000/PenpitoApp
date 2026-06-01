#include "app_controller.h"

#include <cJSON.h>
#include <esp_log.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/task.h>
#include <string.h>

#include "ble_service.h"
#include "machine_state.h"
#include "recipe_engine.h"
#include "recipes.h"
#include "safety.h"
#include "settings.h"
#include "stats.h"
#include "storage_nvs.h"

static const char *TAG = "app_controller";
static QueueHandle_t s_command_queue;
static app_settings_t s_settings;
static system_stats_t s_stats;
static int64_t s_boot_time_us;

static void send_json(cJSON *json)
{
    char *payload = cJSON_PrintUnformatted(json);
    if (payload != NULL) {
        ble_service_notify_json(payload);
        cJSON_free(payload);
    }
    cJSON_Delete(json);
}

static void publish_status_snapshot(const machine_state_snapshot_t *snapshot)
{
    cJSON *json = cJSON_CreateObject();
    cJSON_AddStringToObject(json, "event", "status_snapshot");
    cJSON_AddNumberToObject(json, "schemaVersion", APP_SCHEMA_VERSION);
    cJSON_AddStringToObject(json, "power", power_state_to_string(snapshot->power));
    cJSON_AddStringToObject(json, "mode", machine_mode_to_string(snapshot->mode));
    cJSON_AddBoolToObject(json, "connectedClient", snapshot->connected_client);
    cJSON_AddBoolToObject(json, "cupPresent", snapshot->cup_present);
    cJSON_AddBoolToObject(json, "lidClosed", snapshot->lid_closed);
    cJSON_AddStringToObject(json, "currentRecipe", snapshot->current_recipe);
    cJSON_AddNumberToObject(json, "progressPct", snapshot->progress_pct);
    cJSON_AddNumberToObject(json, "estimatedRemainingSec", snapshot->estimated_remaining_sec);
    cJSON_AddStringToObject(json, "lastError", snapshot->last_error);
    send_json(json);
}

static void state_listener(const machine_state_snapshot_t *snapshot)
{
    publish_status_snapshot(snapshot);
}

static void recipe_progress_listener(const preparation_progress_t *progress)
{
    cJSON *json = cJSON_CreateObject();
    cJSON_AddStringToObject(json, "event", "progress_update");
    cJSON_AddNumberToObject(json, "schemaVersion", progress->schema_version);
    cJSON_AddStringToObject(json, "recipeId", progress->recipe_id);
    cJSON_AddStringToObject(json, "recipeName", progress->recipe_name);
    cJSON_AddNumberToObject(json, "progressPct", progress->progress_pct);
    cJSON_AddNumberToObject(json, "estimatedRemainingSec", progress->estimated_remaining_sec);
    send_json(json);
}

static void recipe_event_listener(const char *event_name, const char *recipe_id, const char *recipe_name)
{
    cJSON *json = cJSON_CreateObject();
    cJSON_AddStringToObject(json, "event", event_name);
    cJSON_AddNumberToObject(json, "schemaVersion", APP_SCHEMA_VERSION);
    cJSON_AddStringToObject(json, "recipeId", recipe_id);
    cJSON_AddStringToObject(json, "recipeName", recipe_name);
    send_json(json);
}

static void recipe_error_listener(const device_error_t *error)
{
    s_stats.error_count += 1;
    storage_nvs_save_last_error(error->message);
    storage_nvs_save_stats(&s_stats);

    cJSON *json = cJSON_CreateObject();
    cJSON_AddStringToObject(json, "event", "error_event");
    cJSON_AddNumberToObject(json, "schemaVersion", error->schema_version);
    cJSON_AddStringToObject(json, "code", error->code);
    cJSON_AddStringToObject(json, "message", error->message);
    send_json(json);
}

static void publish_system_info(void)
{
    system_info_t info = {
        .schema_version = APP_SCHEMA_VERSION,
        .uptime_sec = (uint64_t)((esp_timer_get_time() - s_boot_time_us) / 1000000ULL),
        .drink_count = s_stats.drink_count,
        .clean_cycle_count = s_stats.clean_cycle_count,
    };

    strncpy(info.firmware_version, APP_FIRMWARE_VERSION, sizeof(info.firmware_version) - 1);
    strncpy(info.last_reset_reason, s_stats.last_reset_reason, sizeof(info.last_reset_reason) - 1);

    cJSON *json = cJSON_CreateObject();
    cJSON_AddStringToObject(json, "event", "system_info");
    cJSON_AddNumberToObject(json, "schemaVersion", info.schema_version);
    cJSON_AddStringToObject(json, "firmwareVersion", info.firmware_version);
    cJSON_AddNumberToObject(json, "uptimeSec", (double)info.uptime_sec);
    cJSON_AddNumberToObject(json, "drinkCount", info.drink_count);
    cJSON_AddNumberToObject(json, "cleanCycleCount", info.clean_cycle_count);
    cJSON_AddStringToObject(json, "lastResetReason", info.last_reset_reason);
    send_json(json);
}

static void publish_recipe_catalog(void)
{
    size_t count = 0;
    const recipe_t *recipes = recipes_get_all(&count);

    cJSON *json = cJSON_CreateObject();
    cJSON *items = cJSON_AddArrayToObject(json, "recipes");
    cJSON_AddStringToObject(json, "event", "recipe_catalog");
    cJSON_AddNumberToObject(json, "schemaVersion", APP_SCHEMA_VERSION);

    for (size_t i = 0; i < count; ++i) {
        cJSON *recipe_json = cJSON_CreateObject();
        cJSON_AddStringToObject(recipe_json, "id", recipes[i].id);
        cJSON_AddStringToObject(recipe_json, "name", recipes[i].name);
        cJSON_AddNumberToObject(recipe_json, "stirTimeMs", recipes[i].stir_time_ms);
        cJSON_AddNumberToObject(recipe_json, "iceLevel", recipes[i].ice_level);

        cJSON *ingredients = cJSON_AddArrayToObject(recipe_json, "ingredients");
        for (size_t j = 0; j < recipes[i].ingredient_count; ++j) {
            cJSON *ingredient_json = cJSON_CreateObject();
            cJSON_AddStringToObject(ingredient_json, "name", recipes[i].ingredients[j].ingredient);
            cJSON_AddNumberToObject(ingredient_json, "channel", recipes[i].ingredients[j].channel);
            cJSON_AddNumberToObject(ingredient_json, "amountMl", recipes[i].ingredients[j].amount_ml);
            cJSON_AddItemToArray(ingredients, ingredient_json);
        }

        cJSON_AddItemToArray(items, recipe_json);
    }

    send_json(json);
}

static void publish_settings_applied(void)
{
    cJSON *json = cJSON_CreateObject();
    cJSON *settings_json = cJSON_AddObjectToObject(json, "settings");
    cJSON *capacities = cJSON_AddArrayToObject(settings_json, "bottleCapacities");
    cJSON *pump_rates = cJSON_AddArrayToObject(settings_json, "pumpRates");

    cJSON_AddStringToObject(json, "event", "settings_applied");
    cJSON_AddNumberToObject(json, "schemaVersion", APP_SCHEMA_VERSION);
    cJSON_AddNumberToObject(settings_json, "iceLevel", s_settings.ice_level);
    cJSON_AddBoolToObject(settings_json, "autoClean", s_settings.auto_clean);

    for (size_t i = 0; i < APP_MAX_PUMPS; ++i) {
        cJSON_AddItemToArray(capacities, cJSON_CreateNumber(s_settings.bottle_capacities_ml[i]));
        cJSON_AddItemToArray(pump_rates, cJSON_CreateNumber(s_settings.pump_rates_ml_per_sec[i]));
    }

    send_json(json);
}

static void notify_error(const char *code, const char *message)
{
    device_error_t error = {
        .schema_version = APP_SCHEMA_VERSION,
    };

    strncpy(error.code, code, sizeof(error.code) - 1);
    strncpy(error.message, message, sizeof(error.message) - 1);
    recipe_error_listener(&error);
}

static void handle_prepare(const device_command_t *command)
{
    machine_state_refresh_sensors();
    machine_state_snapshot_t snapshot = machine_state_get_snapshot();

    if (safety_validate_prepare(&snapshot) != ESP_OK) {
        notify_error("invalid_state", "Machine is not ready to prepare");
        return;
    }

    const recipe_t *recipe = recipes_find_by_id(command->recipe_id);
    if (recipe == NULL) {
        notify_error("unknown_recipe", "Requested recipe was not found");
        return;
    }

    if (machine_state_begin_preparing(recipe->id) != ESP_OK) {
        notify_error("busy", "Machine is currently busy");
        return;
    }

    if (recipe_engine_prepare(recipe, &s_settings, &s_stats) == ESP_OK) {
        bool keep_idle = true;
        storage_nvs_save_stats(&s_stats);

        if (s_settings.auto_clean) {
            keep_idle = false;
            if (machine_state_complete_operation() == ESP_OK &&
                machine_state_begin_cleaning() == ESP_OK &&
                recipe_engine_clean(&s_settings, &s_stats) == ESP_OK) {
                storage_nvs_save_stats(&s_stats);
                keep_idle = true;
            }
        }

        if (keep_idle) {
            machine_state_complete_operation();
        }
    }
}

static void handle_cleaning(void)
{
    machine_state_refresh_sensors();
    machine_state_snapshot_t snapshot = machine_state_get_snapshot();

    if (safety_validate_cleaning(&snapshot) != ESP_OK) {
        notify_error("invalid_state", "Machine is not ready to clean");
        return;
    }

    if (machine_state_begin_cleaning() != ESP_OK) {
        notify_error("busy", "Machine is currently busy");
        return;
    }

    if (recipe_engine_clean(&s_settings, &s_stats) == ESP_OK) {
        storage_nvs_save_stats(&s_stats);
        machine_state_complete_operation();
    }
}

static void apply_settings(const device_command_t *command)
{
    app_settings_t next = s_settings;

    for (size_t i = 0; i < APP_MAX_PUMPS; ++i) {
        if (command->settings.bottle_capacities_ml[i] > 0.0f) {
            next.bottle_capacities_ml[i] = command->settings.bottle_capacities_ml[i];
        }
        if (command->settings.pump_rates_ml_per_sec[i] > 0.0f) {
            next.pump_rates_ml_per_sec[i] = command->settings.pump_rates_ml_per_sec[i];
        }
    }

    if (command->settings.ice_level > 0) {
        next.ice_level = command->settings.ice_level;
    }

    next.auto_clean = command->settings.auto_clean;
    settings_sanitize(&next);
    s_settings = next;
    storage_nvs_save_settings(&s_settings);
    publish_settings_applied();
}

static void process_command(const device_command_t *command)
{
    ESP_LOGI(TAG, "Processing command: %s", command_type_to_string(command->type));

    switch (command->type) {
    case COMMAND_POWER_ON:
        if (machine_state_power_on() != ESP_OK) {
            notify_error("invalid_state", "Power on rejected");
        }
        break;
    case COMMAND_POWER_OFF: {
        machine_state_snapshot_t snapshot = machine_state_get_snapshot();
        if (safety_validate_power_off(&snapshot) != ESP_OK || machine_state_power_off() != ESP_OK) {
            notify_error("invalid_state", "Power off rejected");
        }
        break;
    }
    case COMMAND_GET_STATUS:
    {
        machine_state_snapshot_t snapshot = machine_state_get_snapshot();
        publish_status_snapshot(&snapshot);
        break;
    }
    case COMMAND_GET_SYSTEM_INFO:
        publish_system_info();
        break;
    case COMMAND_LIST_RECIPES:
        publish_recipe_catalog();
        break;
    case COMMAND_PREPARE_DRINK:
        handle_prepare(command);
        break;
    case COMMAND_UPDATE_SETTINGS:
        apply_settings(command);
        break;
    case COMMAND_START_CLEANING:
        handle_cleaning();
        break;
    case COMMAND_ACK_ERROR:
        if (machine_state_ack_error() != ESP_OK) {
            notify_error("invalid_state", "No latched error to acknowledge");
        } else {
            storage_nvs_save_last_error("");
        }
        break;
    default:
        notify_error("unsupported_command", "Command not supported");
        break;
    }
}

static void command_task(void *arg)
{
    (void)arg;

    device_command_t command;
    while (true) {
        if (xQueueReceive(s_command_queue, &command, portMAX_DELAY) == pdTRUE) {
            process_command(&command);
        }
    }
}

static void ble_command_handler(const device_command_t *command)
{
    if (command == NULL) {
        return;
    }

    xQueueSend(s_command_queue, command, 0);
}

static void ble_connection_handler(bool connected)
{
    machine_state_set_connected_client(connected);
    if (connected) {
        machine_state_snapshot_t snapshot = machine_state_get_snapshot();
        publish_status_snapshot(&snapshot);
        publish_system_info();
    }
}

static void load_persistent_state(void)
{
    settings_load_defaults(&s_settings);
    stats_load_defaults(&s_stats);

    if (storage_nvs_load_settings(&s_settings) != ESP_OK) {
        storage_nvs_save_settings(&s_settings);
    }
    settings_sanitize(&s_settings);

    if (storage_nvs_load_stats(&s_stats) != ESP_OK) {
        storage_nvs_save_stats(&s_stats);
    }

    char last_error[APP_MAX_ERROR_LEN] = { 0 };
    if (storage_nvs_load_last_error(last_error, sizeof(last_error)) == ESP_OK && last_error[0] != '\0') {
        machine_state_set_error("persisted_error", last_error);
    }
}

esp_err_t app_controller_init(void)
{
    s_command_queue = xQueueCreate(8, sizeof(device_command_t));
    if (s_command_queue == NULL) {
        return ESP_ERR_NO_MEM;
    }

    s_boot_time_us = esp_timer_get_time();
    load_persistent_state();

    machine_state_set_listener(state_listener);
    recipe_engine_init(recipe_progress_listener, recipe_event_listener, recipe_error_listener);

    ESP_ERROR_CHECK(ble_service_init(ble_command_handler, ble_connection_handler));
    return ESP_OK;
}

void app_controller_start(void)
{
    xTaskCreate(command_task, "command_task", 6144, NULL, 5, NULL);
    ble_service_start();
}
