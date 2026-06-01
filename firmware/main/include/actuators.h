#ifndef ACTUATORS_H
#define ACTUATORS_H

#include <esp_err.h>
#include <stdint.h>

esp_err_t actuators_init(void);
esp_err_t actuators_run_pump(uint8_t channel, uint32_t duration_ms);
esp_err_t actuators_run_stirrer(uint32_t duration_ms);
esp_err_t actuators_dispense_ice(uint8_t level);
esp_err_t actuators_run_clean_cycle(uint32_t duration_ms);
void actuators_stop_all(void);

#endif
