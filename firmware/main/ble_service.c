#include "ble_service.h"

#include <host/ble_gap.h>
#include <host/ble_gatt.h>
#include <host/ble_hs.h>
#include <host/ble_uuid.h>
#include <nimble/nimble_port.h>
#include <nimble/nimble_port_freertos.h>
#include <services/gap/ble_svc_gap.h>
#include <services/gatt/ble_svc_gatt.h>
#include <string.h>
#include <cJSON.h>
#include <esp_log.h>
#include <esp_nimble_hci.h>

static const char *TAG = "ble_service";

static ble_command_handler_t s_command_handler;
static ble_connection_handler_t s_connection_handler;
static uint16_t s_conn_handle = BLE_HS_CONN_HANDLE_NONE;
static uint16_t s_telemetry_handle;
static bool s_ble_ready;
static uint8_t s_addr_type;

static const ble_uuid128_t s_service_uuid =
    BLE_UUID128_INIT(0xaa, 0x10, 0x3c, 0x81, 0x34, 0x65, 0x11, 0xef, 0x90, 0x5b, 0x02, 0x42, 0xac, 0x12, 0x00, 0x01);
static const ble_uuid128_t s_command_uuid =
    BLE_UUID128_INIT(0xaa, 0x10, 0x3c, 0x81, 0x34, 0x65, 0x11, 0xef, 0x90, 0x5b, 0x02, 0x42, 0xac, 0x12, 0x00, 0x02);
static const ble_uuid128_t s_telemetry_uuid =
    BLE_UUID128_INIT(0xaa, 0x10, 0x3c, 0x81, 0x34, 0x65, 0x11, 0xef, 0x90, 0x5b, 0x02, 0x42, 0xac, 0x12, 0x00, 0x03);

static int ble_gap_event_cb(struct ble_gap_event *event, void *arg);

static command_type_t parse_command_type(const char *type)
{
    if (strcmp(type, "power_on") == 0) {
        return COMMAND_POWER_ON;
    }
    if (strcmp(type, "power_off") == 0) {
        return COMMAND_POWER_OFF;
    }
    if (strcmp(type, "get_status") == 0) {
        return COMMAND_GET_STATUS;
    }
    if (strcmp(type, "get_system_info") == 0) {
        return COMMAND_GET_SYSTEM_INFO;
    }
    if (strcmp(type, "list_recipes") == 0) {
        return COMMAND_LIST_RECIPES;
    }
    if (strcmp(type, "prepare_drink") == 0) {
        return COMMAND_PREPARE_DRINK;
    }
    if (strcmp(type, "update_settings") == 0) {
        return COMMAND_UPDATE_SETTINGS;
    }
    if (strcmp(type, "start_cleaning") == 0) {
        return COMMAND_START_CLEANING;
    }
    if (strcmp(type, "ack_error") == 0) {
        return COMMAND_ACK_ERROR;
    }
    return COMMAND_UNKNOWN;
}

static void parse_settings(cJSON *settings_json, app_settings_t *settings)
{
    cJSON *ice_level = cJSON_GetObjectItemCaseSensitive(settings_json, "iceLevel");
    cJSON *auto_clean = cJSON_GetObjectItemCaseSensitive(settings_json, "autoClean");
    cJSON *capacities = cJSON_GetObjectItemCaseSensitive(settings_json, "bottleCapacities");
    cJSON *pump_rates = cJSON_GetObjectItemCaseSensitive(settings_json, "pumpRates");

    if (cJSON_IsNumber(ice_level)) {
        settings->ice_level = (uint8_t)ice_level->valuedouble;
    }

    if (cJSON_IsBool(auto_clean)) {
        settings->auto_clean = cJSON_IsTrue(auto_clean);
    }

    if (cJSON_IsArray(capacities)) {
        for (size_t i = 0; i < APP_MAX_PUMPS; ++i) {
            cJSON *item = cJSON_GetArrayItem(capacities, (int)i);
            if (cJSON_IsNumber(item)) {
                settings->bottle_capacities_ml[i] = (float)item->valuedouble;
            }
        }
    }

    if (cJSON_IsArray(pump_rates)) {
        for (size_t i = 0; i < APP_MAX_PUMPS; ++i) {
            cJSON *item = cJSON_GetArrayItem(pump_rates, (int)i);
            if (cJSON_IsNumber(item)) {
                settings->pump_rates_ml_per_sec[i] = (float)item->valuedouble;
            }
        }
    }
}

static bool parse_command_json(const char *payload, device_command_t *command)
{
    cJSON *root = cJSON_Parse(payload);
    if (root == NULL) {
        return false;
    }

    memset(command, 0, sizeof(*command));
    command->schema_version = APP_SCHEMA_VERSION;

    cJSON *type = cJSON_GetObjectItemCaseSensitive(root, "type");
    cJSON *schema = cJSON_GetObjectItemCaseSensitive(root, "schemaVersion");
    cJSON *recipe_id = cJSON_GetObjectItemCaseSensitive(root, "recipeId");
    cJSON *settings_json = cJSON_GetObjectItemCaseSensitive(root, "settings");

    if (!cJSON_IsString(type)) {
        cJSON_Delete(root);
        return false;
    }

    if (cJSON_IsNumber(schema)) {
        command->schema_version = (uint8_t)schema->valuedouble;
    }

    command->type = parse_command_type(type->valuestring);
    if (command->type == COMMAND_UNKNOWN) {
        cJSON_Delete(root);
        return false;
    }

    if (cJSON_IsString(recipe_id)) {
        strncpy(command->recipe_id, recipe_id->valuestring, sizeof(command->recipe_id) - 1);
    }

    if (cJSON_IsObject(settings_json)) {
        parse_settings(settings_json, &command->settings);
    }

    cJSON_Delete(root);
    return true;
}

static int gatt_access(uint16_t conn_handle, uint16_t attr_handle,
                       struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)conn_handle;
    (void)attr_handle;
    (void)arg;

    if (ctxt->op == BLE_GATT_ACCESS_OP_WRITE_CHR) {
        char buffer[APP_MAX_JSON_LEN];
        size_t len = OS_MBUF_PKTLEN(ctxt->om);
        if (len >= sizeof(buffer)) {
            return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
        }

        int rc = os_mbuf_copydata(ctxt->om, 0, len, buffer);
        if (rc != 0) {
            return BLE_ATT_ERR_UNLIKELY;
        }

        buffer[len] = '\0';

        device_command_t command;
        if (!parse_command_json(buffer, &command)) {
            return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
        }

        if (s_command_handler != NULL) {
            s_command_handler(&command);
        }

        return 0;
    }

    return BLE_ATT_ERR_READ_NOT_PERMITTED;
}

static const struct ble_gatt_svc_def gatt_svcs[] = {
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = &s_service_uuid.u,
        .characteristics = (struct ble_gatt_chr_def[]) {
            {
                .uuid = &s_command_uuid.u,
                .access_cb = gatt_access,
                .flags = BLE_GATT_CHR_F_WRITE,
            },
            {
                .uuid = &s_telemetry_uuid.u,
                .access_cb = gatt_access,
                .flags = BLE_GATT_CHR_F_NOTIFY,
                .val_handle = &s_telemetry_handle,
            },
            { 0 }
        },
    },
    { 0 }
};

static void ble_advertise(void)
{
    struct ble_gap_adv_params adv_params = { 0 };
    struct ble_hs_adv_fields fields = { 0 };

    fields.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    fields.name = (const uint8_t *)"PenpitoMixer";
    fields.name_len = strlen("PenpitoMixer");
    fields.name_is_complete = 1;
    fields.uuids128 = (ble_uuid128_t *)&s_service_uuid;
    fields.num_uuids128 = 1;
    fields.uuids128_is_complete = 1;

    ble_gap_adv_set_fields(&fields);
    adv_params.conn_mode = BLE_GAP_CONN_MODE_UND;
    adv_params.disc_mode = BLE_GAP_DISC_MODE_GEN;
    ble_gap_adv_start(s_addr_type, NULL, BLE_HS_FOREVER, &adv_params, ble_gap_event_cb, NULL);
}

static int ble_gap_event_cb(struct ble_gap_event *event, void *arg)
{
    (void)arg;
    switch (event->type) {
    case BLE_GAP_EVENT_CONNECT:
        if (event->connect.status == 0) {
            s_conn_handle = event->connect.conn_handle;
            if (s_connection_handler != NULL) {
                s_connection_handler(true);
            }
        } else {
            ble_advertise();
        }
        break;
    case BLE_GAP_EVENT_DISCONNECT:
        s_conn_handle = BLE_HS_CONN_HANDLE_NONE;
        if (s_connection_handler != NULL) {
            s_connection_handler(false);
        }
        ble_advertise();
        break;
    case BLE_GAP_EVENT_SUBSCRIBE:
        ESP_LOGI(TAG, "Client subscription updated");
        break;
    default:
        break;
    }

    return 0;
}

static void ble_on_sync(void)
{
    s_ble_ready = true;
    ble_hs_id_infer_auto(0, &s_addr_type);
    ble_advertise();
}

static void host_task(void *param)
{
    (void)param;
    nimble_port_run();
    nimble_port_freertos_deinit();
}

esp_err_t ble_service_init(ble_command_handler_t command_handler, ble_connection_handler_t connection_handler)
{
    s_command_handler = command_handler;
    s_connection_handler = connection_handler;

    ESP_ERROR_CHECK(esp_nimble_hci_and_controller_init());
    nimble_port_init();

    ble_hs_cfg.sync_cb = ble_on_sync;
    ble_hs_cfg.gatts_register_cb = NULL;
    ble_hs_cfg.store_status_cb = NULL;

    ble_svc_gap_init();
    ble_svc_gatt_init();
    ble_svc_gap_device_name_set("PenpitoMixer");

    int rc = ble_gatts_count_cfg(gatt_svcs);
    if (rc != 0) {
        return ESP_FAIL;
    }

    rc = ble_gatts_add_svcs(gatt_svcs);
    if (rc != 0) {
        return ESP_FAIL;
    }

    return ESP_OK;
}

esp_err_t ble_service_start(void)
{
    nimble_port_freertos_init(host_task);
    return ESP_OK;
}

esp_err_t ble_service_notify_json(const char *json_payload)
{
    if (!s_ble_ready || s_conn_handle == BLE_HS_CONN_HANDLE_NONE || json_payload == NULL) {
        return ESP_ERR_INVALID_STATE;
    }

    struct os_mbuf *om = ble_hs_mbuf_from_flat(json_payload, strlen(json_payload));
    if (om == NULL) {
        return ESP_ERR_NO_MEM;
    }
    int rc = ble_gattc_notify_custom(s_conn_handle, s_telemetry_handle, om);
    return rc == 0 ? ESP_OK : ESP_FAIL;
}
