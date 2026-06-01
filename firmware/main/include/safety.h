#ifndef SAFETY_H
#define SAFETY_H

#include <stdbool.h>
#include <esp_err.h>

#include "app_types.h"

esp_err_t safety_validate_prepare(const machine_state_snapshot_t *state);
esp_err_t safety_validate_power_off(const machine_state_snapshot_t *state);
esp_err_t safety_validate_cleaning(const machine_state_snapshot_t *state);
bool safety_is_error_latched(const machine_state_snapshot_t *state);

#endif
