#include <Arduino.h>
#include <ArduinoJson.h>
#include <ESP32Servo.h>
#include <Preferences.h>
#include <PubSubClient.h>
#include <WiFi.h>

// Bombas (L298N)
const int B_PWM[] = {12, 13, 19, 25, 26, 32, 33};
const int B_DIR[] = {2, 4, 21, 15, 16, 17, 18};
const int NUM_BOMBAS = 7;
const float B_CAL_ML = 30.0;
const unsigned long B_CAL_MS[NUM_BOMBAS] = {3760, 1350, 6560, 1115, 2000, 1025, 0};
float b_ml_ps[NUM_BOMBAS] = {0};

// Cambia DEVICE_ID a "motor" cuando subas este firmware al ESP32 del motor.
const char* DEVICE_ID = "pumps";
const char* DEFAULT_WIFI_SSID = "TU_WIFI";
const char* DEFAULT_WIFI_PASSWORD = "TU_CLAVE_WIFI";
const char* DEFAULT_MQTT_HOST = "192.168.1.100";
const uint16_t DEFAULT_MQTT_PORT = 1883;

const char* MQTT_CLIENT_ID = "penpito-esp32";
const char* TOPIC_LEGACY_STATE = "penpito/kraken/state";
const char* TOPIC_LEGACY_COMMAND = "penpito/kraken/command";
const char* TOPIC_LEGACY_ACK = "penpito/kraken/command/ack";
const unsigned long MQTT_RECONNECT_MS = 3000;
const unsigned long STATE_PUBLISH_MS = 1500;

const float ML_PER_OUNCE = 29.57;
const int MAX_PLAN_ITEMS = 4;

// Servos
Servo srv_pos[3];
const int SRV_PIN[] = {22, 23, 27};
Servo srv_cont;
const int SRV_CONT_PIN = 14;

// NEMA17 + A4988
const int MOTOR_STEP = 5;
const int LIMIT_SW = 34;
volatile bool limit_triggered = false;

WiFiClient wifi_client;
PubSubClient mqtt_client(wifi_client);
Preferences preferences;
String wifi_ssid = DEFAULT_WIFI_SSID;
String wifi_password = DEFAULT_WIFI_PASSWORD;
String mqtt_host = DEFAULT_MQTT_HOST;
uint16_t mqtt_port = DEFAULT_MQTT_PORT;
String topic_state;
String topic_command;
String topic_ack;

enum MachineStatus {
  STATUS_IDLE,
  STATUS_PREPARING,
  STATUS_CLEANING,
  STATUS_ERROR,
};

enum PreparationStep {
  STEP_NONE = -1,
  STEP_CUP_DISPENSER,
  STEP_ICE_DISPENSER,
  STEP_ALCOHOL_DISPENSER,
  STEP_AGITATION_SYSTEM,
  STEP_CARBONATED_STATION,
  STEP_READY,
};

enum PlanType {
  PLAN_NONE,
  PLAN_ALCOHOL,
  PLAN_MIXER,
};

struct DispenseItem {
  int pump;
  float ml;
  unsigned long durationMs;
};

MachineStatus machine_status = STATUS_IDLE;
PreparationStep active_step = STEP_NONE;
PlanType active_plan = PLAN_NONE;
DispenseItem alcohol_plan[MAX_PLAN_ITEMS];
DispenseItem mixer_plan[MAX_PLAN_ITEMS];
int alcohol_plan_count = 0;
int mixer_plan_count = 0;
int active_plan_index = 0;
int active_plan_pump = -1;
bool active_plan_item_running = false;
bool step_action_started = false;
bool is_on = true;
bool is_drink_ready = false;
bool skip_ice = false;
bool skip_agitation = false;
bool skip_carbonation = false;
int requested_ice_count = 2;
String current_recipe_id = "";
String error_message = "";
unsigned long step_started_at = 0;
unsigned long ready_started_at = 0;
unsigned long active_plan_stop_at = 0;
unsigned long last_mqtt_reconnect_at = 0;
unsigned long last_state_publish_at = 0;
bool restart_pending = false;
unsigned long restart_at = 0;
int motor_pos = 0;

void IRAM_ATTR on_limit();
void help();
void setup_hardware();
void load_network_config();
void save_network_config(const String& ssid, const String& password, const String& host, uint16_t port);
void build_mqtt_topics();
void setup_wifi();
void setup_mqtt();
void maintain_mqtt();
void mqtt_callback(char* topic, byte* payload, unsigned int length);
void publish_state(bool retained = true);
void publish_ack(const char* request_id, bool ok, const String& message);
void serialize_state(JsonObject state);
const char* status_to_string();
const char* step_to_string(PreparationStep step);
PreparationStep next_step_after(PreparationStep step);
unsigned long duration_for_step(PreparationStep step);
bool recipe_needs_agitation(const String& recipe_id);
bool recipe_needs_carbonation(const String& recipe_id);
bool handle_command(JsonDocument& input, String& message);
bool handle_wifi_config(JsonDocument& input, String& message);
void schedule_restart();
bool start_preparation(const String& recipe_id, int ice_count, float alcohol_oz, float mixer_oz);
void start_cleaning();
void update_machine();
void complete_active_step();
void reset_preparation_state();
bool build_dispense_plans(const String& recipe_id, float alcohol_oz, float mixer_oz);
bool add_dispense_item(DispenseItem plan[], int& count, int pump, float ml);
unsigned long pump_time_ms(int pump, float ml);
void start_dispense_plan(PlanType plan);
bool update_dispense_plan();
int active_plan_count();
DispenseItem* active_plan_items();
DispenseItem& active_plan_item();
void cargar_calibracion_bombas();
void bombas_off();
void bomba_on(int n);
void calibrar(int n);
void guardar_cal(int n, float ml);
void dispensar(int n, float ml);
void primear(int n, int seg);
void test_bombas();
void servo_pos(int n, int ang);
void servo_cont_set(int ang);
void motor_stop();
void motor_step();
bool motor_steps(int n);
void home();
void mover_a(int target);
void handle_serial();

void IRAM_ATTR on_limit() {
  limit_triggered = true;
}

void setup() {
  Serial.begin(115200);
  setup_hardware();
  cargar_calibracion_bombas();
  load_network_config();
  build_mqtt_topics();
  setup_wifi();
  setup_mqtt();

  Serial.println(F("COCTELERA INTELIGENTE"));
  Serial.println(F("Modo MQTT/Mosquitto listo."));
  help();
}

void loop() {
  maintain_mqtt();
  mqtt_client.loop();
  update_machine();
  handle_serial();

  if (restart_pending && millis() >= restart_at) {
    ESP.restart();
  }

  if (millis() - last_state_publish_at >= STATE_PUBLISH_MS) {
    publish_state();
  }
}

void setup_hardware() {
  for (int i = 0; i < NUM_BOMBAS; i++) {
    pinMode(B_PWM[i], OUTPUT);
    pinMode(B_DIR[i], OUTPUT);
    digitalWrite(B_PWM[i], LOW);
    digitalWrite(B_DIR[i], LOW);
  }

  for (int i = 0; i < 3; i++) {
    srv_pos[i].setPeriodHertz(50);
    srv_pos[i].attach(SRV_PIN[i], 500, 2400);
    srv_pos[i].write(90);
  }

  srv_cont.setPeriodHertz(50);
  srv_cont.attach(SRV_CONT_PIN, 500, 2400);
  srv_cont.write(90);

  pinMode(MOTOR_STEP, OUTPUT);
  digitalWrite(MOTOR_STEP, LOW);
  pinMode(LIMIT_SW, INPUT);
  attachInterrupt(digitalPinToInterrupt(LIMIT_SW), on_limit, RISING);
}

void load_network_config() {
  preferences.begin("netcfg", true);
  wifi_ssid = preferences.getString("ssid", DEFAULT_WIFI_SSID);
  wifi_password = preferences.getString("pass", DEFAULT_WIFI_PASSWORD);
  mqtt_host = preferences.getString("host", DEFAULT_MQTT_HOST);
  mqtt_port = preferences.getUShort("port", DEFAULT_MQTT_PORT);
  preferences.end();
}

void save_network_config(const String& ssid, const String& password, const String& host, uint16_t port) {
  preferences.begin("netcfg", false);
  preferences.putString("ssid", ssid);
  preferences.putString("pass", password);
  preferences.putString("host", host);
  preferences.putUShort("port", port);
  preferences.end();
}

void build_mqtt_topics() {
  topic_state = "penpito/";
  topic_state += DEVICE_ID;
  topic_state += "/state";

  topic_command = "penpito/";
  topic_command += DEVICE_ID;
  topic_command += "/command";

  topic_ack = "penpito/";
  topic_ack += DEVICE_ID;
  topic_ack += "/command/ack";
}

void setup_wifi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(wifi_ssid.c_str(), wifi_password.c_str());

  Serial.print(F("Conectando WiFi"));
  unsigned long started_at = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - started_at < 20000) {
    delay(500);
    Serial.print(F("."));
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print(F("WiFi OK. IP ESP32: "));
    Serial.println(WiFi.localIP());
  } else {
    Serial.println(F("WiFi no conectado. Revisa la configuracion guardada."));
  }
}

void setup_mqtt() {
  mqtt_client.setServer(mqtt_host.c_str(), mqtt_port);
  mqtt_client.setCallback(mqtt_callback);
  mqtt_client.setBufferSize(1024);
}

void maintain_mqtt() {
  if (WiFi.status() != WL_CONNECTED) {
    return;
  }

  if (mqtt_client.connected()) {
    return;
  }

  if (millis() - last_mqtt_reconnect_at < MQTT_RECONNECT_MS) {
    return;
  }

  last_mqtt_reconnect_at = millis();
  Serial.print(F("Conectando MQTT a "));
  Serial.print(mqtt_host);
  Serial.print(F(":"));
  Serial.println(mqtt_port);

  String client_id = String(MQTT_CLIENT_ID) + "-" + DEVICE_ID;
  if (mqtt_client.connect(client_id.c_str())) {
    Serial.println(F("MQTT conectado."));
    mqtt_client.subscribe(TOPIC_LEGACY_COMMAND);
    mqtt_client.subscribe(topic_command.c_str());
    publish_state();
  } else {
    Serial.print(F("MQTT fallo, rc="));
    Serial.println(mqtt_client.state());
  }
}

void mqtt_callback(char* topic, byte* payload, unsigned int length) {
  String received_topic = topic;
  if (received_topic != TOPIC_LEGACY_COMMAND && received_topic != topic_command) {
    return;
  }

  JsonDocument input;
  DeserializationError error = deserializeJson(input, payload, length);
  const char* request_id = input["requestId"] | "";
  String message = "";
  bool ok = false;

  if (error) {
    message = "JSON invalido";
  } else {
    ok = handle_command(input, message);
  }

  publish_ack(request_id, ok, message);
  publish_state();
}

bool handle_command(JsonDocument& input, String& message) {
  String cmd = input["cmd"] | "";
  String val = input["val"] | "";

  if (cmd == "POWER") {
    is_on = val == "ON";
    if (!is_on) {
      bombas_off();
      reset_preparation_state();
    }
    return true;
  }

  if (cmd == "CONFIG_WIFI") {
    return handle_wifi_config(input, message);
  }

  if (!is_on) {
    message = "Maquina apagada";
    return false;
  }

  if (cmd == "PREPARE") {
    if (machine_status != STATUS_IDLE || is_drink_ready) {
      message = "Maquina ocupada";
      return false;
    }

    bool ok = start_preparation(
      val,
      input["iceCount"] | 2,
      input["alcoholOz"] | 0.0,
      input["mixerOz"] | 0.0
    );
    if (!ok) {
      message = error_message.length() ? error_message : "Receta no soportada";
    }
    return ok;
  }

  if (cmd == "CLEAN") {
    if (machine_status != STATUS_IDLE || is_drink_ready) {
      message = "Maquina ocupada";
      return false;
    }

    start_cleaning();
    return true;
  }

  message = "Comando no soportado";
  return false;
}

bool handle_wifi_config(JsonDocument& input, String& message) {
  String target = input["target"] | "";
  if (target.length() && target != DEVICE_ID && target != "all") {
    message = "Comando para otro ESP32";
    return false;
  }

  String ssid = input["ssid"] | "";
  String password = input["password"] | "";
  String host = input["mqttHost"] | "";
  int port = input["mqttPort"] | DEFAULT_MQTT_PORT;

  ssid.trim();
  host.trim();

  if (!ssid.length() || !host.length() || port <= 0 || port > 65535) {
    message = "Config WiFi/MQTT incompleta";
    return false;
  }

  save_network_config(ssid, password, host, static_cast<uint16_t>(port));
  wifi_ssid = ssid;
  wifi_password = password;
  mqtt_host = host;
  mqtt_port = static_cast<uint16_t>(port);
  message = "Config guardada. Reiniciando ESP32.";
  schedule_restart();
  return true;
}

void schedule_restart() {
  restart_pending = true;
  restart_at = millis() + 1500;
}

void publish_ack(const char* request_id, bool ok, const String& message) {
  if (!mqtt_client.connected()) {
    return;
  }

  JsonDocument doc;
  doc["requestId"] = request_id;
  doc["ok"] = ok;
  if (message.length()) {
    doc["message"] = message;
  }
  serialize_state(doc["state"].to<JsonObject>());

  char buffer[1024];
  size_t len = serializeJson(doc, buffer);
  mqtt_client.publish(TOPIC_LEGACY_ACK, reinterpret_cast<const uint8_t*>(buffer), len);
  mqtt_client.publish(topic_ack.c_str(), reinterpret_cast<const uint8_t*>(buffer), len);
}

void publish_state(bool retained) {
  if (!mqtt_client.connected()) {
    return;
  }

  JsonDocument doc;
  serialize_state(doc.to<JsonObject>());

  char buffer[1024];
  size_t len = serializeJson(doc, buffer);
  mqtt_client.publish(TOPIC_LEGACY_STATE, reinterpret_cast<const uint8_t*>(buffer), len, retained);
  mqtt_client.publish(topic_state.c_str(), reinterpret_cast<const uint8_t*>(buffer), len, retained);
  last_state_publish_at = millis();
}

void serialize_state(JsonObject state) {
  state["deviceId"] = DEVICE_ID;
  state["isOn"] = is_on;
  state["status"] = status_to_string();
  if (error_message.length()) {
    state["errorMessage"] = error_message;
  } else {
    state["errorMessage"] = nullptr;
  }
  if (current_recipe_id.length()) {
    state["currentRecipeId"] = current_recipe_id;
  } else {
    state["currentRecipeId"] = nullptr;
  }
  state["requestedIceCount"] = requested_ice_count;
  state["activeStepId"] = active_step == STEP_NONE ? nullptr : step_to_string(active_step);
  state["isDrinkReady"] = is_drink_ready;

  JsonArray completed = state["completedStepIds"].to<JsonArray>();
  for (int index = 0; index < active_step && active_step != STEP_NONE; index += 1) {
    PreparationStep step = static_cast<PreparationStep>(index);
    if ((step == STEP_ICE_DISPENSER && skip_ice) ||
        (step == STEP_AGITATION_SYSTEM && skip_agitation) ||
        (step == STEP_CARBONATED_STATION && skip_carbonation)) {
      continue;
    }
    completed.add(step_to_string(step));
  }

  JsonArray skipped = state["skippedStepIds"].to<JsonArray>();
  if (skip_ice) {
    skipped.add("ice_dispenser");
  }
  if (skip_agitation) {
    skipped.add("agitation_system");
  }
  if (skip_carbonation) {
    skipped.add("carbonated_station");
  }
}

const char* status_to_string() {
  switch (machine_status) {
    case STATUS_PREPARING:
      return "preparing";
    case STATUS_CLEANING:
      return "cleaning";
    case STATUS_ERROR:
      return "error";
    default:
      return "idle";
  }
}

const char* step_to_string(PreparationStep step) {
  switch (step) {
    case STEP_CUP_DISPENSER:
      return "cup_dispenser";
    case STEP_ICE_DISPENSER:
      return "ice_dispenser";
    case STEP_ALCOHOL_DISPENSER:
      return "alcohol_dispenser";
    case STEP_AGITATION_SYSTEM:
      return "agitation_system";
    case STEP_CARBONATED_STATION:
      return "carbonated_station";
    case STEP_READY:
      return "ready";
    default:
      return "";
  }
}

PreparationStep next_step_after(PreparationStep step) {
  int next = static_cast<int>(step) + 1;

  while (next <= STEP_READY) {
    PreparationStep candidate = static_cast<PreparationStep>(next);
    if (candidate == STEP_ICE_DISPENSER && skip_ice) {
      next += 1;
      continue;
    }
    if (candidate == STEP_AGITATION_SYSTEM && skip_agitation) {
      next += 1;
      continue;
    }
    if (candidate == STEP_CARBONATED_STATION && skip_carbonation) {
      next += 1;
      continue;
    }
    return candidate;
  }

  return STEP_READY;
}

unsigned long duration_for_step(PreparationStep step) {
  switch (step) {
    case STEP_CUP_DISPENSER:
      return 700;
    case STEP_ICE_DISPENSER:
      return max(1, requested_ice_count) * 600UL;
    case STEP_AGITATION_SYSTEM:
      return 3000;
    case STEP_READY:
      return 300;
    default:
      return 0;
  }
}

bool recipe_needs_agitation(const String& recipe_id) {
  return recipe_id == "negroni";
}

bool recipe_needs_carbonation(const String& recipe_id) {
  return recipe_id == "piscola" || recipe_id == "gin_tonic";
}

bool start_preparation(const String& recipe_id, int ice_count, float alcohol_oz, float mixer_oz) {
  if (!build_dispense_plans(recipe_id, alcohol_oz, mixer_oz)) {
    return false;
  }

  current_recipe_id = recipe_id;
  requested_ice_count = max(0, ice_count);
  skip_ice = requested_ice_count == 0;
  skip_agitation = !recipe_needs_agitation(recipe_id);
  skip_carbonation = !recipe_needs_carbonation(recipe_id);
  is_drink_ready = false;
  error_message = "";
  machine_status = STATUS_PREPARING;
  active_step = next_step_after(STEP_NONE);
  active_plan = PLAN_NONE;
  step_action_started = false;
  step_started_at = millis();

  Serial.print(F("Preparando desde app: "));
  Serial.println(current_recipe_id);
  return true;
}

void start_cleaning() {
  bombas_off();
  machine_status = STATUS_CLEANING;
  active_step = STEP_NONE;
  active_plan = PLAN_NONE;
  is_drink_ready = false;
  error_message = "";
  step_started_at = millis();
  Serial.println(F("Limpieza iniciada desde app movil."));
}

void update_machine() {
  if (machine_status == STATUS_PREPARING) {
    if (active_step == STEP_ALCOHOL_DISPENSER) {
      if (!step_action_started) {
        start_dispense_plan(PLAN_ALCOHOL);
        step_action_started = true;
      }
      if (update_dispense_plan()) {
        complete_active_step();
      }
    } else if (active_step == STEP_CARBONATED_STATION) {
      if (!step_action_started) {
        start_dispense_plan(PLAN_MIXER);
        step_action_started = true;
      }
      if (update_dispense_plan()) {
        complete_active_step();
      }
    } else if (millis() - step_started_at >= duration_for_step(active_step)) {
      complete_active_step();
    }
  }

  if (machine_status == STATUS_CLEANING && millis() - step_started_at >= 3000) {
    reset_preparation_state();
    Serial.println(F("Limpieza terminada."));
  }

  if (is_drink_ready && millis() - ready_started_at >= 5000) {
    reset_preparation_state();
  }
}

void complete_active_step() {
  publish_state();

  if (active_step == STEP_READY) {
    machine_status = STATUS_IDLE;
    is_drink_ready = true;
    ready_started_at = millis();
    Serial.println(F("Trago listo."));
    publish_state();
    return;
  }

  active_step = next_step_after(active_step);
  active_plan = PLAN_NONE;
  active_plan_item_running = false;
  active_plan_index = 0;
  active_plan_pump = -1;
  step_action_started = false;
  step_started_at = millis();
  publish_state();
}

void reset_preparation_state() {
  bombas_off();
  machine_status = STATUS_IDLE;
  active_step = STEP_NONE;
  active_plan = PLAN_NONE;
  active_plan_item_running = false;
  active_plan_index = 0;
  active_plan_pump = -1;
  current_recipe_id = "";
  requested_ice_count = 2;
  skip_ice = false;
  skip_agitation = false;
  skip_carbonation = false;
  is_drink_ready = false;
  publish_state();
}

bool build_dispense_plans(const String& recipe_id, float alcohol_oz, float mixer_oz) {
  alcohol_plan_count = 0;
  mixer_plan_count = 0;
  error_message = "";

  if (recipe_id == "piscola") {
    float alcohol_ml = (alcohol_oz > 0 ? alcohol_oz : 3.0) * ML_PER_OUNCE;
    float mixer_ml = (mixer_oz > 0 ? mixer_oz : 7.5) * ML_PER_OUNCE;
    return add_dispense_item(alcohol_plan, alcohol_plan_count, 0, alcohol_ml) &&
           add_dispense_item(mixer_plan, mixer_plan_count, 1, mixer_ml);
  }

  if (recipe_id == "whisky_rocks") {
    return add_dispense_item(alcohol_plan, alcohol_plan_count, 2, 73.93);
  }

  if (recipe_id == "negroni") {
    return add_dispense_item(alcohol_plan, alcohol_plan_count, 3, 29.57) &&
           add_dispense_item(alcohol_plan, alcohol_plan_count, 4, 29.57) &&
           add_dispense_item(alcohol_plan, alcohol_plan_count, 5, 29.57);
  }

  if (recipe_id == "gin_tonic") {
    return add_dispense_item(alcohol_plan, alcohol_plan_count, 3, 73.93) &&
           add_dispense_item(mixer_plan, mixer_plan_count, 6, 221.78);
  }

  error_message = "Receta no soportada";
  return false;
}

bool add_dispense_item(DispenseItem plan[], int& count, int pump, float ml) {
  if (count >= MAX_PLAN_ITEMS || pump < 0 || pump >= NUM_BOMBAS) {
    error_message = "Plan de dispensado invalido";
    return false;
  }

  if (b_ml_ps[pump] <= 0) {
    Serial.print(F("Aviso: bomba "));
    Serial.print(pump + 1);
    Serial.println(F(" no calibrada; ingrediente omitido."));
    return true;
  }

  plan[count].pump = pump;
  plan[count].ml = ml;
  plan[count].durationMs = pump_time_ms(pump, ml);
  count += 1;
  return true;
}

unsigned long pump_time_ms(int pump, float ml) {
  if (b_ml_ps[pump] <= 0) {
    return 0;
  }

  return (unsigned long)((ml / b_ml_ps[pump]) * 1000.0 + 0.5);
}

void start_dispense_plan(PlanType plan) {
  active_plan = plan;
  active_plan_index = 0;
  active_plan_pump = -1;
  active_plan_item_running = false;
}

bool update_dispense_plan() {
  if (active_plan == PLAN_NONE || active_plan_index >= active_plan_count()) {
    bombas_off();
    active_plan = PLAN_NONE;
    active_plan_item_running = false;
    active_plan_pump = -1;
    return true;
  }

  DispenseItem& item = active_plan_item();

  if (!active_plan_item_running) {
    active_plan_pump = item.pump;
    active_plan_stop_at = millis() + item.durationMs;
    active_plan_item_running = true;
    Serial.print(F("Dispensando "));
    Serial.print(item.ml);
    Serial.print(F("ml en bomba "));
    Serial.print(item.pump + 1);
    Serial.print(F(" por "));
    Serial.print(item.durationMs);
    Serial.println(F("ms"));
    bomba_on(item.pump);
    return false;
  }

  if ((long)(millis() - active_plan_stop_at) >= 0) {
    bombas_off();
    Serial.print(F("Bomba "));
    Serial.print(active_plan_pump + 1);
    Serial.println(F(" OK"));
    active_plan_item_running = false;
    active_plan_pump = -1;
    active_plan_index += 1;
  }

  return false;
}

int active_plan_count() {
  if (active_plan == PLAN_ALCOHOL) {
    return alcohol_plan_count;
  }
  if (active_plan == PLAN_MIXER) {
    return mixer_plan_count;
  }
  return 0;
}

DispenseItem* active_plan_items() {
  return active_plan == PLAN_ALCOHOL ? alcohol_plan : mixer_plan;
}

DispenseItem& active_plan_item() {
  return active_plan_items()[active_plan_index];
}

void cargar_calibracion_bombas() {
  for (int i = 0; i < NUM_BOMBAS; i++) {
    if (B_CAL_MS[i] > 0) {
      b_ml_ps[i] = (B_CAL_ML * 1000.0) / B_CAL_MS[i];
    } else {
      b_ml_ps[i] = 0;
    }
  }
}

void bombas_off() {
  for (int i = 0; i < NUM_BOMBAS; i++) {
    digitalWrite(B_PWM[i], LOW);
    digitalWrite(B_DIR[i], LOW);
  }
}

void bomba_on(int n) {
  digitalWrite(B_PWM[n], HIGH);
  digitalWrite(B_DIR[n], HIGH);
}

void calibrar(int n) {
  bomba_on(n);
  delay(10000);
  bombas_off();
  Serial.print(F("Bomba "));
  Serial.print(n + 1);
  Serial.println(F(" -> 10s. ml? Usa bl<n> <ml>"));
}

void guardar_cal(int n, float ml) {
  b_ml_ps[n] = ml / 10.0;
  Serial.print(F("Bomba "));
  Serial.print(n + 1);
  Serial.print(F(": "));
  Serial.print(b_ml_ps[n], 2);
  Serial.println(F(" ml/s"));
}

void dispensar(int n, float ml) {
  if (b_ml_ps[n] <= 0) {
    Serial.print(F("Bomba "));
    Serial.print(n + 1);
    Serial.println(F(" no calibrada"));
    return;
  }

  unsigned long t = pump_time_ms(n, ml);
  Serial.print(F("Dispensando "));
  Serial.print(ml);
  Serial.print(F("ml bomba "));
  Serial.print(n + 1);
  Serial.print(F(" "));
  Serial.print(t);
  Serial.println(F("ms"));
  bomba_on(n);
  delay(t);
  bombas_off();
  Serial.println(F("OK"));
}

void primear(int n, int seg) {
  bomba_on(n);
  delay(seg * 1000);
  bombas_off();
  Serial.print(F("Prime bomba "));
  Serial.println(n + 1);
}

void test_bombas() {
  for (int i = 0; i < NUM_BOMBAS; i++) {
    Serial.print(F("Bomba "));
    Serial.println(i + 1);
    bomba_on(i);
    delay(1000);
    bombas_off();
    delay(300);
  }
  Serial.println(F("Test OK"));
}

void servo_pos(int n, int ang) {
  ang = constrain(ang, 0, 180);
  srv_pos[n].write(ang);
  Serial.print(F("Servo "));
  Serial.print(n + 1);
  Serial.print(F(" -> "));
  Serial.println(ang);
}

void servo_cont_set(int ang) {
  ang = constrain(ang, 0, 180);
  srv_cont.write(ang);
  Serial.print(F("Servo continuo -> "));
  Serial.println(ang);
}

void motor_stop() {
  digitalWrite(MOTOR_STEP, LOW);
}

void motor_step() {
  digitalWrite(MOTOR_STEP, HIGH);
  delayMicroseconds(5);
  digitalWrite(MOTOR_STEP, LOW);
  delayMicroseconds(1000);
}

bool motor_steps(int n) {
  for (int i = 0; i < abs(n); i++) {
    if (limit_triggered) {
      motor_stop();
      return false;
    }
    motor_step();
    motor_pos += (n > 0) ? 1 : -1;
  }
  return true;
}

void home() {
  Serial.println(F("Buscando home..."));
  limit_triggered = false;

  while (!limit_triggered) {
    motor_step();
    delayMicroseconds(1000);
  }

  motor_stop();
  motor_pos = 0;
  Serial.println(F("Home OK"));
  delay(500);

  for (int i = 0; i < 100; i++) {
    motor_step();
    delayMicroseconds(1000);
  }
  motor_pos = -100;
  limit_triggered = false;
}

void mover_a(int target) {
  int diff = target - motor_pos;
  Serial.print(F("Moviendo a "));
  Serial.print(target);
  Serial.print(F(" ("));
  Serial.print(diff);
  Serial.println(F(" pasos)"));
  motor_steps(abs(diff));
  if (limit_triggered) {
    Serial.println(F("Limit switch alcanzado"));
    limit_triggered = false;
  } else {
    Serial.println(F("OK"));
  }
}

void handle_serial() {
  if (!Serial.available()) {
    return;
  }

  String c = Serial.readStringUntil('\n');
  c.trim();
  if (c.length() == 0) {
    return;
  }

  char p = c[0];

  if (p == '?') {
    help();
  } else if (p == '0') {
    bombas_off();
    motor_stop();
    Serial.println(F("Todo off"));
  } else if (p == 'b') {
    if (c.length() < 2) {
      return;
    }

    char s = c[1];
    if (s == 't') {
      test_bombas();
    } else if (s == 'c') {
      int n = c.substring(2).toInt() - 1;
      if (n >= 0 && n < NUM_BOMBAS) {
        calibrar(n);
      }
    } else if (s == 'l') {
      int sp = c.indexOf(' ', 2);
      if (sp > 0) {
        int n = c.substring(2, sp).toInt() - 1;
        float ml = c.substring(sp + 1).toFloat();
        if (n >= 0 && n < NUM_BOMBAS && ml > 0) {
          guardar_cal(n, ml);
        }
      }
    } else if (s == 'p') {
      int sp = c.indexOf(' ', 2);
      int n;
      int seg = 5;
      if (sp > 0) {
        n = c.substring(2, sp).toInt() - 1;
        seg = c.substring(sp + 1).toInt();
      } else {
        n = c.substring(2).toInt() - 1;
      }
      if (n >= 0 && n < NUM_BOMBAS) {
        primear(n, seg);
      }
    } else {
      int n = c.substring(1).toInt() - 1;
      if (n >= 0 && n < NUM_BOMBAS) {
        dispensar(n, 30);
      }
    }
  } else if (p == 's') {
    if (c[1] == 'c') {
      int ang = c.substring(2).toInt();
      servo_cont_set(ang);
    } else {
      int sp = c.indexOf(' ', 1);
      if (sp > 0) {
        int n = c.substring(1, sp).toInt() - 1;
        int ang = c.substring(sp + 1).toInt();
        if (n >= 0 && n < 3) {
          servo_pos(n, ang);
        }
      }
    }
  } else if (p == 'm') {
    if (c.length() < 2) {
      return;
    }

    char s = c[1];
    if (s == 's') {
      motor_stop();
      Serial.println(F("Motor stop"));
    } else if (s == 'h') {
      home();
    } else if (s == 'r') {
      int n = c.substring(2).toInt();
      if (n > 0) {
        Serial.print(F("Girando "));
        Serial.print(n);
        Serial.println(F(" pasos"));
        motor_steps(n);
        if (!limit_triggered) {
          Serial.println(F("OK"));
        } else {
          Serial.println(F("Limit!"));
          limit_triggered = false;
        }
      }
    } else if (s == 'p') {
      int pos = c.substring(2).toInt();
      mover_a(pos);
    }
  }
}

void help() {
  Serial.println(F("-- MQTT --"));
  Serial.println(F("  estado:   penpito/kraken/state"));
  Serial.println(F("  comando:  penpito/kraken/command"));
  Serial.println(F("  ack:      penpito/kraken/command/ack"));
  Serial.println(F("-- BOMBAS --"));
  Serial.println(F("  bc<n>        calibrar 10s, ej: bc1"));
  Serial.println(F("  bl<n> <ml>   guardar cal, ej: bl1 42"));
  Serial.println(F("  b<n>         dispensar 30ml, ej: b1"));
  Serial.println(F("  bp<n> <s>    prime, ej: bp1 8"));
  Serial.println(F("  bt           test todas 1s"));
  Serial.println(F("-- SERVOS --"));
  Serial.println(F("  s<n> <ang>   servo posicional, ej: s1 90"));
  Serial.println(F("  sc <ang>     servo continuo (0-180), 90=stop"));
  Serial.println(F("-- MOTOR --"));
  Serial.println(F("  mr <steps>   girar N pasos"));
  Serial.println(F("  mh           home"));
  Serial.println(F("  ms           stop emergencia"));
  Serial.println(F("  mp <pos>     ir a posicion absoluta"));
  Serial.println(F("-- GENERAL --"));
  Serial.println(F("  0            apagar todo"));
  Serial.println(F("  ?            ayuda"));
}
