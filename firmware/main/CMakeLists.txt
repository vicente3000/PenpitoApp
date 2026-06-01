idf_component_register(
    SRCS
        "app_main.c"
        "app_controller.c"
        "actuators.c"
        "ble_service.c"
        "machine_state.c"
        "recipe_engine.c"
        "recipes.c"
        "safety.c"
        "sensors.c"
        "settings.c"
        "stats.c"
        "storage_nvs.c"
    INCLUDE_DIRS "include"
    REQUIRES bt nvs_flash driver esp_timer json
)
