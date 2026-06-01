#include "safety.h"

#include <string.h>

esp_err_t safety_validate_prepare(const machine_state_snapshot_t *state)
{
    if (state->power != POWER_STATE_ON) {
        return ESP_ERR_INVALID_STATE;
    }

    if (state->mode != MACHINE_MODE_IDLE) {
        return ESP_ERR_INVALID_STATE;
    }

    if (!state->cup_present || !state->lid_closed) {
        return ESP_ERR_INVALID_STATE;
    }

    if (state->last_error[0] != '\0' && state->mode == MACHINE_MODE_ERROR) {
        return ESP_ERR_INVALID_STATE;
    }

    return ESP_OK;
}

esp_err_t safety_validate_power_off(const machine_state_snapshot_t *state)
{
    return state->mode == MACHINE_MODE_IDLE ? ESP_OK : ESP_ERR_INVALID_STATE;
}

esp_err_t safety_validate_cleaning(const machine_state_snapshot_t *state)
{
    if (state->power != POWER_STATE_ON) {
        return ESP_ERR_INVALID_STATE;
    }

    if (state->mode != MACHINE_MODE_IDLE) {
        return ESP_ERR_INVALID_STATE;
    }

    return ESP_OK;
}

bool safety_is_error_latched(const machine_state_snapshot_t *state)
{
    return state->mode == MACHINE_MODE_ERROR || strlen(state->last_error) > 0;
}
