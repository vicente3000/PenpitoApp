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

// ═══════════════════════════════════════════
//  MODO DE PRUEBA / SIMULACIÓN
// ═══════════════════════════════════════════
const bool SIMULAR_MOTOR =
    false; // Cambiado a 'false' para mover el motor físico NEMA17

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
    24.2, // B1 (Pisco): 24.2 ml/s
    23.1, // B2 (Amaretto): 23.1 ml/s
    21.1, // B3 (Gin): 21.1 ml/s
    24.0, // B4 (Coca-Cola, swap): 24.0 ml/s (GPIO 25)
    24.3, // B5 (Vermut Rosso): 24.3 ml/s
    15.9, // B6 (Whisky): 15.9 ml/s
    23.1  // B7 (Campari, swap): 23.1 ml/s (GPIO 33)
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

// Declaraciones de funciones
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
  // Conexión no bloqueante a MQTT
  if (WiFi.status() == WL_CONNECTED) {
    if (!client.connected()) {
      unsigned long now = millis();
      if (now - last_reconnect_attempt > 5000) {
        last_reconnect_attempt = now;
        if (client.connect("PenpitoKrakenDevice")) {
          client.subscribe(TOPIC_COMMAND);
          Serial.println("MQTT Conectado.");
          publishState();
        }
      }
    } else {
      client.loop();
    }
  }

  // 1. Control del tiempo de apagado de Bombas (No bloqueante)
  unsigned long now = millis();
  for (int i = 0; i < NUM_BOMBAS; i++) {
    if (pump_stop_time[i] > 0) {
      if (now >= pump_stop_time[i]) {
        digitalWrite(B_PIN[i], LOW);
        pump_stop_time[i] = 0;
        Serial.print("Bomba ");
        Serial.print(i + 1);
        Serial.println(" OFF (Tiempo completado)");
      }
    }
  }

  // 1b. Control del tiempo de apagado del servo continuo (No bloqueante)
  if (srv_cont_stop_time > 0) {
    if (now >= srv_cont_stop_time) {
      servo_cont_set(0);
      srv_cont_stop_time = 0;
      Serial.println("Servo continuo OFF (Tiempo completado)");
    }
  }

  // Si hay una preparación pendiente, la iniciamos fuera del callback de MQTT
  if (pendingPrepare) {
    pendingPrepare = false;
    startPreparation(pendingRecipeId, pendingIceCount, pendingAlcoholOz, pendingMixerOz);
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
bool motor_steps(int n) {
  if (n == 0) {
    Serial.println("motor_steps: 0 pasos requeridos. Retornando.");
    return true;
  }
  digitalWrite(MOTOR_DIR, (n > 0) ? HIGH : LOW);
  digitalWrite(MOTOR_ENABLE, LOW); // Activar bobinas
  delayMicroseconds(10);

  bool completed = true;
  bool starting_from_limit = is_limit_pressed() && (n > 0);

  for (int i = 0; i < abs(n); i++) {
    // Solo detenemos por limit switch si nos estamos moviendo hacia atrás (n < 0)
    // Y además estamos físicamente cerca de la posición 0/Home (motor_pos < 300).
    // Esto evita que el ruido electromagnético de los motores cause falsas paradas en el trayecto.
    if (n < 0 && motor_pos < 300 && (limit_triggered || is_limit_pressed())) {
      Serial.println(
          "!!! Movimiento DETENIDO por FIN DE CARRERA (Limit Switch) !!!");
      motor_stop();
      limit_triggered = false;
      completed = false;
      break;
    }
    motor_step();
    motor_pos += (n > 0) ? 1 : -1;
  }

  // Verificación de despegue físico del carro: si salimos del switch y tras 150
  // pasos sigue presionado, significa que el carro no se movió (driver apagado,
  // motor trabado o correa rota).
  if (starting_from_limit && is_limit_pressed()) {
    Serial.println("!!! ERROR CRITICO DE SEGURIDAD: El motor no logro "
                   "despegarse del interruptor de Home. !!!");
    motor_stop();
    return false;
  }

  if (completed) {
    Serial.print("Movimiento completado con exito. Posicion actual: ");
    Serial.println(motor_pos);
  }
  motor_stop(); // Deshabilitar bobinas para evitar sobrecalentamiento del
                // driver A4988
  return completed;
}

bool home() {
  Serial.println("Buscando Home...");
  limit_triggered = false;

  // Pre-clearing: Si el fin de carrera ya está presionado, nos movemos
  // hacia adelante hasta liberarlo para evitar un falso home instantáneo.
  if (is_limit_pressed()) {
    Serial.println("Sensor ya presionado al iniciar Home. Liberando...");
    digitalWrite(MOTOR_DIR, HIGH); // Mover adelante
    digitalWrite(MOTOR_ENABLE, LOW);
    delayMicroseconds(10);
    int clear_steps = 0;
    while (is_limit_pressed() && clear_steps < 500) {
      motor_step();
      clear_steps++;
      delay(2);
    }
    delay(200);
    Serial.print("Sensor liberado tras ");
    Serial.print(clear_steps);
    Serial.println(" pasos.");
  }

  digitalWrite(MOTOR_DIR, LOW);
  digitalWrite(MOTOR_ENABLE, LOW);
  delayMicroseconds(10);

  int pasos_dados = 0;
  const int MAX_PASOS_BUSQUEDA = 6000; // Recorrido máximo total + margen seguro

  while (!limit_triggered && !is_limit_pressed()) {
    motor_step();
    pasos_dados++;
    if (pasos_dados > MAX_PASOS_BUSQUEDA) {
      Serial.println("!!! ERROR DE SEGURIDAD: Home no encontrado despues de "
                     "6000 pasos. Driver apagado o motor atascado. !!!");
      motor_stop();
      return false;
    }
  }

  digitalWrite(MOTOR_STEP, LOW);
  motor_pos = 0;
  delay(500);

  limit_triggered = false;
  motor_stop(); // Deshabilitar bobinas tras hacer home
  Serial.println("Home completado con éxito.");
  return true;
}

bool mover_a(int target) {
  if (SIMULAR_MOTOR) {
    Serial.print("[SIMULACION MOTOR] Carro 'viajando' a posicion ");
    Serial.println(target);
    return true;
  }
  int diff = target - motor_pos;
  Serial.print("mover_a: de ");
  Serial.print(motor_pos);
  Serial.print(" a ");
  Serial.print(target);
  Serial.print(" (diff = ");
  Serial.print(diff);
  Serial.println(")");
  return motor_steps(diff);
}

// ═══════════════════════════════════════════
//  CONTROL DE BEBIDAS - MAQUINA DE ESTADOS
// ═══════════════════════════════════════════
void updateMachineState() {
  if (status != STATUS_PREPARING)
    return;

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
      // Si simula motor, sumamos delay de viaje. Si no, va directo.
      step_timer = now + (SIMULAR_MOTOR ? 1500 : 0) + 1000;
      break;

    case STEP_ICE_DISPENSER:
      if (!mover_a(POS_ICE)) {
        handleMovementError("Fallo motor al mover a posicion de hielo");
        return;
      }
      ice_cycle_count = 0;
      ice_cycle_state = 0;
      // Establece timer de ejecucion del dispensado de hielo
      step_timer = now + (SIMULAR_MOTOR ? 1500 : 0);
      break;

    case STEP_ALCOHOL_DISPENSER: {
      waiting_for_pumps = true;
      totalDispenseItems = 0;
      currentDispenseItemIdx = 0;
      dispenseSubState = 0;

      float ml_pisco = 90.0; // Default 3 oz
      float ml_cola =
          175.0; // Default 7.5 oz (Reducido de 225.0 a 175.0, 50ml menos!)

      if (customAlcoholOz > 0)
        ml_pisco = customAlcoholOz * 30.0;
      if (customMixerOz > 0)
        ml_cola = customMixerOz * 30.0;

      // Poblamos los ingredientes requeridos según la receta
      if (currentRecipeId == "piscola") {
        // Pisco: Bomba 1 (idx 0), Posición POS_PUMP_1_2, vol: ml_pisco
        itemsToDispense[totalDispenseItems++] = {
            0, POS_PUMP_1_2, (unsigned long)((ml_pisco / b_ml_ps[0]) * 1000)};
        // Coca-Cola: Bomba 4 (idx 3), Posición POS_PUMP_3_4 (swapped, strong
        // pump!)
        itemsToDispense[totalDispenseItems++] = {
            3, POS_PUMP_3_4, (unsigned long)((ml_cola / b_ml_ps[3]) * 1000)};
      } else if (currentRecipeId == "negroni") {
        float ml_gin = (customAlcoholOz > 0) ? customAlcoholOz * 30.0 : 60.0;
        float ml_campari = 60.0; // Restablecido (sin x5)
        float ml_vermut = (customMixerOz > 0) ? customMixerOz * 30.0 : 60.0;
        // Gin: Bomba 3 (idx 2), Posición POS_PUMP_3_4
        itemsToDispense[totalDispenseItems++] = {
            2, POS_PUMP_3_4, (unsigned long)((ml_gin / b_ml_ps[2]) * 1000)};
        // Vermut Rosso: Bomba 5 (idx 4), Posición POS_PUMP_5_6
        itemsToDispense[totalDispenseItems++] = {
            4, POS_PUMP_5_6, (unsigned long)((ml_vermut / b_ml_ps[4]) * 1000)};
        // Campari: Bomba 7 (idx 6), Posición POS_PUMP_7 (swapped)
        itemsToDispense[totalDispenseItems++] = {
            6, POS_PUMP_7, (unsigned long)((ml_campari / b_ml_ps[6]) * 1000)};
      } else if (currentRecipeId == "boulevardier") {
        float ml_whisky = (customAlcoholOz > 0) ? customAlcoholOz * 30.0 : 60.0;
        float ml_campari = 60.0; // Restablecido (sin x5)
        float ml_vermut = (customMixerOz > 0) ? customMixerOz * 30.0 : 60.0;
        // Whisky: Bomba 6 (idx 5), Posición POS_PUMP_5_6
        itemsToDispense[totalDispenseItems++] = {
            5, POS_PUMP_5_6, (unsigned long)((ml_whisky / b_ml_ps[5]) * 1000)};
        // Vermut Rosso: Bomba 5 (idx 4), Posición POS_PUMP_5_6
        itemsToDispense[totalDispenseItems++] = {
            4, POS_PUMP_5_6, (unsigned long)((ml_vermut / b_ml_ps[4]) * 1000)};
        // Campari: Bomba 7 (idx 6), Posición POS_PUMP_7 (swapped)
        itemsToDispense[totalDispenseItems++] = {
            6, POS_PUMP_7, (unsigned long)((ml_campari / b_ml_ps[6]) * 1000)};
      } else if (currentRecipeId == "godfather") {
        float ml_whisky =
            (customAlcoholOz > 0) ? customAlcoholOz * 30.0 : 120.0;
        float ml_amaretto = (customMixerOz > 0) ? customMixerOz * 30.0 : 60.0;
        // Whisky: Bomba 6 (idx 5), Posición POS_PUMP_5_6
        itemsToDispense[totalDispenseItems++] = {
            5, POS_PUMP_5_6, (unsigned long)((ml_whisky / b_ml_ps[5]) * 1000)};
        // Amaretto: Bomba 2 (idx 1), Posición POS_PUMP_1_2
        itemsToDispense[totalDispenseItems++] = {
            1, POS_PUMP_1_2,
            (unsigned long)((ml_amaretto / b_ml_ps[1]) * 1000)};
      } else if (currentRecipeId == "americano") {
        float ml_campari = (customAlcoholOz > 0) ? customAlcoholOz * 30.0
                                                 : 90.0; // Restablecido (sin x5)
        float ml_vermut = (customMixerOz > 0) ? customMixerOz * 30.0 : 90.0;
        // Vermut Rosso: Bomba 5 (idx 4), Posición POS_PUMP_5_6
        itemsToDispense[totalDispenseItems++] = {
            4, POS_PUMP_5_6, (unsigned long)((ml_vermut / b_ml_ps[4]) * 1000)};
        // Campari: Bomba 7 (idx 6), Posición POS_PUMP_7 (swapped)
        itemsToDispense[totalDispenseItems++] = {
            6, POS_PUMP_7, (unsigned long)((ml_campari / b_ml_ps[6]) * 1000)};
      } else if (currentRecipeId == "whisky_rocks") {
        float ml_whisky =
            (customAlcoholOz > 0) ? customAlcoholOz * 30.0 : 120.0;
        // Whisky: Bomba 6 (idx 5), Posición POS_PUMP_5_6
        itemsToDispense[totalDispenseItems++] = {
            5, POS_PUMP_5_6, (unsigned long)((ml_whisky / b_ml_ps[5]) * 1000)};
      } else if (currentRecipeId == "campari_rocks") {
        float ml_campari = (customAlcoholOz > 0) ? customAlcoholOz * 30.0
                                                 : 120.0; // Restablecido (sin x5)
        // Campari: Bomba 7 (idx 6), Posición POS_PUMP_7 (swapped)
        itemsToDispense[totalDispenseItems++] = {
            6, POS_PUMP_7, (unsigned long)((ml_campari / b_ml_ps[6]) * 1000)};
      } else if (currentRecipeId == "gin_tonic") {
        float ml_gin = (customAlcoholOz > 0) ? customAlcoholOz * 30.0 : 120.0;
        float ml_tonic = (customMixerOz > 0)
                             ? customMixerOz * 30.0
                             : 260.0; // Reducido de 180.0 a 130.0, 50ml menos!
        // Gin: Bomba 3 (idx 2), Posición POS_PUMP_3_4
        itemsToDispense[totalDispenseItems++] = {
            2, POS_PUMP_3_4, (unsigned long)((ml_gin / b_ml_ps[2]) * 1000)};
        // Tonic (Coca-Cola / Mixer): Bomba 4 (idx 3), Posición POS_PUMP_3_4
        // (swapped)
        itemsToDispense[totalDispenseItems++] = {
            3, POS_PUMP_3_4, (unsigned long)((ml_tonic / b_ml_ps[3]) * 1000)};
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
      step_timer = now + (SIMULAR_MOTOR ? 1500 : 0);
    } break;

    case STEP_AGITATION_SYSTEM:
      if (!mover_a(POS_STIR)) {
        handleMovementError("Fallo motor al mover a posicion de mezcla");
        return;
      }
      stir_state = 0;
      step_timer = now + (SIMULAR_MOTOR ? 1500 : 0);
      break;

    case STEP_CARBONATED_STATION:
      // Carbonatación se simula con delay
      step_timer = now + 1200;
      break;

    case STEP_READY:
      if (!SIMULAR_MOTOR) {
        if (!home()) {
          handleMovementError("Fallo motor al retornar a home final");
          return;
        }
      } else {
        if (!mover_a(POS_READY)) {
          handleMovementError("Fallo motor al mover a posicion listo");
          return;
        }
      }
      step_timer = now + (SIMULAR_MOTOR ? 1500 : 0) + 500;
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
      delay(1200); // Retardo físico de caída de vaso (pequeño bloqueo tolerado
                   // en transicion)
      servo_pos(0, 0);
      delay(500);

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
            step_timer = now + (SIMULAR_MOTOR ? 1500 : 0);
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

      if (!SIMULAR_MOTOR) {
        motor_stop(); // Apaga bobinas al terminar
      }

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
  if (!SIMULAR_MOTOR) {
    if (!home()) {
      Serial.println("ERROR CRITICO: Fallo la calibracion Home inicial al "
                     "iniciar preparacion.");
      status = STATUS_ERROR;
      errorMessage = "Fallo en calibracion Home";
      publishState();
      return;
    }
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

  bool ok = false;

  if (cmd == "POWER") {
    isOn = (val == "ON");
    if (!isOn) {
      resetPreparationState();
    }
    ok = true;
  } else if (!isOn) {
    Serial.println("Comando rechazado: Maquina apagada");
  } else if (cmd == "PREPARE") {
    if (status != STATUS_IDLE) {
      Serial.println("Maquina ocupada");
    } else {
      pendingRecipeId = val;
      pendingIceCount = doc["iceCount"] | 2;
      pendingAlcoholOz = doc["alcoholOz"] | 0.0;
      pendingMixerOz = doc["mixerOz"] | 0.0;
      pendingPrepare = true;
      ok = true;
    }
  } else if (cmd == "CLEAN") {
    if (status != STATUS_IDLE) {
      Serial.println("Maquina ocupada");
    } else {
      startCleaning();
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
    Serial.println("Recibido comando de calibracion SET_CALIB...");
    preferences.begin("kraken", false);

    if (doc.containsKey("rates")) {
      JsonArray rates = doc["rates"];
      for (int i = 0; i < 7; i++) {
        if (!rates[i].isNull()) {
          b_ml_ps[i] = rates[i].as<float>();
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
  } else if (cmd == "TEST_HW") {
    String type = doc["type"] | "";
    int val = doc["val"] | 0;

    if (type == "pump") {
      int pin = doc["pin"] | 1;
      int idx = pin - 1;
      int duration = doc["duration"] | 3000;
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
      int pin = doc["pin"] | 1;
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
      int duration = doc["duration"] | 0;
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
      if (!SIMULAR_MOTOR) {
        motor_steps(val);
      } else {
        Serial.print("[SIMULACION] Moviendo motor steps: ");
        Serial.println(val);
      }
    } else if (type == "motor_home") {
      if (!SIMULAR_MOTOR) {
        home();
      } else {
        Serial.println("[SIMULACION] Ejecutando Home...");
      }
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
      delay(500);
      servo_pos(0, 180);
      delay(1200);
      servo_pos(0, 0);
      delay(500);
    } else if (type == "hielo_test") {
      Serial.println("MQTT: Ejecutando ciclo de prueba del hielo");
      servo_pos(1, 180);
      delay(500);
      servo_pos(1, 0);
      delay(1000);
      servo_pos(1, 180);
      delay(500);
    } else if (type == "cuchara_test") {
      Serial.println("MQTT: Ejecutando ciclo de prueba de la cuchara");
      servo_cont_set(100); // Bajar
      delay(1800);
      Serial.println("Agitando rapidamente...");
      for (int k = 0; k < 6; k++) {
        servo_cont_set(-100); // Subir harto
        delay(600);           // Aumentado a 600ms para mayor recorrido
        servo_cont_set(100);  // Bajar harto
        delay(600);           // Aumentado a 600ms para mayor recorrido
      }
      servo_cont_set(-100); // Subir
      delay(1800);
      servo_cont_set(0); // Detener
    }
    ok = true;
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
  if (!SIMULAR_MOTOR) {
    if (!home()) {
      Serial.println("Falla de Home. Abortando prueba completa.");
      return;
    }
  } else {
    Serial.println("[SIMULACION] Ejecutando Home...");
  }

  // 1. Vaso (0 -> 180 -> 0)
  Serial.println("Paso 1: Posicion 3600 - vaso");
  if (!mover_a(3600)) {
    Serial.println("Falla al mover a vaso. Abortando prueba.");
    return;
  }
  servo_pos(0, 0);
  delay(500);
  servo_pos(0, 180);
  delay(1200);
  servo_pos(0, 0);
  delay(1000);

  // 2. Hielo (Compuerta en 180 -> 0 -> 180)
  Serial.println("Paso 2: Posicion 2600 - hielo");
  if (!mover_a(2600)) {
    Serial.println("Falla al mover a hielo. Abortando prueba.");
    return;
  }
  servo_pos(1, 180);
  servo_pos(2, 180);
  delay(500);
  // Compuerta 1
  servo_pos(1, 0);
  delay(1000);
  servo_pos(1, 180);
  delay(1000);

  // 3. Bombas (Activadas una por una en secuencia)
  Serial.println("Paso 3: Posicion 1860 - bombas 1 y 2");
  if (!mover_a(1860)) {
    Serial.println("Falla al mover a bombas 1 y 2. Abortando prueba.");
    return;
  }
  Serial.println("Encendiendo Bomba 1...");
  digitalWrite(B_PIN[0], HIGH);
  delay(2000);
  digitalWrite(B_PIN[0], LOW);
  delay(1500); // Esperar fin de goteo
  Serial.println("Encendiendo Bomba 2...");
  digitalWrite(B_PIN[1], HIGH);
  delay(2000);
  digitalWrite(B_PIN[1], LOW);
  delay(1500); // Esperar fin de goteo

  Serial.println("Paso 4: Posicion 1600 - bombas 3 y 4");
  if (!mover_a(1600)) {
    Serial.println("Falla al mover a bombas 3 y 4. Abortando prueba.");
    return;
  }
  Serial.println("Encendiendo Bomba 3...");
  digitalWrite(B_PIN[2], HIGH);
  delay(2000);
  digitalWrite(B_PIN[2], LOW);
  delay(1500);
  Serial.println("Encendiendo Bomba 4...");
  digitalWrite(B_PIN[3], HIGH);
  delay(2000);
  digitalWrite(B_PIN[3], LOW);
  delay(1500);

  Serial.println("Paso 5: Posicion 1350 - bombas 5 y 6");
  if (!mover_a(1350)) {
    Serial.println("Falla al mover a bombas 5 y 6. Abortando prueba.");
    return;
  }
  Serial.println("Encendiendo Bomba 5...");
  digitalWrite(B_PIN[4], HIGH);
  delay(2000);
  digitalWrite(B_PIN[4], LOW);
  delay(1500);
  Serial.println("Encendiendo Bomba 6...");
  digitalWrite(B_PIN[5], HIGH);
  delay(2000);
  digitalWrite(B_PIN[5], LOW);
  delay(1500);

  Serial.println("Paso 6: Posicion 1200 - bomba 7");
  if (!mover_a(1200)) {
    Serial.println("Falla al mover a bomba 7. Abortando prueba.");
    return;
  }
  Serial.println("Encendiendo Bomba 7...");
  digitalWrite(B_PIN[6], HIGH);
  delay(2000);
  digitalWrite(B_PIN[6], LOW);
  delay(1500); // Esperar fin de goteo before moving

  // 4. Cuchara (Agitación - Penúltimo Paso)
  Serial.println("Paso 7: Posicion 800 - cuchara (agitador)");
  if (!mover_a(800)) {
    Serial.println("Falla al mover a cuchara. Abortando prueba.");
    return;
  }
  servo_cont_set(100); // Bajar completo
  delay(1800);         // Reducido de 3000 a 1800

  Serial.println("Agitando rapidamente arriba y abajo...");
  for (int k = 0; k < 6; k++) {
    servo_cont_set(-100); // Subir harto
    delay(600);           // Aumentado a 600ms para mayor recorrido
    servo_cont_set(100);  // Bajar harto
    delay(600);           // Aumentado a 600ms para mayor recorrido
  }

  servo_cont_set(-100); // Subir completo
  delay(1800);          // Reducido de 3000 a 1800
  servo_cont_set(0);    // Detener

  // 5. Home final
  Serial.println("Paso 8: Home final");
  if (!SIMULAR_MOTOR) {
    if (!home()) {
      Serial.println("Falla de Home final. Abortando.");
      return;
    }
  } else {
    Serial.println("[SIMULACION] Ejecutando Home...");
  }

  Serial.println("Prueba completa terminada.");
}

void test_maquina_seco() {
  Serial.println("Iniciando prueba en seco de la maquina...");
  if (!SIMULAR_MOTOR) {
    if (!home()) {
      Serial.println("Falla de Home. Abortando prueba en seco.");
      return;
    }
  } else {
    Serial.println("[SIMULACION] Ejecutando Home...");
  }

  // 1. Vaso (0 -> 180 -> 0)
  Serial.println("Paso 1: Posicion 3600 - vaso");
  if (!mover_a(3600)) {
    Serial.println("Falla al mover a vaso (Seco). Abortando.");
    return;
  }
  servo_pos(0, 0);
  delay(500);
  servo_pos(0, 180);
  delay(1200);
  servo_pos(0, 0);
  delay(1000);

  // 2. Hielo (Compuerta en 180 -> 0 -> 180)
  Serial.println("Paso 2: Posicion 2600 - hielo");
  if (!mover_a(2600)) {
    Serial.println("Falla al mover a hielo (Seco). Abortando.");
    return;
  }
  servo_pos(1, 180);
  servo_pos(2, 180);
  delay(500);
  // Compuerta 1
  servo_pos(1, 0);
  delay(1000);
  servo_pos(1, 180);
  delay(1000);

  // 3. Bombas (Recorrido en seco, sin encender pines, secuencial)
  Serial.println("Paso 3: Posicion 1860 - bombas 1 y 2 (Seco)");
  if (!mover_a(1860)) {
    Serial.println("Falla al mover a bombas 1 y 2 (Seco). Abortando.");
    return;
  }
  delay(2000);
  delay(1500);
  delay(2000);
  delay(1500);

  Serial.println("Paso 4: Posicion 1600 - bombas 3 y 4 (Seco)");
  if (!mover_a(1600)) {
    Serial.println("Falla al mover a bombas 3 y 4 (Seco). Abortando.");
    return;
  }
  delay(2000);
  delay(1500);
  delay(2000);
  delay(1500);

  Serial.println("Paso 5: Posicion 1350 - bombas 5 y 6 (Seco)");
  if (!mover_a(1350)) {
    Serial.println("Falla al mover a bombas 5 y 6 (Seco). Abortando.");
    return;
  }
  delay(2000);
  delay(1500);
  delay(2000);
  delay(1500);

  Serial.println("Paso 6: Posicion 1200 - bomba 7 (Seco)");
  if (!mover_a(1200)) {
    Serial.println("Falla al mover a bomba 7 (Seco). Abortando.");
    return;
  }
  delay(2000);
  delay(1500);

  // 4. Cuchara (Agitación - Penúltimo Paso)
  Serial.println("Paso 7: Posicion 800 - cuchara (agitador)");
  if (!mover_a(800)) {
    Serial.println("Falla al mover a cuchara (Seco). Abortando.");
    return;
  }
  servo_cont_set(100); // Bajar completo
  delay(1800);         // Reducido de 3000 a 1800

  Serial.println("Agitando rapidamente arriba y abajo...");
  for (int k = 0; k < 6; k++) {
    servo_cont_set(-100); // Subir harto (velocidad 100)
    delay(600);           // Aumentado a 600ms para mayor recorrido
    servo_cont_set(100);  // Bajar harto (velocidad 100)
    delay(600);           // Aumentado a 600ms para mayor recorrido
  }

  servo_cont_set(-100); // Subir completo
  delay(1800);          // Reducido de 3000 a 1800
  servo_cont_set(0);    // Detener

  // 5. Home final
  Serial.println("Paso 8: Home final");
  if (!SIMULAR_MOTOR) {
    if (!home()) {
      Serial.println("Falla de Home final (Seco). Abortando.");
      return;
    }
  } else {
    Serial.println("[SIMULACION] Ejecutando Home...");
  }

  Serial.println("Prueba en seco terminada.");
}
