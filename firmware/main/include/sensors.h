#ifndef SENSORS_H
#define SENSORS_H

#include <stdbool.h>
#include <esp_err.h>

esp_err_t sensors_init(void);
bool sensors_is_cup_present(void);
bool sensors_is_lid_closed(void);

#endif
