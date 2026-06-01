#include "actuators.h"

#include <driver/gpio.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

#include "board_config.h"

static const gpio_num_t s_pump_gpios[] = {
    BOARD_PUMP_1_GPIO,
    BOARD_PUMP_2_GPIO,
    BOARD_PUMP_3_GPIO,
    BOARD_PUMP_4_GPIO,
};

static void actuator_set(gpio_num_t gpio_num, bool enabled)
{
    gpio_set_level(gpio_num, enabled ? BOARD_ACTUATOR_ACTIVE_LEVEL : !BOARD_ACTUATOR_ACTIVE_LEVEL);
}

static esp_err_t run_for_duration(gpio_num_t gpio_num, uint32_t duration_ms, uint32_t max_duration_ms)
{
    if (duration_ms == 0 || duration_ms > max_duration_ms) {
        return ESP_ERR_INVALID_ARG;
    }

    actuator_set(gpio_num, true);
    vTaskDelay(pdMS_TO_TICKS(duration_ms));
    actuator_set(gpio_num, false);
    return ESP_OK;
}

esp_err_t actuators_init(void)
{
    gpio_config_t config = {
        .pin_bit_mask = (1ULL << BOARD_PUMP_1_GPIO) |
                        (1ULL << BOARD_PUMP_2_GPIO) |
                        (1ULL << BOARD_PUMP_3_GPIO) |
                        (1ULL << BOARD_PUMP_4_GPIO) |
                        (1ULL << BOARD_STIRRER_GPIO) |
                        (1ULL << BOARD_ICE_GPIO) |
                        (1ULL << BOARD_CLEAN_GPIO),
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };

    esp_err_t err = gpio_config(&config);
    if (err != ESP_OK) {
        return err;
    }

    actuators_stop_all();
    return ESP_OK;
}

esp_err_t actuators_run_pump(uint8_t channel, uint32_t duration_ms)
{
    if (channel >= sizeof(s_pump_gpios) / sizeof(s_pump_gpios[0])) {
        return ESP_ERR_INVALID_ARG;
    }

    return run_for_duration(s_pump_gpios[channel], duration_ms, BOARD_PUMP_TIMEOUT_MS);
}

esp_err_t actuators_run_stirrer(uint32_t duration_ms)
{
    return run_for_duration(BOARD_STIRRER_GPIO, duration_ms, BOARD_STIR_TIMEOUT_MS);
}

esp_err_t actuators_dispense_ice(uint8_t level)
{
    if (level == 0) {
        return ESP_OK;
    }

    return run_for_duration(BOARD_ICE_GPIO, 400U * level, 2000U);
}

esp_err_t actuators_run_clean_cycle(uint32_t duration_ms)
{
    return run_for_duration(BOARD_CLEAN_GPIO, duration_ms, BOARD_CLEAN_TIMEOUT_MS);
}

void actuators_stop_all(void)
{
    for (size_t i = 0; i < sizeof(s_pump_gpios) / sizeof(s_pump_gpios[0]); ++i) {
        actuator_set(s_pump_gpios[i], false);
    }

    actuator_set(BOARD_STIRRER_GPIO, false);
    actuator_set(BOARD_ICE_GPIO, false);
    actuator_set(BOARD_CLEAN_GPIO, false);
}
