#include <Arduino.h>
#include <ArduinoJson.h>
#include <ESP32Servo.h>
#include <Preferences.h>
#include <PubSubClient.h>
#include <WiFi.h>

// ═══════════════════════════════════════════
//  CONFIGURACIÓN DE RED Y MQTT
// ═══════════════════════════════════════════
// Cambia estas constantes según tu red local y la IP de tu PC con Mosquitto
const char *WIFI_SSID = "iPhone de Gael";
const char *WIFI_PASSWORD = "12345678";
const char *MQTT_HOST = "172.20.10.7"; // IP de la PC donde corre Mosquitto
const int MQTT_PORT = 1883;

// Tópicos MQTT
const char *TOPIC_STATE = "penpito/kraken/state";
const char *TOPIC_COMMAND = "penpito/kraken/command";
const char *TOPIC_ACK = "penpito/kraken/command/ack";
const char *TOPIC_PRESENCE = "penpito/kraken/presence";


// CONSTANTES DE CALIBRACIÓN DE LA CUCHARA (Ajustar con el panel de calibración
// de la app)
const unsigned long TIEMPO_BAJAR_CUCHARA =
    3000;                                    // ms que demora en bajar al fondo
const unsigned long TIEMPO_AGITACION = 5000; // ms que se queda revolviendo
const unsigned long TIEMPO_SUBIR_CUCHARA =
    3100; // ms que demora en subir al tope

// ═══════════════════════════════════════════
//  PINOUT (Unificado en 1x ESP32)
// ═══════════════════════════════════════════
// BOMBAS: 1 pin por bomba (ENA/ENB con jumper a 5V, IN2/IN4 a GND)
const int B_PIN[] = {16, 17, 19, 25, 26, 32, 33};
const int NUM_BOMBAS = 7;

// Calibraciones pregrabadas según tus medidas (ml por segundo)
float b_ml_ps[7] = {
    24.7, // B1 (Pisco): 24.7 ml/s
    23.6, // B2 (Amaretto): 23.6 ml/s
    20.6, // B3 (Gin): 20.6 ml/s
    24.3, // B4 (Coca-Cola, swap): 24.3 ml/s (GPIO 25)
    23.8, // B5 (Vermut Rosso): 23.8 ml/s
    16.1, // B6 (Whisky): 16.1 ml/s
    23.6  // B7 (Campari, swap): 23.6 ml/s (GPIO 33)
};
unsigned long pump_stop_time[7] = {
    0}; // Tiempos de apagado no bloqueante para bombas
unsigned long srv_cont_stop_time = 0; // Tiempo de parada de servo continuo

// SERVOS
Servo srv_pos[3];
const int SRV_PIN[] = {22, 23, 27};
Servo srv_cont;
const int SRV_CONT_PIN = 21;
const int SRV_CONT_STOP = 90;
const int SRV_CONT_TRIM = 0;

// MOTOR NEMA17 + A4988
const int MOTOR_STEP = 18;
const int MOTOR_DIR = 12;
const int MOTOR_ENABLE = 4; // LOW = Habilitado, HIGH = Apagado
const int LIMIT_SW = 34;    // Pull-down externo de 10k
volatile bool limit_triggered = false;

void IRAM_ATTR on_limit() {
  // Filtro de ruido: solo activa si el pin realmente está HIGH al dispararse la
  // interrupción
  if (digitalRead(LIMIT_SW) == HIGH) {
    limit_triggered = true;
  }
}

// POSICIONES FÍSICAS (Pasos desde el Home)
int POS_CUP = 3600;      // Posición del dispensador de vasos
int POS_ICE = 2600;      // Posición del dispensador de hielos
int POS_LIQUID = 2400;   // (Legacy, no usado en dispensador secuencial)
int POS_STIR = 800;      // Posición de la cuchara (agitador)
int POS_READY = 100;     // Posición final de retiro (home)
int POS_PUMP_1_2 = 1860; // Estación de bombas 1 y 2
int POS_PUMP_3_4 = 1600; // Estación de bombas 3 y 4
int POS_PUMP_5_6 = 1350; // Estación de bombas 5 y 6
int POS_PUMP_7 = 1200;   // Estación de bomba 7

// ═══════════════════════════════════════════
//  ESTADOS DE LA MÁQUINA
// ═══════════════════════════════════════════
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

MachineStatus status = STATUS_IDLE;
PreparationStep activeStep = STEP_NONE;
String currentRecipeId = "";
String errorMessage = "";
bool isOn = true;
bool isDrinkReady = false;
bool skipIce = false;
bool skipAgitation = false;
bool skipCarbonation = false;
int requestedIceCount = 2;

// Parámetros de personalización recibidos por MQTT
float customAlcoholOz = 0;
float customMixerOz = 0;

// Parámetros de preparación diferida (para evitar bloqueo en callback MQTT)
bool pendingPrepare = false;
String pendingRecipeId = "";
int pendingIceCount = 0;
float pendingAlcoholOz = 0.0;
float pendingMixerOz = 0.0;

// Variables de control de secuencia no bloqueante
bool step_in_progress = false;
unsigned long step_timer = 0;
bool waiting_for_pumps = false;
int ice_cycle_count = 0;
int ice_cycle_state =
    0; // 0 = abrir g1, 1 = cerrar g1, 2 = abrir g2, 3 = cerrar g2
int stir_state =
    0; // Estado de agitación: 0=bajar, 1=revolver, 2=subir, 3=detener

// Variables para dosificación secuencial de bebidas
struct DispenseItem {
  int pumpIdx;
  int position;
  unsigned long durationMs;
};
DispenseItem itemsToDispense[4];
int totalDispenseItems = 0;
int currentDispenseItemIdx = 0;
int dispenseSubState = 0; // 0 = viajando, 1 = bombeando, 2 = goteando
unsigned long dispenseTimer = 0;
int stir_shake_count = 0;

// Clientes Wi-Fi y MQTT
WiFiClient espClient;
PubSubClient client(espClient);
Preferences preferences;
unsigned long last_state_publish = 0;
unsigned long last_reconnect_attempt = 0;

struct CachedRequest {
  String id;
  bool ok;
  String errorMessage;
};
CachedRequest lastRequests[5];
int lastRequestIdIdx = 0;

bool in_mqtt_callback = false;

// Variables y declaraciones para movimiento de motor no bloqueante
bool is_motor_moving = false;
int motor_target_steps = 0;
int motor_step_dir = 0;
unsigned long next_motor_step_micros = 0;
bool motor_starting_from_limit = false;
int motor_steps_done = 0;
bool motor_move_error = false;

bool is_homing = false;
int home_substate = 0; // 0=idle, 1=pre-clearing, 2=searching
unsigned long next_home_step_micros = 0;
int home_steps_taken = 0;

bool pendingClean = false;
bool pendingTest = false;
String pendingTestType = "";
int pendingTestVal = 0;
int pendingTestPin = 0;
int pendingTestDuration = 0;

// Declaraciones de funciones
void smartDelay(unsigned long ms);
void cacheRequestResult(const String &id, bool ok, const String &errorMsg);
int getCachedRequestIdx(const String &id);
void setupHardware();
void setupWifi();
void reconnect();
void mqttCallback(char *topic, byte *payload, unsigned int length);
void publishState();
void updateMachineState();
void startPreparation(const String &recipeId, int iceCount, float alcOz,
                      float mixOz);
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
void test_maquina_completa();
void test_maquina_seco();

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
  setupHardware();
  setupWifi();

  client.setServer(MQTT_HOST, MQTT_PORT);
  client.setCallback(mqttCallback);

  Serial.println("Kraken unificado listo.");
}

void loop() {
  // Conexión no bloqueante a MQTT y Wi-Fi
  if (WiFi.status() == WL_CONNECTED) {
    if (!client.connected()) {
      unsigned long now = millis();
      if (now - last_reconnect_attempt > 5000) {
        last_reconnect_attempt = now;
        if (client.connect("PenpitoKrakenDevice", nullptr, nullptr, TOPIC_PRESENCE, 1, true, "offline")) {
          client.subscribe(TOPIC_COMMAND);
          client.publish(TOPIC_PRESENCE, "online", true);
          Serial.println("MQTT Conectado.");
          publishState();
        }
      }
    } else {
      client.loop();
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

  // 1. Control del tiempo de apagado de Bombas (No bloqueante)
  unsigned long now = millis();
  for (int i = 0; i < NUM_BOMBAS; i++) {
    if (pump_stop_time[i] > 0) {
      if (!isOn || now >= pump_stop_time[i]) {
        digitalWrite(B_PIN[i], LOW);
        pump_stop_time[i] = 0;
        if (!isOn) {
          Serial.print("Bomba ");
          Serial.print(i + 1);
          Serial.println(" OFF (E-STOP)");
        } else {
          Serial.print("Bomba ");
          Serial.print(i + 1);
          Serial.println(" OFF (Tiempo completado)");
        }
      }
    }
  }

  if (status == STATUS_CLEANING) {
    bool any_pump_running = false;
    for (int i = 0; i < NUM_BOMBAS; i++) {
      if (pump_stop_time[i] > 0) any_pump_running = true;
    }
    if (!any_pump_running) {
      Serial.println("Limpieza terminada. Volviendo a reposo.");
      status = STATUS_IDLE;
      publishState();
    }
  }

  // 1b. Control del tiempo de apagado del servo continuo (No bloqueante)
  if (srv_cont_stop_time > 0) {
    if (!isOn || now >= srv_cont_stop_time) {
      servo_cont_set(0);
      srv_cont_stop_time = 0;
      Serial.println("Servo continuo OFF (Tiempo completado / E-STOP)");
    }
  }

  // 1c. Actualización del motor de pasos y home (No bloqueante)
  serviceMotorMovement();
  serviceHomeMovement();

  // Si hay una preparación pendiente, la iniciamos fuera del callback de MQTT
  if (pendingPrepare) {
    pendingPrepare = false;
    startPreparation(pendingRecipeId, pendingIceCount, pendingAlcoholOz, pendingMixerOz);
  }

  if (pendingClean) {
    pendingClean = false;
    startCleaning();
  }

  if (pendingTest) {
    pendingTest = false;
    executeTestHardware(pendingTestType, pendingTestVal, pendingTestPin, pendingTestDuration);
  }

  // 2. Máquina de estados de preparación
  updateMachineState();

  // 3. Publicación periódica de estado a la App (cada 3 segundos en reposo)
  if (status == STATUS_IDLE && now - last_state_publish > 3000) {
    publishState();
  }
}

// ═══════════════════════════════════════════
//  HARDWARE SETUP
// ═══════════════════════════════════════════
void setupHardware() {
  // Bombas
  for (int i = 0; i < NUM_BOMBAS; i++) {
    pinMode(B_PIN[i], OUTPUT);
    digitalWrite(B_PIN[i], LOW);
  }

  // Servos posicionales (Vasos y Hielo)
  srv_pos[0].setPeriodHertz(50);
  srv_pos[0].attach(SRV_PIN[0], 500, 2400);
  srv_pos[0].write(0); // Dispensador de vasos reposa en 0

  srv_pos[1].setPeriodHertz(50);
  srv_pos[1].attach(SRV_PIN[1], 500, 2400);
  srv_pos[1].write(180); // Compuerta hielo 1 reposa en 180

  srv_pos[2].setPeriodHertz(50);
  srv_pos[2].attach(SRV_PIN[2], 500, 2400);
  srv_pos[2].write(180); // Compuerta hielo 2 reposa en 180

  // Servo continuo
  srv_cont.setPeriodHertz(50);
  srv_cont.attach(SRV_CONT_PIN, 500, 2400);
  srv_cont.write(90);

  // Motor NEMA17
  pinMode(MOTOR_STEP, OUTPUT);
  digitalWrite(MOTOR_STEP, LOW);
  pinMode(MOTOR_DIR, OUTPUT);
  digitalWrite(MOTOR_DIR, LOW);
  pinMode(MOTOR_ENABLE, OUTPUT);
  digitalWrite(MOTOR_ENABLE, HIGH); // Apagado de bobinas para evitar calor

  // Limit Switch
  pinMode(LIMIT_SW, INPUT);
  attachInterrupt(digitalPinToInterrupt(LIMIT_SW), on_limit, RISING);

  // Cargar calibraciones dinámicas de la memoria Flash (Preferences)
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
  Serial.println();
  Serial.print("Conectando a Wi-Fi: ");
  Serial.println(WIFI_SSID);

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  int retry = 0;
  while (WiFi.status() != WL_CONNECTED && retry < 15) {
    delay(500);
    Serial.print(".");
    retry++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nWiFi Conectado!");
    Serial.print("IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("\nNo se pudo conectar a WiFi, operando sin conexion.");
  }
}

void smartDelay(unsigned long ms) {
  unsigned long start = millis();
  while (millis() - start < ms) {
    if (!in_mqtt_callback && client.connected()) {
      client.loop();
    }
    if (in_mqtt_callback && !isOn) {
      break;
    }
    delay(5);
  }
}

void cacheRequestResult(const String &id, bool ok, const String &errorMsg) {
  if (id.length() == 0) return;
  lastRequests[lastRequestIdIdx] = {id, ok, errorMsg};
  lastRequestIdIdx = (lastRequestIdIdx + 1) % 5;
}

int getCachedRequestIdx(const String &id) {
  if (id.length() == 0) return -1;
  for (int i = 0; i < 5; i++) {
    if (lastRequests[i].id == id) return i;
  }
  return -1;
}

// ═══════════════════════════════════════════
//  CONTROL DE SERVOS Y MOTOR
// ═══════════════════════════════════════════
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
  digitalWrite(MOTOR_ENABLE, HIGH); // Apagar bobinas
}

void motor_step() {
  digitalWrite(MOTOR_STEP, HIGH);
  delayMicroseconds(5);
  digitalWrite(MOTOR_STEP, LOW);
  delayMicroseconds(
      3000); // Aumentado a 3000us para evitar patinaje/pérdida de pasos
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
    Serial.println("!!! Movimiento DETENIDO por POWER OFF / E-STOP !!!");
    is_motor_moving = false;
    motor_stop();
    motor_move_error = true;
    return;
  }

  unsigned long now_u = micros();
  if (now_u < next_motor_step_micros) return;

  if (motor_step_dir < 0 && motor_pos < 300 && (limit_triggered || is_limit_pressed())) {
    Serial.println("!!! Movimiento DETENIDO por FIN DE CARRERA (Limit Switch) !!!");
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
      Serial.println("!!! ERROR CRITICO DE SEGURIDAD: El motor no logro despegarse del interruptor de Home. !!!");
      is_motor_moving = false;
      motor_stop();
      motor_move_error = true;
      return;
    }
    Serial.print("Movimiento completado con exito. Posicion actual: ");
    Serial.println(motor_pos);
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
    Serial.println("!!! HOME DETENIDO por POWER OFF / E-STOP !!!");
    is_homing = false;
    motor_stop();
    return;
  }

  unsigned long now_u = micros();
  if (now_u < next_home_step_micros) return;

  if (home_substate == 1) { // Pre-clearing
    digitalWrite(MOTOR_STEP, HIGH);
    delayMicroseconds(5);
    digitalWrite(MOTOR_STEP, LOW);
    home_steps_taken++;
    next_home_step_micros = micros() + 3000;

    if (!is_limit_pressed() || home_steps_taken >= 500) {
      Serial.print("Sensor liberado tras ");
      Serial.print(home_steps_taken);
      Serial.println(" pasos.");
      home_substate = 2;
      home_steps_taken = 0;
      digitalWrite(MOTOR_DIR, LOW);
      next_home_step_micros = micros() + 100000;
    }
  } else if (home_substate == 2) { // Searching
    if (limit_triggered || is_limit_pressed()) {
      digitalWrite(MOTOR_STEP, LOW);
      motor_pos = 0;
      limit_triggered = false;
      is_homing = false;
      home_substate = 0;
      motor_stop();
      Serial.println("Home completado con éxito.");
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
      Serial.println("!!! ERROR DE SEGURIDAD: Home no encontrado despues de 6000 pasos. Driver apagado o motor atascado. !!!");
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
  if (n == 0) {
    Serial.println("motor_steps: 0 pasos requeridos. Retornando.");
    return true;
  }
  digitalWrite(MOTOR_DIR, (n > 0) ? HIGH : LOW);
  digitalWrite(MOTOR_ENABLE, LOW); // Activar bobinas
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
  Serial.println("Buscando Home (No bloqueante)...");
  limit_triggered = false;
  is_homing = true;
  home_steps_taken = 0;
  motor_move_error = false;
  if (is_limit_pressed()) {
    Serial.println("Sensor ya presionado al iniciar Home. Liberando...");
    home_substate = 1; // pre-clearing
    digitalWrite(MOTOR_DIR, HIGH); // Mover adelante
  } else {
    home_substate = 2; // searching
    digitalWrite(MOTOR_DIR, LOW); // Hacia Home
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
  Serial.print("mover_a: de ");
  Serial.print(motor_pos);
  Serial.print(" a ");
  Serial.print(target);
  Serial.print(" (diff = ");
  Serial.print(diff);
  Serial.println(")");
  bool res = motor_steps(diff);
  if (status != STATUS_PREPARING) {
    wait_motor_done();
    return res && !motor_move_error;
  }
  return res;
}

// ═══════════════════════════════════════════
//  CONTROL DE BEBIDAS - MAQUINA DE ESTADOS
// ═══════════════════════════════════════════
void updateMachineState() {
  if (status != STATUS_PREPARING)
    return;

  if (is_motor_moving || is_homing) {
    return;
  }
  if (motor_move_error) {
    motor_move_error = false;
    handleMovementError("Fallo en movimiento del motor");
    return;
  }

  unsigned long now = millis();

  // 1. Si no hay paso activo en ejecucion, lo inicializamos
  if (!step_in_progress) {
    step_in_progress = true;
    Serial.print("Iniciando Paso: ");
    Serial.println(stepToString(activeStep));

    switch (activeStep) {
    case STEP_CUP_DISPENSER:
      if (!mover_a(POS_CUP)) {
        handleMovementError("Fallo motor al mover a posicion de vaso");
        return;
      }
      step_timer = now + 1000;
      break;

    case STEP_ICE_DISPENSER:
      if (!mover_a(POS_ICE)) {
        handleMovementError("Fallo motor al mover a posicion de hielo");
        return;
      }
      ice_cycle_count = 0;
      ice_cycle_state = 0;
      // Establece timer de ejecucion del dispensado de hielo
      step_timer = now;
      break;

    case STEP_ALCOHOL_DISPENSER: {
      waiting_for_pumps = true;
      totalDispenseItems = 0;
      currentDispenseItemIdx = 0;
      dispenseSubState = 0;

      float ml_pisco = 90.0;
      float ml_cola = 150.0;

      if (customAlcoholOz > 0)
        ml_pisco = customAlcoholOz * 30.0;
      if (customMixerOz > 0)
        ml_cola = customMixerOz * 30.0;

      if (currentRecipeId == "piscola") {
        itemsToDispense[totalDispenseItems++] = {
            0, POS_PUMP_1_2, (unsigned long)((ml_pisco / b_ml_ps[0]) * 1000)};
        itemsToDispense[totalDispenseItems++] = {
            3, POS_PUMP_3_4, (unsigned long)((ml_cola / b_ml_ps[3]) * 1000)};
      } else if (currentRecipeId == "negroni") {
        float ml_gin = (customAlcoholOz > 0) ? customAlcoholOz * 30.0 : 75.0;
        float ml_campari = 75.0;
        float ml_vermut = (customMixerOz > 0) ? customMixerOz * 30.0 : 75.0;
        itemsToDispense[totalDispenseItems++] = {
            2, POS_PUMP_3_4, (unsigned long)((ml_gin / b_ml_ps[2]) * 1000)};
        itemsToDispense[totalDispenseItems++] = {
            4, POS_PUMP_5_6, (unsigned long)((ml_vermut / b_ml_ps[4]) * 1000)};
        itemsToDispense[totalDispenseItems++] = {
            6, POS_PUMP_7, (unsigned long)((ml_campari / b_ml_ps[6]) * 1000)};
      } else if (currentRecipeId == "boulevardier") {
        float ml_whisky = (customAlcoholOz > 0) ? customAlcoholOz * 30.0 : 75.0;
        float ml_campari = 75.0;
        float ml_vermut = (customMixerOz > 0) ? customMixerOz * 30.0 : 75.0;
        itemsToDispense[totalDispenseItems++] = {
            5, POS_PUMP_5_6, (unsigned long)((ml_whisky / b_ml_ps[5]) * 1000)};
        itemsToDispense[totalDispenseItems++] = {
            4, POS_PUMP_5_6, (unsigned long)((ml_vermut / b_ml_ps[4]) * 1000)};
        itemsToDispense[totalDispenseItems++] = {
            6, POS_PUMP_7, (unsigned long)((ml_campari / b_ml_ps[6]) * 1000)};
      } else if (currentRecipeId == "godfather") {
        float ml_whisky =
            (customAlcoholOz > 0) ? customAlcoholOz * 30.0 : 150.0;
        float ml_amaretto = (customMixerOz > 0) ? customMixerOz * 30.0 : 75.0;
        itemsToDispense[totalDispenseItems++] = {
            5, POS_PUMP_5_6, (unsigned long)((ml_whisky / b_ml_ps[5]) * 1000)};
        itemsToDispense[totalDispenseItems++] = {
            1, POS_PUMP_1_2,
            (unsigned long)((ml_amaretto / b_ml_ps[1]) * 1000)};
      } else if (currentRecipeId == "americano") {
        float ml_campari = (customAlcoholOz > 0) ? customAlcoholOz * 30.0
                                                  : 100.0;
        float ml_vermut = (customMixerOz > 0) ? customMixerOz * 30.0 : 100.0;
        itemsToDispense[totalDispenseItems++] = {
            4, POS_PUMP_5_6, (unsigned long)((ml_vermut / b_ml_ps[4]) * 1000)};
        itemsToDispense[totalDispenseItems++] = {
            6, POS_PUMP_7, (unsigned long)((ml_campari / b_ml_ps[6]) * 1000)};
      } else if (currentRecipeId == "whisky_rocks") {
        float ml_whisky =
            (customAlcoholOz > 0) ? customAlcoholOz * 30.0 : 180.0;
        itemsToDispense[totalDispenseItems++] = {
            5, POS_PUMP_5_6, (unsigned long)((ml_whisky / b_ml_ps[5]) * 1000)};
      } else if (currentRecipeId == "campari_rocks") {
        float ml_campari = (customAlcoholOz > 0) ? customAlcoholOz * 30.0
                                                  : 180.0;
        itemsToDispense[totalDispenseItems++] = {
            6, POS_PUMP_7, (unsigned long)((ml_campari / b_ml_ps[6]) * 1000)};
      }

      // Si la receta no requiere bombas, saltamos el paso
      if (totalDispenseItems == 0) {
        step_in_progress = false;
        activeStep = nextStepAfter(activeStep);
        publishState();
        return;
      }

      // Mover a la primera posición
      Serial.print("Preparando receta secuencial. Total ingredientes: ");
      Serial.println(totalDispenseItems);
      if (!mover_a(itemsToDispense[0].position)) {
        handleMovementError("Fallo motor al mover a primer alcohol");
        return;
      }
      step_timer = now;
    } break;

    case STEP_AGITATION_SYSTEM:
      if (!mover_a(POS_STIR)) {
        handleMovementError("Fallo motor al mover a posicion de mezcla");
        return;
      }
      stir_state = 0;
      step_timer = now;
      break;

    case STEP_CARBONATED_STATION:
      // Carbonatación se simula con delay
      step_timer = now + 1200;
      break;

    case STEP_READY:
      if (!home()) {
        handleMovementError("Fallo motor al retornar a home final");
        return;
      }
      step_timer = now + 500;
      break;

    default:
      step_in_progress = false;
      break;
    }
    publishState();
    return;
  }

  // 2. Ejecución y monitoreo de la etapa activa
  switch (activeStep) {
  case STEP_CUP_DISPENSER:
    // Esperamos que termine el tiempo de viaje/accion, luego disparamos servo
    if (now >= step_timer) {
      // Ejecuta el dispensador de vasos (Servo 1: GPIO 22)
      servo_pos(0, 180);
      smartDelay(1200); // Retardo físico de caída de vaso (pequeño bloqueo tolerado
                   // en transicion)
      servo_pos(0, 0);
      smartDelay(500);

      // Finaliza paso
      step_in_progress = false;
      activeStep = nextStepAfter(activeStep);
      publishState();
    }
    break;

  case STEP_ICE_DISPENSER:
    if (now >= step_timer) {
      if (ice_cycle_count < requestedIceCount) {
        // Solo compuerta 1 (Servo 1), abierta a 0 grados, cerrada a 180 grados
        if (ice_cycle_state == 0) {
          Serial.println("Hielo: Abriendo compuerta...");
          servo_pos(1, 0); // Abre compuerta 1
          step_timer = now + 1000;
          ice_cycle_state = 1;
        } else if (ice_cycle_state == 1) {
          Serial.println("Hielo: Cerrando compuerta...");
          servo_pos(1, 180); // Cierra compuerta 1
          step_timer = now + 1000;
          ice_cycle_count++;
          ice_cycle_state = 0; // Siguiente cubo
        }
      } else {
        // Finaliza paso
        step_in_progress = false;
        activeStep = nextStepAfter(activeStep);
        publishState();
      }
    }
    break;

  case STEP_ALCOHOL_DISPENSER:
    if (currentDispenseItemIdx < totalDispenseItems) {
      if (dispenseSubState == 0) { // Viajando a la posición
        if (now >= step_timer) {
          // Llegamos a la estación. Encendemos la bomba correspondiente
          int pIdx = itemsToDispense[currentDispenseItemIdx].pumpIdx;
          unsigned long duration =
              itemsToDispense[currentDispenseItemIdx].durationMs;

          Serial.print("Dispensando ingrediente ");
          Serial.print(currentDispenseItemIdx + 1);
          Serial.print(": Bomba ");
          Serial.print(pIdx + 1);
          Serial.print(" por ");
          Serial.print(duration);
          Serial.println("ms");

          digitalWrite(B_PIN[pIdx], HIGH);
          dispenseTimer = now + duration;
          dispenseSubState = 1; // Bombeando
        }
      } else if (dispenseSubState == 1) { // Bombeando
        if (now >= dispenseTimer) {
          // Terminó el tiempo de bombeo. Apagamos la bomba.
          int pIdx = itemsToDispense[currentDispenseItemIdx].pumpIdx;
          digitalWrite(B_PIN[pIdx], LOW);

          // Iniciamos la espera de goteo (1.5 segundos)
          Serial.println("Bomba apagada. Esperando fin de goteo...");
          dispenseTimer = now + 1500;
          dispenseSubState = 2; // Goteando
        }
      } else if (dispenseSubState == 2) { // Goteando
        if (now >= dispenseTimer) {
          // Terminado el goteo. Avanzamos al siguiente ingrediente
          currentDispenseItemIdx++;
          if (currentDispenseItemIdx < totalDispenseItems) {
            // Mover al siguiente ingrediente
            int nextPos = itemsToDispense[currentDispenseItemIdx].position;
            Serial.print("Moviendo a siguiente estacion: ");
            Serial.println(nextPos);
            if (!mover_a(nextPos)) {
              handleMovementError("Fallo motor al mover a siguiente alcohol");
              return;
            }
            step_timer = now;
            dispenseSubState = 0; // Viajando
          } else {
            // Terminamos todos los ingredientes
            Serial.println("Dosificacion de liquidos completada.");
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
        Serial.println("Agitacion: Bajando cuchara completo...");
        servo_cont_set(100);     // bajar completo
        step_timer = now + 1800; // Reducido a 1800ms
        stir_state = 1;
      } else if (stir_state == 1) {
        Serial.println("Agitacion: Iniciando agitacion rapida (shaking)...");
        stir_shake_count = 0;
        servo_cont_set(-100);   // Subir harto
        step_timer = now + 600; // 600ms
        stir_state = 2;         // Estado subiendo agitador
      } else if (stir_state == 2) {
        // Terminó de subir, ahora bajamos
        servo_cont_set(100);    // Bajar harto
        step_timer = now + 600; // 600ms
        stir_state = 3;         // Estado bajando agitador
      } else if (stir_state == 3) {
        // Terminó de bajar, evaluamos si repetimos
        stir_shake_count++;
        if (stir_shake_count < 6) {
          servo_cont_set(-100); // Volver a subir
          step_timer = now + 600;
          stir_state = 2;
        } else {
          Serial.println(
              "Agitacion: Finalizando agitacion rapida. Subiendo...");
          servo_cont_set(-100); // Subir completo
          step_timer = now + 1800;
          stir_state = 4;
        }
      } else if (stir_state == 4) {
        servo_cont_set(0); // detener
        Serial.println("Agitacion: Cuchara arriba y detenida.");
        // Finaliza paso
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

      motor_stop(); // Apaga bobinas al terminar

      Serial.println("Bebida servida y lista.");
      publishState();
    }
    break;

  default:
    break;
  }
}

void startPreparation(const String &recipeId, int iceCount, float alcOz,
                      float mixOz) {
  // Hacer home al iniciar la preparación para calibrar la posición del carro de
  // forma segura
  Serial.println("Preparando trago: Ejecutando Home de calibracion inicial...");
  if (!home()) {
    Serial.println("ERROR CRITICO: Fallo la calibracion Home inicial al "
                   "iniciar preparacion.");
    status = STATUS_ERROR;
    errorMessage = "Fallo en calibracion Home";
    publishState();
    return;
  }

  currentRecipeId = recipeId;
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

  Serial.print("MQTT PREPARE -> Receta: ");
  Serial.print(currentRecipeId);
  Serial.print(" | Hielo: ");
  Serial.println(requestedIceCount);
}

void startCleaning() {
  status = STATUS_CLEANING;
  activeStep = STEP_NONE;
  isDrinkReady = false;
  errorMessage = "";

  // Limpieza enciende todas las bombas por 4 segundos
  Serial.println("Limpiando conductos...");
  for (int i = 0; i < NUM_BOMBAS; i++) {
    digitalWrite(B_PIN[i], HIGH);
    pump_stop_time[i] = millis() + 4000;
  }
}

void stopAllHardware() {
  // Apaga todas las bombas
  for (int i = 0; i < NUM_BOMBAS; i++) {
    digitalWrite(B_PIN[i], LOW);
    pump_stop_time[i] = 0;
  }
  // Detiene cuchara
  servo_cont_set(0);
  srv_cont_stop_time = 0;
  // Detiene motor
  motor_stop();
}

void resetPreparationState() {
  status = STATUS_IDLE;
  activeStep = STEP_NONE;
  currentRecipeId = "";
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

  stopAllHardware();
}

void handleMovementError(const String &msg) {
  Serial.print("ERROR CRITICO DE SEGURIDAD: ");
  Serial.println(msg);
  status = STATUS_ERROR;
  errorMessage = msg;
  stopAllHardware();
  publishState();
}

// ═══════════════════════════════════════════
//  MQTT CALLBACK & PUBLICACIONES
// ═══════════════════════════════════════════
void mqttCallback(char *topic, byte *payload, unsigned int length) {
  String message = "";
  for (unsigned int i = 0; i < length; i++) {
    message += (char)payload[i];
  }

  Serial.print("Comando MQTT Recibido: ");
  Serial.println(message);

  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, message);
  if (err) {
    Serial.println("Error parseando JSON");
    return;
  }

  String cmd = doc["cmd"] | "";
  String val = doc["val"] | "";
  String requestId = doc["requestId"] | "";

  in_mqtt_callback = true;
  int dupIdx = getCachedRequestIdx(requestId);
  if (dupIdx >= 0) {
    Serial.println("Comando duplicado ignorado: " + requestId);
    JsonDocument ackDoc;
    ackDoc["requestId"] = requestId;
    ackDoc["ok"] = lastRequests[dupIdx].ok;
    JsonObject stateObj = ackDoc["state"].to<JsonObject>();
    stateObj["isOn"] = isOn;
    stateObj["status"] = statusToString();
    String err = lastRequests[dupIdx].errorMessage;
    stateObj["errorMessage"] = err.length() ? err.c_str() : nullptr;
    stateObj["currentRecipeId"] = currentRecipeId.length() ? currentRecipeId.c_str() : nullptr;
    stateObj["requestedIceCount"] = requestedIceCount;
    String ackString;
    serializeJson(ackDoc, ackString);
    client.publish(TOPIC_ACK, ackString.c_str());
    in_mqtt_callback = false;
    return;
  }

  bool ok = false;

  if (cmd == "POWER") {
    isOn = (val == "ON");
    if (!isOn || status == STATUS_ERROR) {
      resetPreparationState();
    }
    ok = true;
  } else if (!isOn) {
    errorMessage = "Comando rechazado: Maquina apagada";
    Serial.println(errorMessage);
  } else if (cmd == "PREPARE") {
    if (status != STATUS_IDLE) {
      errorMessage = "Maquina ocupada: No se puede iniciar preparacion";
      Serial.println(errorMessage);
    } else {
      pendingRecipeId = val;
      pendingIceCount = doc["iceCount"] | 2;
      pendingAlcoholOz = doc["alcoholOz"] | 0.0;
      pendingMixerOz = doc["mixerOz"] | 0.0;
      pendingPrepare = true;
      status = STATUS_PREPARING;
      ok = true;
    }
  } else if (cmd == "CLEAN") {
    if (status != STATUS_IDLE) {
      errorMessage = "Maquina ocupada: No se puede iniciar limpieza";
      Serial.println(errorMessage);
    } else {
      pendingClean = true;
      status = STATUS_CLEANING;
      ok = true;
    }
  } else if (cmd == "TAKEN") {
    Serial.println("Comando TAKEN recibido: Bebida retirada de la bandeja.");
    isDrinkReady = false;
    publishState();
    ok = true;
  } else if (cmd == "CONFIG_WIFI") {
    // Configuración recibida por el panel de administración
    // En producción se guardaría en Preferences (NVS), aquí respondemos OK
    Serial.println("Nueva config de red recibida. Guardando...");
    ok = true;
  } else if (cmd == "SET_CALIB") {
    if (status != STATUS_IDLE) {
      errorMessage = "Maquina ocupada: No se puede calibrar durante una preparacion";
      Serial.println(errorMessage);
    } else {
      Serial.println("Recibido comando de calibracion SET_CALIB...");
      preferences.begin("kraken", false);

      if (doc.containsKey("rates")) {
        JsonArray rates = doc["rates"];
        for (int i = 0; i < 7; i++) {
          if (!rates[i].isNull()) {
            b_ml_ps[i] = rates[i].as<float>();
            if (b_ml_ps[i] < 0.5) b_ml_ps[i] = 15.0;
            String key = "b_ml_" + String(i);
            preferences.putFloat(key.c_str(), b_ml_ps[i]);
            Serial.print("Bomba ");
            Serial.print(i + 1);
            Serial.print(" caudal: ");
            Serial.println(b_ml_ps[i]);
          }
        }
      }

      if (doc.containsKey("positions")) {
        JsonArray positions = doc["positions"];
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
          Serial.println("Coordenadas de riel actualizadas en Flash.");
        }
      }
      preferences.end();
      ok = true;
    }
  } else if (cmd == "TEST_HW") {
    if (status != STATUS_IDLE) {
      errorMessage = "Maquina ocupada: No se puede testear hardware en preparacion";
      Serial.println(errorMessage);
    } else {
      String type = doc["type"] | "";
      int val = doc["val"] | 0;
      int pin = doc["pin"] | 1;
      int duration = doc["duration"] | 3000;
      pendingTestType = type;
      pendingTestVal = val;
      pendingTestPin = pin;
      pendingTestDuration = duration;
      pendingTest = true;
      ok = true;
    }
  }

  // Publicar ACK confirmando recepción
  JsonDocument ackDoc;
  ackDoc["requestId"] = requestId;
  ackDoc["ok"] = ok;
  JsonObject stateObj = ackDoc["state"].to<JsonObject>();

  // Rellenar estado actual en la respuesta
  stateObj["isOn"] = isOn;
  stateObj["status"] = statusToString();
  stateObj["errorMessage"] =
      errorMessage.length() ? errorMessage.c_str() : nullptr;
  stateObj["currentRecipeId"] =
      currentRecipeId.length() ? currentRecipeId.c_str() : nullptr;
  stateObj["requestedIceCount"] = requestedIceCount;
  stateObj["activeStepId"] =
      activeStep == STEP_NONE ? nullptr : stepToString(activeStep);
  stateObj["isDrinkReady"] = isDrinkReady;

  String ackBody;
  serializeJson(ackDoc, ackBody);
  client.publish(TOPIC_ACK, ackBody.c_str());

  cacheRequestResult(requestId, ok, errorMessage);
  in_mqtt_callback = false;

  publishState();
}

void publishState() {
  JsonDocument stateDoc;
  stateDoc["isOn"] = isOn;
  stateDoc["status"] = statusToString();
  stateDoc["errorMessage"] =
      errorMessage.length() ? errorMessage.c_str() : nullptr;
  stateDoc["currentRecipeId"] =
      currentRecipeId.length() ? currentRecipeId.c_str() : nullptr;
  stateDoc["requestedIceCount"] = requestedIceCount;
  stateDoc["activeStepId"] =
      activeStep == STEP_NONE ? nullptr : stepToString(activeStep);
  stateDoc["isDrinkReady"] = isDrinkReady;

  JsonArray completed = stateDoc["completedStepIds"].to<JsonArray>();
  for (int index = 0; index < activeStep && activeStep != STEP_NONE;
       index += 1) {
    PreparationStep step = static_cast<PreparationStep>(index);
    if ((step == STEP_ICE_DISPENSER && skipIce) ||
        (step == STEP_AGITATION_SYSTEM && skipAgitation) ||
        (step == STEP_CARBONATED_STATION && skipCarbonation)) {
      continue;
    }
    completed.add(stepToString(step));
  }

  JsonArray skipped = stateDoc["skippedStepIds"].to<JsonArray>();
  if (skipIce)
    skipped.add("ice_dispenser");
  if (skipAgitation)
    skipped.add("agitation_system");
  if (skipCarbonation)
    skipped.add("carbonated_station");

  String body;
  serializeJson(stateDoc, body);
  client.publish(TOPIC_STATE, body.c_str());

  last_state_publish = millis();
}

// ═══════════════════════════════════════════
//  FUNCIONES AUXILIARES
// ═══════════════════════════════════════════
const char *statusToString() {
  switch (status) {
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

const char *stepToString(PreparationStep step) {
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

PreparationStep nextStepAfter(PreparationStep step) {
  int next = static_cast<int>(step) + 1;
  while (next <= STEP_READY) {
    PreparationStep candidate = static_cast<PreparationStep>(next);
    if (candidate == STEP_ICE_DISPENSER && skipIce) {
      next++;
      continue;
    }
    if (candidate == STEP_AGITATION_SYSTEM && skipAgitation) {
      next++;
      continue;
    }
    if (candidate == STEP_CARBONATED_STATION && skipCarbonation) {
      next++;
      continue;
    }
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

void test_maquina_completa() {
  Serial.println("Iniciando prueba completa de la maquina...");
  if (!home()) {
    Serial.println("Falla de Home. Abortando prueba completa.");
    return;
  }

  // 1. Vaso (0 -> 180 -> 0)
  Serial.println("Paso 1: Posicion 3600 - vaso");
  if (!mover_a(3600)) {
    Serial.println("Falla al mover a vaso. Abortando prueba.");
    return;
  }
  servo_pos(0, 0);
  smartDelay(500);
  servo_pos(0, 180);
  smartDelay(1200);
  servo_pos(0, 0);
  smartDelay(1000);

  // 2. Hielo (Compuerta en 180 -> 0 -> 180)
  Serial.println("Paso 2: Posicion 2600 - hielo");
  if (!mover_a(2600)) {
    Serial.println("Falla al mover a hielo. Abortando prueba.");
    return;
  }
  servo_pos(1, 180);
  servo_pos(2, 180);
  smartDelay(500);
  // Compuerta 1
  servo_pos(1, 0);
  smartDelay(1000);
  servo_pos(1, 180);
  smartDelay(1000);

  // 3. Bombas (Activadas una por una en secuencia)
  Serial.println("Paso 3: Posicion 1860 - bombas 1 y 2");
  if (!mover_a(1860)) {
    Serial.println("Falla al mover a bombas 1 y 2. Abortando prueba.");
    return;
  }
  Serial.println("Encendiendo Bomba 1...");
  digitalWrite(B_PIN[0], HIGH);
  smartDelay(2000);
  digitalWrite(B_PIN[0], LOW);
  smartDelay(1500); // Esperar fin de goteo
  Serial.println("Encendiendo Bomba 2...");
  digitalWrite(B_PIN[1], HIGH);
  smartDelay(2000);
  digitalWrite(B_PIN[1], LOW);
  smartDelay(1500); // Esperar fin de goteo

  Serial.println("Paso 4: Posicion 1600 - bombas 3 y 4");
  if (!mover_a(1600)) {
    Serial.println("Falla al mover a bombas 3 y 4. Abortando prueba.");
    return;
  }
  Serial.println("Encendiendo Bomba 3...");
  digitalWrite(B_PIN[2], HIGH);
  smartDelay(2000);
  digitalWrite(B_PIN[2], LOW);
  smartDelay(1500);
  Serial.println("Encendiendo Bomba 4...");
  digitalWrite(B_PIN[3], HIGH);
  smartDelay(2000);
  digitalWrite(B_PIN[3], LOW);
  smartDelay(1500);

  Serial.println("Paso 5: Posicion 1350 - bombas 5 y 6");
  if (!mover_a(1350)) {
    Serial.println("Falla al mover a bombas 5 y 6. Abortando prueba.");
    return;
  }
  Serial.println("Encendiendo Bomba 5...");
  digitalWrite(B_PIN[4], HIGH);
  smartDelay(2000);
  digitalWrite(B_PIN[4], LOW);
  smartDelay(1500);
  Serial.println("Encendiendo Bomba 6...");
  digitalWrite(B_PIN[5], HIGH);
  smartDelay(2000);
  digitalWrite(B_PIN[5], LOW);
  smartDelay(1500);

  Serial.println("Paso 6: Posicion 1200 - bomba 7");
  if (!mover_a(1200)) {
    Serial.println("Falla al mover a bomba 7. Abortando prueba.");
    return;
  }
  Serial.println("Encendiendo Bomba 7...");
  digitalWrite(B_PIN[6], HIGH);
  smartDelay(2000);
  digitalWrite(B_PIN[6], LOW);
  smartDelay(1500); // Esperar fin de goteo before moving

  // 4. Cuchara (Agitación - Penúltimo Paso)
  Serial.println("Paso 7: Posicion 800 - cuchara (agitador)");
  if (!mover_a(800)) {
    Serial.println("Falla al mover a cuchara. Abortando prueba.");
    return;
  }
  servo_cont_set(100); // Bajar completo
  smartDelay(1800);         // Reducido de 3000 a 1800

  Serial.println("Agitando rapidamente arriba y abajo...");
  for (int k = 0; k < 6; k++) {
    servo_cont_set(-100); // Subir harto
    smartDelay(600);           // Aumentado a 600ms para mayor recorrido
    servo_cont_set(100);  // Bajar harto
    smartDelay(600);           // Aumentado a 600ms para mayor recorrido
  }

  servo_cont_set(-100); // Subir completo
  smartDelay(1800);          // Reducido de 3000 a 1800
  servo_cont_set(0);    // Detener

  // 5. Home final
  Serial.println("Paso 8: Home final");
  if (!home()) {
    Serial.println("Falla de Home final. Abortando.");
    return;
  }

  Serial.println("Prueba completa terminada.");
}

void test_maquina_seco() {
  Serial.println("Iniciando prueba en seco de la maquina...");
  if (!home()) {
    Serial.println("Falla de Home. Abortando prueba en seco.");
    return;
  }

  // 1. Vaso (0 -> 180 -> 0)
  Serial.println("Paso 1: Posicion 3600 - vaso");
  if (!mover_a(3600)) {
    Serial.println("Falla al mover a vaso (Seco). Abortando.");
    return;
  }
  servo_pos(0, 0);
  smartDelay(500);
  servo_pos(0, 180);
  smartDelay(1200);
  servo_pos(0, 0);
  smartDelay(1000);

  // 2. Hielo (Compuerta en 180 -> 0 -> 180)
  Serial.println("Paso 2: Posicion 2600 - hielo");
  if (!mover_a(2600)) {
    Serial.println("Falla al mover a hielo (Seco). Abortando.");
    return;
  }
  servo_pos(1, 180);
  servo_pos(2, 180);
  smartDelay(500);
  // Compuerta 1
  servo_pos(1, 0);
  smartDelay(1000);
  servo_pos(1, 180);
  smartDelay(1000);

  // 3. Bombas (Recorrido en seco, sin encender pines, secuencial)
  Serial.println("Paso 3: Posicion 1860 - bombas 1 y 2 (Seco)");
  if (!mover_a(1860)) {
    Serial.println("Falla al mover a bombas 1 y 2 (Seco). Abortando.");
    return;
  }
  smartDelay(2000);
  smartDelay(1500);
  smartDelay(2000);
  smartDelay(1500);

  Serial.println("Paso 4: Posicion 1600 - bombas 3 y 4 (Seco)");
  if (!mover_a(1600)) {
    Serial.println("Falla al mover a bombas 3 y 4 (Seco). Abortando.");
    return;
  }
  smartDelay(2000);
  smartDelay(1500);
  smartDelay(2000);
  smartDelay(1500);

  Serial.println("Paso 5: Posicion 1350 - bombas 5 y 6 (Seco)");
  if (!mover_a(1350)) {
    Serial.println("Falla al mover a bombas 5 y 6 (Seco). Abortando.");
    return;
  }
  smartDelay(2000);
  smartDelay(1500);
  smartDelay(2000);
  smartDelay(1500);

  Serial.println("Paso 6: Posicion 1200 - bomba 7 (Seco)");
  if (!mover_a(1200)) {
    Serial.println("Falla al mover a bomba 7 (Seco). Abortando.");
    return;
  }
  smartDelay(2000);
  smartDelay(1500);

  // 4. Cuchara (Agitación - Penúltimo Paso)
  Serial.println("Paso 7: Posicion 800 - cuchara (agitador)");
  if (!mover_a(800)) {
    Serial.println("Falla al mover a cuchara (Seco). Abortando.");
    return;
  }
  servo_cont_set(100); // Bajar completo
  smartDelay(1800);         // Reducido de 3000 a 1800

  Serial.println("Agitando rapidamente arriba y abajo...");
  for (int k = 0; k < 6; k++) {
    servo_cont_set(-100); // Subir harto (velocidad 100)
    smartDelay(600);           // Aumentado a 600ms para mayor recorrido
    servo_cont_set(100);  // Bajar harto (velocidad 100)
    smartDelay(600);           // Aumentado a 600ms para mayor recorrido
  }

  servo_cont_set(-100); // Subir completo
  smartDelay(1800);          // Reducido de 3000 a 1800
  servo_cont_set(0);    // Detener

  // 5. Home final
  Serial.println("Paso 8: Home final");
  if (!home()) {
    Serial.println("Falla de Home final (Seco). Abortando.");
    return;
  }

  Serial.println("Prueba en seco terminada.");
}

void executeTestHardware(const String &type, int val, int pin, int duration) {
  if (!isOn) return;
  if (type == "pump") {
    int idx = pin - 1;
    if (idx >= 0 && idx < NUM_BOMBAS) {
      digitalWrite(B_PIN[idx], HIGH);
      pump_stop_time[idx] = millis() + duration;
      Serial.print("Test Bomba ");
      Serial.print(pin);
      Serial.print(" por ");
      Serial.print(duration);
      Serial.println("ms");
    }
  } else if (type == "servo") {
    int idx = pin - 1;
    if (idx >= 0 && idx < 3) {
      servo_pos(idx, val);
      Serial.print("Test Servo ");
      Serial.print(pin);
      Serial.print(" a ");
      Serial.println(val);
    }
  } else if (type == "servo_cont") {
    servo_cont_set(val);
    if (duration > 0) {
      srv_cont_stop_time = millis() + duration;
    } else {
      srv_cont_stop_time = 0;
    }
    Serial.print("Test Servo Continuo velocidad=");
    Serial.print(val);
    Serial.print(" por ");
    Serial.print(duration);
    Serial.println("ms");
  } else if (type == "motor") {
    motor_steps(val);
  } else if (type == "motor_home") {
    home();
  } else if (type == "full_test") {
    test_maquina_completa();
  } else if (type == "dry_test") {
    test_maquina_seco();
  } else if (type == "motor_abs") {
    Serial.print("MQTT: Recibido comando motor_abs con valor: ");
    Serial.println(val);
    mover_a(val);
  } else if (type == "vaso_test") {
    Serial.println("MQTT: Ejecutando ciclo de prueba del vaso");
    servo_pos(0, 0);
    smartDelay(500);
    servo_pos(0, 180);
    smartDelay(1200);
    servo_pos(0, 0);
    smartDelay(500);
  } else if (type == "hielo_test") {
    Serial.println("MQTT: Ejecutando ciclo de prueba del hielo");
    servo_pos(1, 180);
    smartDelay(500);
    servo_pos(1, 0);
    smartDelay(1000);
    servo_pos(1, 180);
    smartDelay(500);
  } else if (type == "cuchara_test") {
    Serial.println("MQTT: Ejecutando ciclo de prueba de la cuchara");
    servo_cont_set(100);
    smartDelay(1800);
    Serial.println("Agitando rapidamente...");
    for (int k = 0; k < 6; k++) {
      servo_cont_set(-100);
      smartDelay(600);
      servo_cont_set(100);
      smartDelay(600);
    }
    servo_cont_set(-100);
    smartDelay(1800);
    servo_cont_set(0);
  }
}
