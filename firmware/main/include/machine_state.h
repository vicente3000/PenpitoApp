#ifndef MACHINE_STATE_H
#define MACHINE_STATE_H

#include <stdbool.h>
#include <esp_err.h>

#include "app_types.h"

typedef void (*machine_state_listener_t)(const machine_state_snapshot_t *snapshot);

void machine_state_init(void);
void machine_state_set_listener(machine_state_listener_t listener);
void machine_state_set_connected_client(bool connected);
void machine_state_refresh_sensors(void);
machine_state_snapshot_t machine_state_get_snapshot(void);
esp_err_t machine_state_power_on(void);
esp_err_t machine_state_power_off(void);
esp_err_t machine_state_begin_preparing(const char *recipe_id);
esp_err_t machine_state_begin_cleaning(void);
esp_err_t machine_state_complete_operation(void);
esp_err_t machine_state_set_progress(const char *recipe_id, uint8_t progress_pct, uint32_t remaining_sec);
void machine_state_set_error(const char *code, const char *message);
esp_err_t machine_state_ack_error(void);

#endif
