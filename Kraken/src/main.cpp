#include <Arduino.h>
#include <ArduinoJson.h>
#include <ESP32Servo.h>
#include <Preferences.h>
#include <PubSubClient.h>
#include <WiFi.h>
#include <esp_system.h>

// ═══════════════════════════════════════════
//  CONFIGURACIÓN DE RED Y MQTT v2
// ═══════════════════════════════════════════
const char *WIFI_SSID = "Xiaomi 14";
const char *WIFI_PASSWORD = "217646626";
const char *MQTT_HOST = "192.168.243.219";
const int MQTT_PORT = 1883;

// Tópicos v2 (deben coincidir con src/protocol/topics.ts)
const char *TOPIC_CMD    = "penpito/v2/controller/hardware/command";
const char *TOPIC_ACK    = "penpito/v2/hardware/command/ack";
const char *TOPIC_STATE  = "penpito/v2/hardware/state";
const char *TOPIC_EVENT  = "penpito/v2/hardware/event";
const char *TOPIC_PRESENCE = "penpito/v2/hardware/presence";

// CONSTANTES DE CALIBRACIÓN DE LA CUCHARA
const unsigned long TIEMPO_BAJAR_CUCHARA = 3000;
const unsigned long TIEMPO_AGITACION = 5000;
const unsigned long TIEMPO_SUBIR_CUCHARA = 3100;

// ═══════════════════════════════════════════
//  PINOUT (Unificado en 1x ESP32)
// ═══════════════════════════════════════════
const int B_PIN[] = {16, 17, 19, 25, 26, 32, 33};
const int NUM_BOMBAS = 7;

float b_ml_ps[7] = {
    24.7, 23.6, 20.6, 24.3, 23.8, 16.1, 23.6
};
unsigned long pump_stop_time[7] = {0};
unsigned long srv_cont_stop_time = 0;

Servo srv_pos[3];
const int SRV_PIN[] = {22, 23, 27};
Servo srv_cont;
const int SRV_CONT_PIN = 21;
const int SRV_CONT_STOP = 90;
const int SRV_CONT_TRIM = 0;

const int MOTOR_STEP = 18;
const int MOTOR_DIR = 12;
const int MOTOR_ENABLE = 4;
const int LIMIT_SW = 34;
volatile bool limit_triggered = false;

void IRAM_ATTR on_limit() {
  if (digitalRead(LIMIT_SW) == HIGH) {
    limit_triggered = true;
  }
}

int POS_CUP = 3600;
int POS_ICE = 2600;
int POS_LIQUID = 2400;
int POS_STIR = 800;
int POS_READY = 100;
int POS_PUMP_1_2 = 1860;
int POS_PUMP_3_4 = 1600;
int POS_PUMP_5_6 = 1350;
int POS_PUMP_7 = 1200;

// ═══════════════════════════════════════════
//  ESTADOS DE LA MÁQUINA
// ═══════════════════════════════════════════
enum MachineStatus { STATUS_IDLE, STATUS_PREPARING, STATUS_CLEANING, STATUS_ERROR };
enum PreparationStep {
  STEP_NONE = -1,
  STEP_CUP_DISPENSER,
  STEP_ICE_DISPENSER,
  STEP_ALCOHOL_DISPENSER,
  STEP_AGITATION_SYSTEM,
  STEP_CARBONATED_STATION,
  STEP_READY
};

MachineStatus status = STATUS_IDLE;
PreparationStep activeStep = STEP_NONE;
String errorMessage = "";
bool isOn = true;
bool isDrinkReady = false;
bool skipIce = false;
bool skipAgitation = false;
bool skipCarbonation = false;
int requestedIceCount = 2;

float customAlcoholOz = 0;
float customMixerOz = 0;

// ═══════════════════════════════════════════
//  CONTEXTO DEL PEDIDO ACTIVO (v2)
// ═══════════════════════════════════════════
struct ActiveOrder {
  bool valid = false;
  String orderId;
  int tableId = 0;
  String commandId;
  String recipeId;
  int sequence = 0;
  unsigned long startedAt = 0;
  unsigned long publishedStepAt = 0;
  unsigned long lastHeartbeat = 0;
};

ActiveOrder currentOrder;

bool pendingPrepare = false;
String pendingRecipeId = "";
int pendingIceCount = 0;
float pendingAlcoholOz = 0.0;
float pendingMixerOz = 0.0;

bool step_in_progress = false;
unsigned long step_timer = 0;
bool waiting_for_pumps = false;
int ice_cycle_count = 0;
int ice_cycle_state = 0;
int stir_state = 0;

struct DispenseItem {
  int pumpIdx;
  int position;
  unsigned long durationMs;
};
DispenseItem itemsToDispense[4];
int totalDispenseItems = 0;
int currentDispenseItemIdx = 0;
int dispenseSubState = 0;
unsigned long dispenseTimer = 0;
int stir_shake_count = 0;

WiFiClient espClient;
PubSubClient client(espClient);
Preferences preferences;
unsigned long last_state_publish = 0;
unsigned long last_reconnect_attempt = 0;
unsigned long boot_at_ms = 0;
unsigned long state_sequence = 0;

struct CachedRequest {
  String id;
  bool ok;
  String errorMessage;
  int activeOrderTable;
  String activeOrderId;
  bool hasActiveOrder;
};
CachedRequest lastRequests[10];

bool in_mqtt_callback = false;

bool is_motor_moving = false;
int motor_target_steps = 0;
int motor_step_dir = 0;
unsigned long next_motor_step_micros = 0;
bool motor_starting_from_limit = false;
int motor_steps_done = 0;
bool motor_move_error = false;

bool is_homing = false;
int home_substate = 0;
unsigned long next_home_step_micros = 0;
int home_steps_taken = 0;

bool pendingClean = false;
bool pendingTest = false;
String pendingTestType = "";
int pendingTestVal = 0;
int pendingTestPin = 0;
int pendingTestDuration = 0;

void smartDelay(unsigned long ms);
void cacheRequestResult(const String &id, bool ok, const String &errorMsg,
                        int activeTable, const String &activeOrderId, bool hasActive);
int getCachedRequestIdx(const String &id);
void setupHardware();
void setupWifi();
void reconnect();
void mqttCallback(char *topic, byte *payload, unsigned int length);
void publishState();
void publishEvent(const char *type, const char *reason = nullptr, const char *failureCode = nullptr);
void updateMachineState();
void startPreparation(const String &recipeId, int iceCount, float alcOz, float mixOz,
                      const String &orderId, int tableId, const String &commandId);
void startCleaning();
void resetPreparationState();
void stopAllHardware();
void servo_pos(int n, int ang);
void servo_cont_set(int vel);
void motor_stop();
void motor_step();
bool is_limit_pressed();
bool motor_steps(int n);
bool home();
bool mover_a(int target);
void serviceMotorMovement();
void serviceHomeMovement();
void wait_motor_done();
void executeTestHardware(const String &type, int val, int pin, int duration);
void handleMovementError(const String &msg);

const char *statusToString();
const char *stepToString(PreparationStep step);
PreparationStep nextStepAfter(PreparationStep step);
bool recipeNeedsAgitation(const String &recipeId);
bool recipeNeedsCarbonation(const String &recipeId);

// ═══════════════════════════════════════════
//  SETUP & LOOP
// ═══════════════════════════════════════════
void setup() {
  Serial.begin(115200);
  boot_at_ms = millis();
  setupHardware();
  setupWifi();

  client.setServer(MQTT_HOST, MQTT_PORT);
  client.setBufferSize(1024);
  client.setCallback(mqttCallback);

  Serial.println("Kraken v2 listo.");
}

void loop() {
  if (WiFi.status() == WL_CONNECTED) {
    if (!client.connected()) {
      unsigned long now = millis();
      if (now - last_reconnect_attempt > 5000) {
        last_reconnect_attempt = now;
        if (client.connect("PenpitoKrakenDeviceV2", nullptr, nullptr,
                           TOPIC_PRESENCE, 1, true, "offline")) {
          client.subscribe(TOPIC_CMD, 1);
          client.publish(TOPIC_PRESENCE, "online", true);
          Serial.println("MQTT v2 Conectado.");
          publishState();
          // Si hay un pedido en curso, republish event PREPARATION_STARTED para re-sincronizar.
          if (currentOrder.valid && status == STATUS_PREPARING) {
            publishEvent("PREPARATION_STARTED");
          }
        }
      }
    } else {
      client.loop();
      // Heartbeat de progreso cada 5s durante preparación.
      if (currentOrder.valid && status == STATUS_PREPARING) {
        unsigned long now = millis();
        if (now - currentOrder.lastHeartbeat > 5000) {
          currentOrder.lastHeartbeat = now;
          publishEvent("PREPARATION_PROGRESS");
        }
      }
    }
  } else {
    static unsigned long last_wifi_reconnect_attempt = 0;
    unsigned long now = millis();
    if (now - last_wifi_reconnect_attempt > 10000) {
      last_wifi_reconnect_attempt = now;
      Serial.println("Wi-Fi desconectado. Reintentando conexion...");
      WiFi.disconnect();
      WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    }
  }

  unsigned long now = millis();
  for (int i = 0; i < NUM_BOMBAS; i++) {
    if (pump_stop_time[i] > 0) {
      if (!isOn || now >= pump_stop_time[i]) {
        digitalWrite(B_PIN[i], LOW);
        pump_stop_time[i] = 0;
      }
    }
  }

  if (status == STATUS_CLEANING) {
    bool any_pump_running = false;
    for (int i = 0; i < NUM_BOMBAS; i++) {
      if (pump_stop_time[i] > 0) any_pump_running = true;
    }
    if (!any_pump_running) {
      status = STATUS_IDLE;
      publishState();
    }
  }

  if (srv_cont_stop_time > 0) {
    if (!isOn || now >= srv_cont_stop_time) {
      servo_cont_set(0);
      srv_cont_stop_time = 0;
    }
  }

  serviceMotorMovement();
  serviceHomeMovement();

  if (pendingPrepare) {
    pendingPrepare = false;
    startPreparation(pendingRecipeId, pendingIceCount, pendingAlcoholOz,
                     pendingMixerOz, currentOrder.orderId, currentOrder.tableId,
                     currentOrder.commandId);
  }

  if (pendingClean) {
    pendingClean = false;
    startCleaning();
  }

  if (pendingTest) {
    pendingTest = false;
    executeTestHardware(pendingTestType, pendingTestVal, pendingTestPin,
                        pendingTestDuration);
  }

  updateMachineState();

  if (status == STATUS_IDLE && now - last_state_publish > 3000) {
    publishState();
  }
}

void setupHardware() {
  for (int i = 0; i < NUM_BOMBAS; i++) {
    pinMode(B_PIN[i], OUTPUT);
    digitalWrite(B_PIN[i], LOW);
  }

  srv_pos[0].setPeriodHertz(50);
  srv_pos[0].attach(SRV_PIN[0], 500, 2400);
  srv_pos[0].write(0);

  srv_pos[1].setPeriodHertz(50);
  srv_pos[1].attach(SRV_PIN[1], 500, 2400);
  srv_pos[1].write(180);

  srv_pos[2].setPeriodHertz(50);
  srv_pos[2].attach(SRV_PIN[2], 500, 2400);
  srv_pos[2].write(180);

  srv_cont.setPeriodHertz(50);
  srv_cont.attach(SRV_CONT_PIN, 500, 2400);
  srv_cont.write(90);

  pinMode(MOTOR_STEP, OUTPUT);
  digitalWrite(MOTOR_STEP, LOW);
  pinMode(MOTOR_DIR, OUTPUT);
  digitalWrite(MOTOR_DIR, LOW);
  pinMode(MOTOR_ENABLE, OUTPUT);
  digitalWrite(MOTOR_ENABLE, HIGH);

  pinMode(LIMIT_SW, INPUT);
  attachInterrupt(digitalPinToInterrupt(LIMIT_SW), on_limit, RISING);

  preferences.begin("kraken", false);
  POS_CUP = preferences.getInt("pos_cup", 3600);
  POS_ICE = preferences.getInt("pos_ice", 2600);
  POS_STIR = preferences.getInt("pos_stir", 800);
  POS_READY = preferences.getInt("pos_ready", 100);

  POS_PUMP_1_2 = preferences.getInt("pos_p12", 1860);
  POS_PUMP_3_4 = preferences.getInt("pos_p34", 1600);
  POS_PUMP_5_6 = preferences.getInt("pos_p56", 1350);
  POS_PUMP_7 = preferences.getInt("pos_p7", 1200);

  for (int i = 0; i < 7; i++) {
    String key = "b_ml_" + String(i);
    b_ml_ps[i] = preferences.getFloat(key.c_str(), b_ml_ps[i]);
    if (b_ml_ps[i] < 0.5) b_ml_ps[i] = 15.0;
  }
  preferences.end();
  Serial.println("Calibraciones inicializadas desde Flash (NVS).");
}

void setupWifi() {
  delay(10);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  int retry = 0;
  while (WiFi.status() != WL_CONNECTED && retry < 15) {
    delay(500);
    retry++;
  }
}

void smartDelay(unsigned long ms) {
  unsigned long start = millis();
  while (millis() - start < ms) {
    if (!in_mqtt_callback && client.connected()) {
      client.loop();
    }
    if (in_mqtt_callback && !isOn) break;
    delay(5);
  }
}

void cacheRequestResult(const String &id, bool ok, const String &errorMsg,
                        int activeTable, const String &activeOrderId, bool hasActive) {
  if (id.length() == 0) return;
  static int idx = 0;
  lastRequests[idx] = {id, ok, errorMsg, activeTable, activeOrderId, hasActive};
  idx = (idx + 1) % 10;
}

int getCachedRequestIdx(const String &id) {
  if (id.length() == 0) return -1;
  for (int i = 0; i < 10; i++) {
    if (lastRequests[i].id == id) return i;
  }
  return -1;
}

void servo_pos(int n, int ang) {
  ang = constrain(ang, 0, 180);
  srv_pos[n].write(ang);
}

void servo_cont_set(int vel) {
  int speed = constrain(vel, -100, 100);
  int pulse = SRV_CONT_STOP + SRV_CONT_TRIM + map(speed, -100, 100, -90, 90);
  pulse = constrain(pulse, 0, 180);
  srv_cont.write(pulse);
}

void motor_stop() {
  digitalWrite(MOTOR_STEP, LOW);
  digitalWrite(MOTOR_ENABLE, HIGH);
}

void motor_step() {
  digitalWrite(MOTOR_STEP, HIGH);
  delayMicroseconds(5);
  digitalWrite(MOTOR_STEP, LOW);
  delayMicroseconds(3000);
}

bool is_limit_pressed() {
  if (digitalRead(LIMIT_SW) == HIGH) {
    delayMicroseconds(50);
    return digitalRead(LIMIT_SW) == HIGH;
  }
  return false;
}

int motor_pos = 0;

void serviceMotorMovement() {
  if (!is_motor_moving) return;
  if (!isOn) {
    is_motor_moving = false;
    motor_stop();
    motor_move_error = true;
    return;
  }
  unsigned long now_u = micros();
  if (now_u < next_motor_step_micros) return;

  if (motor_step_dir < 0 && motor_pos < 300 && (limit_triggered || is_limit_pressed())) {
    is_motor_moving = false;
    motor_stop();
    limit_triggered = false;
    return;
  }

  digitalWrite(MOTOR_STEP, HIGH);
  delayMicroseconds(5);
  digitalWrite(MOTOR_STEP, LOW);
  motor_pos += motor_step_dir;
  motor_steps_done++;
  next_motor_step_micros = micros() + 3000;

  if (motor_steps_done >= motor_target_steps) {
    if (motor_starting_from_limit && is_limit_pressed()) {
      is_motor_moving = false;
      motor_stop();
      motor_move_error = true;
      return;
    }
    is_motor_moving = false;
    motor_stop();
    if (status == STATUS_PREPARING && step_in_progress) {
      step_timer = millis() + 500;
    }
  }
}

void serviceHomeMovement() {
  if (!is_homing) return;
  if (!isOn) {
    is_homing = false;
    motor_stop();
    return;
  }
  unsigned long now_u = micros();
  if (now_u < next_home_step_micros) return;

  if (home_substate == 1) {
    digitalWrite(MOTOR_STEP, HIGH);
    delayMicroseconds(5);
    digitalWrite(MOTOR_STEP, LOW);
    home_steps_taken++;
    next_home_step_micros = micros() + 3000;

    if (!is_limit_pressed() || home_steps_taken >= 500) {
      home_substate = 2;
      home_steps_taken = 0;
      digitalWrite(MOTOR_DIR, LOW);
      next_home_step_micros = micros() + 100000;
    }
  } else if (home_substate == 2) {
    if (limit_triggered || is_limit_pressed()) {
      digitalWrite(MOTOR_STEP, LOW);
      motor_pos = 0;
      limit_triggered = false;
      is_homing = false;
      home_substate = 0;
      motor_stop();
      if (status == STATUS_PREPARING && step_in_progress) {
        step_timer = millis() + 500;
      }
      return;
    }

    digitalWrite(MOTOR_STEP, HIGH);
    delayMicroseconds(5);
    digitalWrite(MOTOR_STEP, LOW);
    home_steps_taken++;
    next_home_step_micros = micros() + 3000;

    if (home_steps_taken > 6000) {
      is_homing = false;
      home_substate = 0;
      motor_stop();
      motor_move_error = true;
    }
  }
}

void wait_motor_done() {
  while (is_motor_moving || is_homing) {
    if (!isOn) {
      motor_stop();
      is_motor_moving = false;
      is_homing = false;
      break;
    }
    serviceMotorMovement();
    serviceHomeMovement();
    delay(1);
  }
}

bool motor_steps(int n) {
  if (n == 0) return true;
  digitalWrite(MOTOR_DIR, (n > 0) ? HIGH : LOW);
  digitalWrite(MOTOR_ENABLE, LOW);
  delayMicroseconds(10);
  is_motor_moving = true;
  motor_target_steps = abs(n);
  motor_step_dir = (n > 0) ? 1 : -1;
  motor_steps_done = 0;
  motor_move_error = false;
  motor_starting_from_limit = is_limit_pressed() && (n > 0);
  next_motor_step_micros = micros() + 10;
  return true;
}

bool home() {
  limit_triggered = false;
  is_homing = true;
  home_steps_taken = 0;
  motor_move_error = false;
  if (is_limit_pressed()) {
    home_substate = 1;
    digitalWrite(MOTOR_DIR, HIGH);
  } else {
    home_substate = 2;
    digitalWrite(MOTOR_DIR, LOW);
  }
  digitalWrite(MOTOR_ENABLE, LOW);
  next_home_step_micros = micros() + 10;
  if (status != STATUS_PREPARING) {
    wait_motor_done();
    return !motor_move_error && !is_limit_pressed();
  }
  return true;
}

bool mover_a(int target) {
  int diff = target - motor_pos;
  bool res = motor_steps(diff);
  if (status != STATUS_PREPARING) {
    wait_motor_done();
    return res && !motor_move_error;
  }
  return res;
}

void updateMachineState() {
  if (status != STATUS_PREPARING) return;
  if (is_motor_moving || is_homing) return;
  if (motor_move_error) {
    motor_move_error = false;
    handleMovementError("Fallo en movimiento del motor");
    return;
  }

  unsigned long now = millis();

  if (!step_in_progress) {
    step_in_progress = true;
    publishEvent("PREPARATION_PROGRESS");
    switch (activeStep) {
      case STEP_CUP_DISPENSER:
        if (!mover_a(POS_CUP)) { handleMovementError("Fallo motor al mover a vaso"); return; }
        step_timer = now + 1000;
        break;
      case STEP_ICE_DISPENSER:
        if (!mover_a(POS_ICE)) { handleMovementError("Fallo motor al mover a hielo"); return; }
        ice_cycle_count = 0;
        ice_cycle_state = 0;
        step_timer = now;
        break;
      case STEP_ALCOHOL_DISPENSER: {
        waiting_for_pumps = true;
        totalDispenseItems = 0;
        currentDispenseItemIdx = 0;
        dispenseSubState = 0;

        float ml_pisco = 90.0;
        float ml_cola = 150.0;
        if (customAlcoholOz > 0) ml_pisco = customAlcoholOz * 30.0;
        if (customMixerOz > 0) ml_cola = customMixerOz * 30.0;

        if (currentOrder.recipeId == "piscola") {
          itemsToDispense[totalDispenseItems++] = {0, POS_PUMP_1_2, (unsigned long)((ml_pisco / b_ml_ps[0]) * 1000)};
          itemsToDispense[totalDispenseItems++] = {3, POS_PUMP_3_4, (unsigned long)((ml_cola / b_ml_ps[3]) * 1000)};
        } else if (currentOrder.recipeId == "negroni") {
          float ml_gin = (customAlcoholOz > 0) ? customAlcoholOz * 30.0 : 75.0;
          float ml_campari = 75.0;
          float ml_vermut = (customMixerOz > 0) ? customMixerOz * 30.0 : 75.0;
          itemsToDispense[totalDispenseItems++] = {2, POS_PUMP_3_4, (unsigned long)((ml_gin / b_ml_ps[2]) * 1000)};
          itemsToDispense[totalDispenseItems++] = {4, POS_PUMP_5_6, (unsigned long)((ml_vermut / b_ml_ps[4]) * 1000)};
          itemsToDispense[totalDispenseItems++] = {6, POS_PUMP_7, (unsigned long)((ml_campari / b_ml_ps[6]) * 1000)};
        } else if (currentOrder.recipeId == "boulevardier") {
          float ml_whisky = (customAlcoholOz > 0) ? customAlcoholOz * 30.0 : 75.0;
          float ml_campari = 75.0;
          float ml_vermut = (customMixerOz > 0) ? customMixerOz * 30.0 : 75.0;
          itemsToDispense[totalDispenseItems++] = {5, POS_PUMP_5_6, (unsigned long)((ml_whisky / b_ml_ps[5]) * 1000)};
          itemsToDispense[totalDispenseItems++] = {4, POS_PUMP_5_6, (unsigned long)((ml_vermut / b_ml_ps[4]) * 1000)};
          itemsToDispense[totalDispenseItems++] = {6, POS_PUMP_7, (unsigned long)((ml_campari / b_ml_ps[6]) * 1000)};
        } else if (currentOrder.recipeId == "godfather") {
          float ml_whisky = (customAlcoholOz > 0) ? customAlcoholOz * 30.0 : 150.0;
          float ml_amaretto = (customMixerOz > 0) ? customMixerOz * 30.0 : 75.0;
          itemsToDispense[totalDispenseItems++] = {5, POS_PUMP_5_6, (unsigned long)((ml_whisky / b_ml_ps[5]) * 1000)};
          itemsToDispense[totalDispenseItems++] = {1, POS_PUMP_1_2, (unsigned long)((ml_amaretto / b_ml_ps[1]) * 1000)};
        } else if (currentOrder.recipeId == "americano") {
          float ml_campari = (customAlcoholOz > 0) ? customAlcoholOz * 30.0 : 100.0;
          float ml_vermut = (customMixerOz > 0) ? customMixerOz * 30.0 : 100.0;
          itemsToDispense[totalDispenseItems++] = {4, POS_PUMP_5_6, (unsigned long)((ml_vermut / b_ml_ps[4]) * 1000)};
          itemsToDispense[totalDispenseItems++] = {6, POS_PUMP_7, (unsigned long)((ml_campari / b_ml_ps[6]) * 1000)};
        } else if (currentOrder.recipeId == "whisky_rocks") {
          float ml_whisky = (customAlcoholOz > 0) ? customAlcoholOz * 30.0 : 180.0;
          itemsToDispense[totalDispenseItems++] = {5, POS_PUMP_5_6, (unsigned long)((ml_whisky / b_ml_ps[5]) * 1000)};
        } else if (currentOrder.recipeId == "campari_rocks") {
          float ml_campari = (customAlcoholOz > 0) ? customAlcoholOz * 30.0 : 180.0;
          itemsToDispense[totalDispenseItems++] = {6, POS_PUMP_7, (unsigned long)((ml_campari / b_ml_ps[6]) * 1000)};
        }

        if (totalDispenseItems == 0) {
          step_in_progress = false;
          activeStep = nextStepAfter(activeStep);
          publishState();
          return;
        }
        if (!mover_a(itemsToDispense[0].position)) { handleMovementError("Fallo motor al mover a primer alcohol"); return; }
        step_timer = now;
        break;
      }
      case STEP_AGITATION_SYSTEM:
        if (!mover_a(POS_STIR)) { handleMovementError("Fallo motor al mover a mezcla"); return; }
        stir_state = 0;
        step_timer = now;
        break;
      case STEP_CARBONATED_STATION:
        step_timer = now + 1200;
        break;
      case STEP_READY:
        if (!home()) { handleMovementError("Fallo motor al retornar a home final"); return; }
        step_timer = now + 500;
        break;
      default:
        step_in_progress = false;
        break;
    }
    publishState();
    return;
  }

  switch (activeStep) {
    case STEP_CUP_DISPENSER:
      if (now >= step_timer) {
        servo_pos(0, 180);
        smartDelay(1200);
        servo_pos(0, 0);
        smartDelay(500);
        step_in_progress = false;
        activeStep = nextStepAfter(activeStep);
        publishState();
      }
      break;
    case STEP_ICE_DISPENSER:
      if (now >= step_timer) {
        if (ice_cycle_count < requestedIceCount) {
          if (ice_cycle_state == 0) {
            servo_pos(1, 0);
            step_timer = now + 1000;
            ice_cycle_state = 1;
          } else if (ice_cycle_state == 1) {
            servo_pos(1, 180);
            step_timer = now + 1000;
            ice_cycle_count++;
            ice_cycle_state = 0;
          }
        } else {
          step_in_progress = false;
          activeStep = nextStepAfter(activeStep);
          publishState();
        }
      }
      break;
    case STEP_ALCOHOL_DISPENSER:
      if (currentDispenseItemIdx < totalDispenseItems) {
        if (dispenseSubState == 0) {
          if (now >= step_timer) {
            int pIdx = itemsToDispense[currentDispenseItemIdx].pumpIdx;
            unsigned long duration = itemsToDispense[currentDispenseItemIdx].durationMs;
            digitalWrite(B_PIN[pIdx], HIGH);
            dispenseTimer = now + duration;
            dispenseSubState = 1;
          }
        } else if (dispenseSubState == 1) {
          if (now >= dispenseTimer) {
            int pIdx = itemsToDispense[currentDispenseItemIdx].pumpIdx;
            digitalWrite(B_PIN[pIdx], LOW);
            dispenseTimer = now + 1500;
            dispenseSubState = 2;
          }
        } else if (dispenseSubState == 2) {
          if (now >= dispenseTimer) {
            currentDispenseItemIdx++;
            if (currentDispenseItemIdx < totalDispenseItems) {
              int nextPos = itemsToDispense[currentDispenseItemIdx].position;
              if (!mover_a(nextPos)) { handleMovementError("Fallo motor al siguiente alcohol"); return; }
              step_timer = now;
              dispenseSubState = 0;
            } else {
              step_in_progress = false;
              activeStep = nextStepAfter(activeStep);
              publishState();
            }
          }
        }
      } else {
        step_in_progress = false;
        activeStep = nextStepAfter(activeStep);
        publishState();
      }
      break;
    case STEP_AGITATION_SYSTEM:
      if (now >= step_timer) {
        if (stir_state == 0) {
          servo_cont_set(100);
          step_timer = now + 1800;
          stir_state = 1;
        } else if (stir_state == 1) {
          stir_shake_count = 0;
          servo_cont_set(-100);
          step_timer = now + 600;
          stir_state = 2;
        } else if (stir_state == 2) {
          servo_cont_set(100);
          step_timer = now + 600;
          stir_state = 3;
        } else if (stir_state == 3) {
          stir_shake_count++;
          if (stir_shake_count < 6) {
            servo_cont_set(-100);
            step_timer = now + 600;
            stir_state = 2;
          } else {
            servo_cont_set(-100);
            step_timer = now + 1800;
            stir_state = 4;
          }
        } else if (stir_state == 4) {
          servo_cont_set(0);
          step_in_progress = false;
          activeStep = nextStepAfter(activeStep);
          publishState();
        }
      }
      break;
    case STEP_CARBONATED_STATION:
      if (now >= step_timer) {
        step_in_progress = false;
        activeStep = nextStepAfter(activeStep);
        publishState();
      }
      break;
    case STEP_READY:
      if (now >= step_timer) {
        isDrinkReady = true;
        status = STATUS_IDLE;
        step_in_progress = false;
        activeStep = STEP_NONE;
        motor_stop();
        // ÚNICA señal que cuenta como listo: PREPARATION_COMPLETED.
        publishEvent("PREPARATION_COMPLETED");
        publishState();
      }
      break;
    default:
      break;
  }
}

void startPreparation(const String &recipeId, int iceCount, float alcOz, float mixOz,
                      const String &orderId, int tableId, const String &commandId) {
  Serial.println("Preparando trago: Ejecutando Home...");
  if (!home()) {
    status = STATUS_ERROR;
    errorMessage = "Fallo en calibracion Home";
    publishEvent("PREPARATION_FAILED", errorMessage.c_str(), "home_failed");
    publishState();
    return;
  }

  currentOrder.orderId = orderId;
  currentOrder.tableId = tableId;
  currentOrder.commandId = commandId;
  currentOrder.recipeId = recipeId;
  currentOrder.valid = true;
  currentOrder.startedAt = millis();
  currentOrder.lastHeartbeat = millis();
  currentOrder.sequence++;

  requestedIceCount = max(0, iceCount);
  customAlcoholOz = alcOz;
  customMixerOz = mixOz;

  skipIce = requestedIceCount == 0;
  skipAgitation = !recipeNeedsAgitation(recipeId);
  skipCarbonation = !recipeNeedsCarbonation(recipeId);

  isDrinkReady = false;
  errorMessage = "";
  status = STATUS_PREPARING;
  activeStep = nextStepAfter(STEP_NONE);
  step_in_progress = false;

  publishEvent("PREPARATION_STARTED");
  publishState();
}

void startCleaning() {
  status = STATUS_CLEANING;
  activeStep = STEP_NONE;
  isDrinkReady = false;
  errorMessage = "";
  for (int i = 0; i < NUM_BOMBAS; i++) {
    digitalWrite(B_PIN[i], HIGH);
    pump_stop_time[i] = millis() + 4000;
  }
}

void stopAllHardware() {
  for (int i = 0; i < NUM_BOMBAS; i++) {
    digitalWrite(B_PIN[i], LOW);
    pump_stop_time[i] = 0;
  }
  servo_cont_set(0);
  srv_cont_stop_time = 0;
  motor_stop();
}

void resetPreparationState() {
  status = STATUS_IDLE;
  activeStep = STEP_NONE;
  requestedIceCount = 2;
  customAlcoholOz = 0;
  customMixerOz = 0;
  skipIce = false;
  skipAgitation = false;
  skipCarbonation = false;
  isDrinkReady = false;
  step_in_progress = false;
  waiting_for_pumps = false;
  stir_state = 0;
  currentOrder.valid = false;
  currentOrder.orderId = "";
  currentOrder.tableId = 0;
  currentOrder.commandId = "";
  stopAllHardware();
}

void handleMovementError(const String &msg) {
  status = STATUS_ERROR;
  errorMessage = msg;
  stopAllHardware();
  publishEvent("PREPARATION_FAILED", msg.c_str(), "mechanical_error");
  publishState();
}

void mqttCallback(char *topic, byte *payload, unsigned int length) {
  String message = "";
  for (unsigned int i = 0; i < length; i++) message += (char)payload[i];
  Serial.print("v2 CMD: "); Serial.println(message);

  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, message);
  if (err) {
    Serial.println("Error parseando JSON");
    return;
  }

  String cmd = doc["type"] | doc["cmd"] | "";
  String commandId = doc["commandId"] | "";
  in_mqtt_callback = true;

  // Idempotencia por commandId.
  int dupIdx = getCachedRequestIdx(commandId);
  if (dupIdx >= 0 && cmd != "PREPARE") {
    // Replay con el mismo resultado cacheado (no comandos críticos de movimiento).
    JsonDocument ackDoc;
    ackDoc["protocolVersion"] = 2;
    ackDoc["commandId"] = commandId;
    ackDoc["accepted"] = lastRequests[dupIdx].ok;
    ackDoc["timestamp"] = millis();
    if (!lastRequests[dupIdx].ok) {
      ackDoc["failureCode"] = lastRequests[dupIdx].errorMessage;
      ackDoc["reason"] = lastRequests[dupIdx].errorMessage;
    }
    String ackBody;
    serializeJson(ackDoc, ackBody);
    client.publish(TOPIC_ACK, ackBody.c_str(), false);
    in_mqtt_callback = false;
    return;
  }

  bool ok = false;
  String reason = "";
  String failureCode = "";

  if (cmd == "EMERGENCY_STOP" || (cmd == "POWER" && String(doc["payload"]["val"] | "ON") == "OFF")) {
    isOn = false;
    if (currentOrder.valid) {
      failureCode = "emergency_stop";
      reason = "machine_powered_off";
      currentOrder.valid = false;
    }
    resetPreparationState();
    status = STATUS_IDLE;
    ok = true;
  } else if (cmd == "POWER") {
    isOn = true;
    if (status == STATUS_ERROR) {
      resetPreparationState();
    }
    ok = true;
  } else if (!isOn) {
    reason = "Comando rechazado: Maquina apagada";
    failureCode = "machine_offline";
  } else if (cmd == "PREPARE") {
    String orderId = doc["orderId"] | "";
    int tableId = doc["tableId"] | 0;
    if (status != STATUS_IDLE || isDrinkReady) {
      reason = "Maquina ocupada";
      failureCode = "machine_busy";
    } else if (orderId.length() == 0) {
      reason = "Falta orderId";
      failureCode = "machine_rejected";
    } else {
      // Extraer payload.
      JsonObject pl = doc["payload"].as<JsonObject>();
      pendingRecipeId = pl["recipeId"] | "";
      pendingIceCount = pl["iceCount"] | 2;
      pendingAlcoholOz = pl["alcoholOz"] | 0.0;
      pendingMixerOz = pl["mixerOz"] | 0.0;
      currentOrder.orderId = orderId;
      currentOrder.tableId = tableId;
      currentOrder.commandId = commandId;
      currentOrder.valid = true;
      currentOrder.sequence = 0;
      pendingPrepare = true;
      ok = true;
    }
  } else if (cmd == "TAKEN") {
    isDrinkReady = false;
    currentOrder.valid = false;
    currentOrder.orderId = "";
    currentOrder.tableId = 0;
    currentOrder.commandId = "";
    ok = true;
    publishState();
  } else if (cmd == "CLEAN") {
    if (status != STATUS_IDLE) {
      reason = "Maquina ocupada";
      failureCode = "machine_busy";
    } else {
      pendingClean = true;
      status = STATUS_CLEANING;
      ok = true;
    }
  } else if (cmd == "SET_CALIB") {
    if (status != STATUS_IDLE) {
      reason = "Maquina ocupada";
      failureCode = "machine_busy";
    } else {
      preferences.begin("kraken", false);
      if (doc["payload"]["rates"].is<JsonArray>()) {
        JsonArray rates = doc["payload"]["rates"].as<JsonArray>();
        for (int i = 0; i < 7; i++) {
          if (!rates[i].isNull()) {
            b_ml_ps[i] = rates[i].as<float>();
            if (b_ml_ps[i] < 0.5) b_ml_ps[i] = 15.0;
            String key = "b_ml_" + String(i);
            preferences.putFloat(key.c_str(), b_ml_ps[i]);
          }
        }
      }
      if (doc["payload"]["positions"].is<JsonArray>()) {
        JsonArray positions = doc["payload"]["positions"].as<JsonArray>();
        if (positions.size() >= 8) {
          POS_CUP = positions[0].as<int>();
          POS_ICE = positions[1].as<int>();
          POS_STIR = positions[2].as<int>();
          POS_READY = positions[3].as<int>();
          POS_PUMP_1_2 = positions[4].as<int>();
          POS_PUMP_3_4 = positions[5].as<int>();
          POS_PUMP_5_6 = positions[6].as<int>();
          POS_PUMP_7 = positions[7].as<int>();
          preferences.putInt("pos_cup", POS_CUP);
          preferences.putInt("pos_ice", POS_ICE);
          preferences.putInt("pos_stir", POS_STIR);
          preferences.putInt("pos_ready", POS_READY);
          preferences.putInt("pos_p12", POS_PUMP_1_2);
          preferences.putInt("pos_p34", POS_PUMP_3_4);
          preferences.putInt("pos_p56", POS_PUMP_5_6);
          preferences.putInt("pos_p7", POS_PUMP_7);
        }
      }
      preferences.end();
      ok = true;
    }
  } else if (cmd == "TEST_HW") {
    if (status != STATUS_IDLE) {
      reason = "Maquina ocupada";
      failureCode = "machine_busy";
    } else {
      JsonObject pl = doc["payload"].as<JsonObject>();
      pendingTestType = pl["type"] | "";
      pendingTestVal = pl["val"] | 0;
      pendingTestPin = pl["pin"] | 1;
      pendingTestDuration = pl["duration"] | 3000;
      pendingTest = true;
      ok = true;
    }
  } else {
    reason = "Comando desconocido";
    failureCode = "machine_rejected";
  }

  JsonDocument ackDoc;
  ackDoc["protocolVersion"] = 2;
  ackDoc["commandId"] = commandId;
  ackDoc["accepted"] = ok;
  ackDoc["timestamp"] = millis();
  if (!ok) {
    ackDoc["reason"] = reason;
    ackDoc["failureCode"] = failureCode;
  }
  ackDoc["activeOrderId"] = currentOrder.valid ? currentOrder.orderId : (const char*)nullptr;
  ackDoc["activeTableId"] = currentOrder.valid ? currentOrder.tableId : 0;

  String ackBody;
  serializeJson(ackDoc, ackBody);
  client.publish(TOPIC_ACK, ackBody.c_str(), false);
  cacheRequestResult(commandId, ok, reason, currentOrder.tableId, currentOrder.orderId, currentOrder.valid);
  in_mqtt_callback = false;

  // Si aceptamos un PREPARE, publicamos HARDWARE_ACCEPTED para arrancar la máquina de estados.
  if (ok && cmd == "PREPARE") {
    publishEvent("HARDWARE_ACCEPTED");
  }
  publishState();
}

void publishState() {
  state_sequence++;
  JsonDocument stateDoc;
  stateDoc["protocolVersion"] = 2;
  stateDoc["bootId"] = String((uint32_t)(boot_at_ms & 0xFFFFFFFF), 16);
  stateDoc["isOn"] = isOn;
  stateDoc["status"] = statusToString();
  stateDoc["errorMessage"] = errorMessage.length() ? errorMessage.c_str() : (const char*)nullptr;
  stateDoc["activeOrderId"] = currentOrder.valid ? currentOrder.orderId.c_str() : (const char*)nullptr;
  stateDoc["activeTableId"] = currentOrder.valid ? currentOrder.tableId : 0;
  stateDoc["activeCommandId"] = currentOrder.valid ? currentOrder.commandId.c_str() : (const char*)nullptr;
  stateDoc["stateSequence"] = (uint32_t)state_sequence;
  stateDoc["activeStepId"] = activeStep == STEP_NONE ? (const char*)nullptr : stepToString(activeStep);
  stateDoc["requestedIceCount"] = requestedIceCount;
  stateDoc["isDrinkReady"] = isDrinkReady;
  stateDoc["uptimeMs"] = (uint32_t)(millis() - boot_at_ms);
  stateDoc["startedAt"] = currentOrder.valid ? (uint32_t)currentOrder.startedAt : 0;

  JsonArray completed = stateDoc["completedStepIds"].to<JsonArray>();
  for (int index = 0; index < activeStep && activeStep != STEP_NONE; index += 1) {
    PreparationStep step = static_cast<PreparationStep>(index);
    if ((step == STEP_ICE_DISPENSER && skipIce) ||
        (step == STEP_AGITATION_SYSTEM && skipAgitation) ||
        (step == STEP_CARBONATED_STATION && skipCarbonation)) {
      continue;
    }
    completed.add(stepToString(step));
  }

  JsonArray skipped = stateDoc["skippedStepIds"].to<JsonArray>();
  if (skipIce) skipped.add("ice_dispenser");
  if (skipAgitation) skipped.add("agitation_system");
  if (skipCarbonation) skipped.add("carbonated_station");

  String body;
  serializeJson(stateDoc, body);
  client.publish(TOPIC_STATE, body.c_str(), true);

  last_state_publish = millis();
}

void publishEvent(const char *type, const char *reason, const char *failureCode) {
  if (!currentOrder.valid) {
    // Eventos sin orderId activo no se publican. El controller los descartaría.
    return;
  }
  JsonDocument eventDoc;
  eventDoc["protocolVersion"] = 2;
  eventDoc["type"] = type;
  eventDoc["orderId"] = currentOrder.orderId;
  eventDoc["tableId"] = currentOrder.tableId;
  eventDoc["commandId"] = currentOrder.commandId;
  eventDoc["sequence"] = (uint32_t)currentOrder.sequence;
  eventDoc["timestamp"] = millis();
  if (reason != nullptr) eventDoc["reason"] = reason;
  if (failureCode != nullptr) eventDoc["failureCode"] = failureCode;
  if (activeStep != STEP_NONE) eventDoc["activeStepId"] = stepToString(activeStep);

  JsonArray completed = eventDoc["completedStepIds"].to<JsonArray>();
  for (int index = 0; index < activeStep && activeStep != STEP_NONE; index += 1) {
    PreparationStep step = static_cast<PreparationStep>(index);
    if ((step == STEP_ICE_DISPENSER && skipIce) ||
        (step == STEP_AGITATION_SYSTEM && skipAgitation) ||
        (step == STEP_CARBONATED_STATION && skipCarbonation)) {
      continue;
    }
    completed.add(stepToString(step));
  }
  JsonArray skipped = eventDoc["skippedStepIds"].to<JsonArray>();
  if (skipIce) skipped.add("ice_dispenser");
  if (skipAgitation) skipped.add("agitation_system");
  if (skipCarbonation) skipped.add("carbonated_station");

  currentOrder.sequence++;
  String body;
  serializeJson(eventDoc, body);
  client.publish(TOPIC_EVENT, body.c_str(), false);
}

void executeTestHardware(const String &type, int val, int pin, int duration) {
  if (type == "pump") {
    int pIdx = pin;
    if (pIdx >= 0 && pIdx < NUM_BOMBAS) {
      digitalWrite(B_PIN[pIdx], HIGH);
      pump_stop_time[pIdx] = millis() + duration;
    }
  } else if (type == "servo" || type == "servo_pos") {
    servo_pos(pin, val);
  } else if (type == "servo_cont") {
    servo_cont_set(val);
    if (val != 0) srv_cont_stop_time = millis() + duration;
  } else if (type == "motor") {
    motor_steps(val);
    wait_motor_done();
  } else if (type == "motor_home") {
    home();
  } else if (type == "full_test") {
    startCleaning();
  } else if (type == "motor_abs") {
    mover_a(val);
    wait_motor_done();
  }
  publishState();
}

const char *statusToString() {
  switch (status) {
    case STATUS_PREPARING: return "preparing";
    case STATUS_CLEANING: return "cleaning";
    case STATUS_ERROR: return "error";
    default: return "idle";
  }
}

const char *stepToString(PreparationStep step) {
  switch (step) {
    case STEP_CUP_DISPENSER: return "cup_dispenser";
    case STEP_ICE_DISPENSER: return "ice_dispenser";
    case STEP_ALCOHOL_DISPENSER: return "alcohol_dispenser";
    case STEP_AGITATION_SYSTEM: return "agitation_system";
    case STEP_CARBONATED_STATION: return "carbonated_station";
    case STEP_READY: return "ready";
    default: return "";
  }
}

PreparationStep nextStepAfter(PreparationStep step) {
  int next = static_cast<int>(step) + 1;
  while (next <= STEP_READY) {
    PreparationStep candidate = static_cast<PreparationStep>(next);
    if (candidate == STEP_ICE_DISPENSER && skipIce) { next++; continue; }
    if (candidate == STEP_AGITATION_SYSTEM && skipAgitation) { next++; continue; }
    if (candidate == STEP_CARBONATED_STATION && skipCarbonation) { next++; continue; }
    return candidate;
  }
  return STEP_READY;
}

bool recipeNeedsAgitation(const String &recipeId) {
  return recipeId == "negroni" || recipeId == "boulevardier" ||
         recipeId == "godfather" || recipeId == "americano";
}

bool recipeNeedsCarbonation(const String &recipeId) {
  return recipeId == "piscola";
}
