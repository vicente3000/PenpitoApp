#include "sensors.h"

#include <driver/gpio.h>

#include "board_config.h"

static bool sensors_read(gpio_num_t gpio_num)
{
    return gpio_get_level(gpio_num) == BOARD_SENSOR_ACTIVE_LEVEL;
}

esp_err_t sensors_init(void)
{
    gpio_config_t config = {
        .pin_bit_mask = (1ULL << BOARD_CUP_SENSOR_GPIO) | (1ULL << BOARD_LID_SENSOR_GPIO),
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };

    return gpio_config(&config);
}

bool sensors_is_cup_present(void)
{
    return sensors_read(BOARD_CUP_SENSOR_GPIO);
}

bool sensors_is_lid_closed(void)
{
    return sensors_read(BOARD_LID_SENSOR_GPIO);
}
