#ifndef BLE_SERVICE_H
#define BLE_SERVICE_H

#include <esp_err.h>
#include <stdbool.h>

#include "app_types.h"

typedef void (*ble_command_handler_t)(const device_command_t *command);
typedef void (*ble_connection_handler_t)(bool connected);

esp_err_t ble_service_init(ble_command_handler_t command_handler, ble_connection_handler_t connection_handler);
esp_err_t ble_service_start(void);
esp_err_t ble_service_notify_json(const char *json_payload);

#endif
