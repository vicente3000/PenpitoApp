#include <esp_err.h>
#include <esp_log.h>

#include "actuators.h"
#include "app_controller.h"
#include "machine_state.h"
#include "sensors.h"
#include "storage_nvs.h"

static const char *TAG = "app_main";

void app_main(void)
{
    ESP_LOGI(TAG, "Starting Penpito coctelera firmware");

    ESP_ERROR_CHECK(storage_nvs_init());
    ESP_ERROR_CHECK(sensors_init());
    ESP_ERROR_CHECK(actuators_init());

    machine_state_init();
    ESP_ERROR_CHECK(app_controller_init());
    app_controller_start();

    ESP_LOGI(TAG, "Firmware ready");
}
