#ifndef APP_TYPES_H
#define APP_TYPES_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define APP_SCHEMA_VERSION 1
#define APP_MAX_PUMPS 4
#define APP_MAX_RECIPES 4
#define APP_MAX_RECIPE_INGREDIENTS 4
#define APP_MAX_NAME_LEN 32
#define APP_MAX_ERROR_LEN 96
#define APP_MAX_JSON_LEN 768
#define APP_FIRMWARE_VERSION "1.0.0"

typedef enum {
    MACHINE_MODE_OFF = 0,
    MACHINE_MODE_IDLE,
    MACHINE_MODE_PREPARING,
    MACHINE_MODE_CLEANING,
    MACHINE_MODE_ERROR
} machine_mode_t;

typedef enum {
    POWER_STATE_OFF = 0,
    POWER_STATE_ON
} power_state_t;

typedef enum {
    COMMAND_POWER_ON = 0,
    COMMAND_POWER_OFF,
    COMMAND_GET_STATUS,
    COMMAND_GET_SYSTEM_INFO,
    COMMAND_LIST_RECIPES,
    COMMAND_PREPARE_DRINK,
    COMMAND_UPDATE_SETTINGS,
    COMMAND_START_CLEANING,
    COMMAND_ACK_ERROR,
    COMMAND_UNKNOWN
} command_type_t;

typedef struct {
    float bottle_capacities_ml[APP_MAX_PUMPS];
    float pump_rates_ml_per_sec[APP_MAX_PUMPS];
    uint8_t ice_level;
    bool auto_clean;
} app_settings_t;

typedef struct {
    uint32_t drink_count;
    uint32_t clean_cycle_count;
    uint32_t error_count;
    uint64_t uptime_sec;
    char last_reset_reason[APP_MAX_NAME_LEN];
} system_stats_t;

typedef struct {
    power_state_t power;
    machine_mode_t mode;
    bool connected_client;
    bool cup_present;
    bool lid_closed;
    char current_recipe[APP_MAX_NAME_LEN];
    uint8_t progress_pct;
    uint32_t estimated_remaining_sec;
    char last_error[APP_MAX_ERROR_LEN];
} machine_state_snapshot_t;

typedef struct {
    uint8_t channel;
    char ingredient[APP_MAX_NAME_LEN];
    float amount_ml;
} recipe_ingredient_t;

typedef struct {
    char id[APP_MAX_NAME_LEN];
    char name[APP_MAX_NAME_LEN];
    recipe_ingredient_t ingredients[APP_MAX_RECIPE_INGREDIENTS];
    size_t ingredient_count;
    uint16_t stir_time_ms;
    uint8_t ice_level;
} recipe_t;

typedef struct {
    uint8_t schema_version;
    command_type_t type;
    char recipe_id[APP_MAX_NAME_LEN];
    app_settings_t settings;
} device_command_t;

typedef struct {
    uint8_t schema_version;
    char recipe_id[APP_MAX_NAME_LEN];
    char recipe_name[APP_MAX_NAME_LEN];
    uint8_t progress_pct;
    uint32_t estimated_remaining_sec;
} preparation_progress_t;

typedef struct {
    uint8_t schema_version;
    char code[APP_MAX_NAME_LEN];
    char message[APP_MAX_ERROR_LEN];
} device_error_t;

typedef struct {
    uint8_t schema_version;
    char firmware_version[APP_MAX_NAME_LEN];
    uint64_t uptime_sec;
    uint32_t drink_count;
    uint32_t clean_cycle_count;
    char last_reset_reason[APP_MAX_NAME_LEN];
} system_info_t;

const char *machine_mode_to_string(machine_mode_t mode);
const char *power_state_to_string(power_state_t power);
const char *command_type_to_string(command_type_t command);

#endif
