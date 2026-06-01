# Firmware ESP32 - Coctelera Automatica

Proyecto `ESP-IDF` para el MVP local por `BLE` de la coctelera automatica.

## Alcance implementado

- Servicio BLE para comandos y telemetria.
- Maquina de estados con modos `OFF`, `IDLE`, `PREPARING`, `CLEANING`, `ERROR`.
- Catalogo embebido de 4 tragos.
- Persistencia de configuracion, metricas y ultimo error en `NVS`.
- Control base de 4 bombas, agitador, hielo y limpieza.
- Validaciones de seguridad con sensor de vaso y sensor de tapa.

## Estructura

- `main/app_main.c`: arranque del sistema.
- `main/app_controller.*`: orquestacion de comandos, estado y BLE.
- `main/ble_service.*`: GATT service BLE.
- `main/recipe_engine.*`: preparacion de tragos y limpieza.
- `main/machine_state.*`: snapshot y transiciones del estado global.
- `main/settings.*`, `main/stats.*`, `main/storage_nvs.*`: persistencia.
- `main/actuators.*`, `main/sensors.*`, `main/safety.*`: capa de hardware.

## Comandos BLE

La caracteristica `command` acepta JSON con `schemaVersion=1` y `type`.

Ejemplos:

```json
{"schemaVersion":1,"type":"power_on"}
{"schemaVersion":1,"type":"get_status"}
{"schemaVersion":1,"type":"prepare_drink","recipeId":"piscola"}
{"schemaVersion":1,"type":"update_settings","settings":{"iceLevel":2,"autoClean":true}}
```

La caracteristica `telemetry` notifica eventos `status_snapshot`, `progress_update`,
`system_info`, `recipe_catalog`, `settings_applied`, `error_event` y `drink_ready`.

## Pines por defecto

Definidos en `main/include/board_config.h`. Si el hardware cambia, basta con ajustar
ese archivo y recalibrar `pumpRatesMlPerSec`.

## Build

Requiere `ESP-IDF` instalado y el entorno cargado.

```bash
idf.py set-target esp32
idf.py build
```
