#include "recipe_engine.h"

#include <string.h>

#include "actuators.h"
#include "machine_state.h"

static recipe_progress_callback_t s_progress_cb;
static recipe_event_callback_t s_event_cb;
static recipe_error_callback_t s_error_cb;

static uint32_t amount_to_duration_ms(float amount_ml, float rate_ml_per_sec)
{
    if (rate_ml_per_sec <= 0.0f) {
        return 0;
    }

    return (uint32_t)((amount_ml * 1000.0f + rate_ml_per_sec - 0.001f) / rate_ml_per_sec);
}

static uint32_t compute_total_duration_ms(const recipe_t *recipe, const app_settings_t *settings)
{
    uint32_t total_ms = recipe->stir_time_ms;

    for (size_t i = 0; i < recipe->ingredient_count; ++i) {
        const recipe_ingredient_t *ingredient = &recipe->ingredients[i];
        float rate = settings->pump_rates_ml_per_sec[ingredient->channel];
        total_ms += amount_to_duration_ms(ingredient->amount_ml, rate);
    }

    total_ms += recipe->ice_level * 400U;
    return total_ms;
}

static void publish_progress(const recipe_t *recipe, uint8_t progress_pct, uint32_t remaining_sec)
{
    preparation_progress_t progress = {
        .schema_version = APP_SCHEMA_VERSION,
        .progress_pct = progress_pct,
        .estimated_remaining_sec = remaining_sec,
    };

    strncpy(progress.recipe_id, recipe->id, sizeof(progress.recipe_id) - 1);
    strncpy(progress.recipe_name, recipe->name, sizeof(progress.recipe_name) - 1);
    machine_state_set_progress(recipe->id, progress_pct, remaining_sec);

    if (s_progress_cb != NULL) {
        s_progress_cb(&progress);
    }
}

static void report_error(const char *code, const char *message)
{
    device_error_t error = {
        .schema_version = APP_SCHEMA_VERSION,
    };

    strncpy(error.code, code, sizeof(error.code) - 1);
    strncpy(error.message, message, sizeof(error.message) - 1);

    machine_state_set_error(code, message);

    if (s_error_cb != NULL) {
        s_error_cb(&error);
    }
}

void recipe_engine_init(recipe_progress_callback_t progress_cb,
                        recipe_event_callback_t event_cb,
                        recipe_error_callback_t error_cb)
{
    s_progress_cb = progress_cb;
    s_event_cb = event_cb;
    s_error_cb = error_cb;
}

esp_err_t recipe_engine_prepare(const recipe_t *recipe, const app_settings_t *settings, system_stats_t *stats)
{
    if (recipe == NULL || settings == NULL || stats == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    uint32_t total_duration_ms = compute_total_duration_ms(recipe, settings);
    uint32_t elapsed_ms = 0;

    for (size_t i = 0; i < recipe->ingredient_count; ++i) {
        const recipe_ingredient_t *ingredient = &recipe->ingredients[i];
        float rate = settings->pump_rates_ml_per_sec[ingredient->channel];
        uint32_t duration_ms = amount_to_duration_ms(ingredient->amount_ml, rate);
        esp_err_t err = actuators_run_pump(ingredient->channel, duration_ms);
        if (err != ESP_OK) {
            report_error("pump_timeout", "Pump activation failed");
            actuators_stop_all();
            return err;
        }

        elapsed_ms += duration_ms;
        publish_progress(recipe, (uint8_t)((elapsed_ms * 100U) / total_duration_ms),
                         (total_duration_ms - elapsed_ms) / 1000U);
    }

    uint8_t ice_level = recipe->ice_level > 0 ? recipe->ice_level : settings->ice_level;
    esp_err_t err = actuators_dispense_ice(ice_level);
    if (err != ESP_OK) {
        report_error("ice_fault", "Ice actuator failed");
        actuators_stop_all();
        return err;
    }

    elapsed_ms += ice_level * 400U;
    publish_progress(recipe, (uint8_t)((elapsed_ms * 100U) / total_duration_ms),
                     (total_duration_ms - elapsed_ms) / 1000U);

    err = actuators_run_stirrer(recipe->stir_time_ms);
    if (err != ESP_OK) {
        report_error("stir_fault", "Stirrer activation failed");
        actuators_stop_all();
        return err;
    }

    publish_progress(recipe, 100, 0);
    stats->drink_count += 1;

    if (s_event_cb != NULL) {
        s_event_cb("drink_ready", recipe->id, recipe->name);
    }

    return ESP_OK;
}

esp_err_t recipe_engine_clean(const app_settings_t *settings, system_stats_t *stats)
{
    (void)settings;
    if (stats == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    esp_err_t err = actuators_run_clean_cycle(5000);
    if (err != ESP_OK) {
        report_error("clean_fault", "Clean cycle failed");
        actuators_stop_all();
        return err;
    }

    stats->clean_cycle_count += 1;

    if (s_event_cb != NULL) {
        s_event_cb("clean_complete", "clean_cycle", "Clean Cycle");
    }

    return ESP_OK;
}
