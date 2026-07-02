#include <Arduino.h>
#include <ArduinoJson.h>
#include <ESP32Servo.h>
#include <PubSubClient.h>
#include <WiFi.h>

// ═══════════════════════════════════════════
//  CONFIGURACIÓN DE RED Y MQTT
// ═══════════════════════════════════════════
// Cambia estas constantes según tu red local y la IP de tu PC con Mosquitto
const char *WIFI_SSID = "TU_WIFI";
const char *WIFI_PASSWORD = "TU_CLAVE_WIFI";
const char *MQTT_HOST = "192.168.1.14"; // IP de la PC donde corre Mosquitto
const int MQTT_PORT = 1883;

// Tópicos MQTT
const char *TOPIC_STATE = "penpito/kraken/state";
const char *TOPIC_COMMAND = "penpito/kraken/command";
const char *TOPIC_ACK = "penpito/kraken/command/ack";

// ═══════════════════════════════════════════
//  MODO DE PRUEBA / SIMULACIÓN
// ═══════════════════════════════════════════
const bool SIMULAR_MOTOR =
    true; // CAMBIAR A 'false' cuando conectes el NEMA17 físico

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
const int B_PIN[] = {12, 13, 19, 25, 26, 32, 33};
const int NUM_BOMBAS = 7;

// Calibraciones pregrabadas según tus medidas (ml por segundo)
float b_ml_ps[7] = {
    257.0 / 10.0, // B1 (Pisco): 25.7 ml/s
    258.0 / 10.0, // B2 (Amaretto): 25.8 ml/s
    35.0 / 10.0,  // B3 (Gin): 3.5 ml/s
    262.0 / 10.0, // B4 (Campari): 26.2 ml/s
    97.0 / 10.0,  // B5 (Vermut Rosso): 9.7 ml/s
    275.0 / 10.0, // B6 (Whisky): 27.5 ml/s
    260.0 / 10.0  // B7 (Coca-Cola, default): 26.0 ml/s
};
unsigned long pump_stop_time[7] = {
    0}; // Tiempos de apagado no bloqueante para bombas
unsigned long srv_cont_stop_time = 0; // Tiempo de parada de servo continuo

// SERVOS
Servo srv_pos[3];
const int SRV_PIN[] = {22, 23, 27};
Servo srv_cont;
const int SRV_CONT_PIN = 14;
const int SRV_CONT_STOP = 90;
const int SRV_CONT_TRIM = 0;

// MOTOR NEMA17 + A4988
const int MOTOR_STEP = 5;
const int MOTOR_DIR = 18;
const int MOTOR_ENABLE = 4; // LOW = Habilitado, HIGH = Apagado
const int LIMIT_SW = 34;    // Pull-down externo de 10k
volatile bool limit_triggered = false;

void IRAM_ATTR on_limit() { limit_triggered = true; }

// POSICIONES FÍSICAS (Pasos desde el Home)
#define POS_CUP 400
#define POS_ICE 1200
#define POS_LIQUID 2400
#define POS_STIR 3600
#define POS_READY 0

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

// Variables de control de secuencia no bloqueante
bool step_in_progress = false;
unsigned long step_timer = 0;
bool waiting_for_pumps = false;
int ice_cycle_count = 0;
int ice_cycle_state =
    0; // 0 = abrir g1, 1 = cerrar g1, 2 = abrir g2, 3 = cerrar g2
int stir_state =
    0; // Estado de agitación: 0=bajar, 1=revolver, 2=subir, 3=detener

// Clientes Wi-Fi y MQTT
WiFiClient espClient;
PubSubClient client(espClient);
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
void home();
void mover_a(int target);

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

  // Servos posicionales
  for (int i = 0; i < 3; i++) {
    srv_pos[i].setPeriodHertz(50);
    srv_pos[i].attach(SRV_PIN[i], 500, 2400);
    srv_pos[i].write(90);
  }

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
  delayMicroseconds(1000);
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
  if (n == 0)
    return true;
  digitalWrite(MOTOR_DIR, (n > 0) ? HIGH : LOW);
  digitalWrite(MOTOR_ENABLE, LOW); // Activar bobinas
  delayMicroseconds(10);

  bool completed = true;
  for (int i = 0; i < abs(n); i++) {
    if (limit_triggered || is_limit_pressed()) {
      motor_stop();
      limit_triggered = false;
      completed = false;
      break;
    }
    motor_step();
    motor_pos += (n > 0) ? 1 : -1;
  }
  return completed;
}

void home() {
  Serial.println("Buscando Home...");
  limit_triggered = false;
  digitalWrite(MOTOR_DIR, LOW);
  digitalWrite(MOTOR_ENABLE, LOW);
  delayMicroseconds(10);

  while (!limit_triggered && !is_limit_pressed()) {
    motor_step();
  }

  digitalWrite(MOTOR_STEP, LOW);
  motor_pos = 0;
  delay(500);

  // Retroceso de seguridad
  digitalWrite(MOTOR_DIR, HIGH);
  for (int i = 0; i < 100; i++) {
    motor_step();
  }
  motor_pos = 100;
  limit_triggered = false;
}

void mover_a(int target) {
  if (SIMULAR_MOTOR) {
    Serial.print("[SIMULACION MOTOR] Carro 'viajando' a posicion ");
    Serial.println(target);
    return;
  }
  int diff = target - motor_pos;
  motor_steps(diff);
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
      mover_a(POS_CUP);
      // Si simula motor, sumamos delay de viaje. Si no, va directo.
      step_timer = now + (SIMULAR_MOTOR ? 1500 : 0) + 1000;
      break;

    case STEP_ICE_DISPENSER:
      mover_a(POS_ICE);
      ice_cycle_count = 0;
      ice_cycle_state = 0;
      // Establece timer de ejecucion del dispensado de hielo
      step_timer = now + (SIMULAR_MOTOR ? 1500 : 0);
      break;

    case STEP_ALCOHOL_DISPENSER:
      mover_a(POS_LIQUID);
      // Esperamos a que llegue el motor y luego activamos las bombas
      step_timer = now + (SIMULAR_MOTOR ? 1500 : 0);
      waiting_for_pumps = false;
      break;

    case STEP_AGITATION_SYSTEM:
      mover_a(POS_STIR);
      stir_state = 0;
      step_timer = now + (SIMULAR_MOTOR ? 1500 : 0);
      break;

    case STEP_CARBONATED_STATION:
      // Carbonatación se simula con delay
      step_timer = now + 1200;
      break;

    case STEP_READY:
      mover_a(POS_READY);
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
      servo_pos(0, 90);
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
        // Secuencia secuencial para soltar cubos de hielo
        if (ice_cycle_state == 0) {
          servo_pos(1, 180); // Abre compuerta 1
          step_timer = now + 800;
          ice_cycle_state = 1;
        } else if (ice_cycle_state == 1) {
          servo_pos(1, 90); // Cierra compuerta 1
          step_timer = now + 800;
          ice_cycle_state = 2;
        } else if (ice_cycle_state == 2) {
          servo_pos(2, 180); // Abre compuerta 2
          step_timer = now + 800;
          ice_cycle_state = 3;
        } else if (ice_cycle_state == 3) {
          servo_pos(2, 90); // Cierra compuerta 2
          step_timer = now + 800;
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
    if (now >= step_timer && !waiting_for_pumps) {
      // Iniciamos el encendido de las bombas en paralelo
      waiting_for_pumps = true;

      float ml_pisco = 90; // Default Normal (3 oz)
      float ml_cola = 225; // Default Normal (7.5 oz)

      if (customAlcoholOz > 0)
        ml_pisco = customAlcoholOz * 30.0;
      if (customMixerOz > 0)
        ml_cola = customMixerOz * 30.0;

      if (currentRecipeId == "piscola") {
        unsigned long t_pisco = (ml_pisco / b_ml_ps[0]) * 1000;
        unsigned long t_cola = (ml_cola / b_ml_ps[6]) * 1000;

        Serial.print("Piscola -> Pisco: ");
        Serial.print(ml_pisco);
        Serial.print("ml (");
        Serial.print(t_pisco);
        Serial.println("ms)");
        Serial.print("Piscola -> Cola: ");
        Serial.print(ml_cola);
        Serial.print("ml (");
        Serial.print(t_cola);
        Serial.println("ms)");

        digitalWrite(B_PIN[0], HIGH);
        pump_stop_time[0] = millis() + t_pisco;
        digitalWrite(B_PIN[6], HIGH);
        pump_stop_time[6] = millis() + t_cola;
      } else if (currentRecipeId == "negroni") {
        float ml_gin = (customAlcoholOz > 0) ? customAlcoholOz * 30.0 : 30.0;
        float ml_campari = 30.0;
        float ml_vermut = (customMixerOz > 0) ? customMixerOz * 30.0 : 30.0;

        unsigned long t_gin = (ml_gin / b_ml_ps[2]) * 1000;
        unsigned long t_campari = (ml_campari / b_ml_ps[3]) * 1000;
        unsigned long t_vermut = (ml_vermut / b_ml_ps[4]) * 1000;

        digitalWrite(B_PIN[2], HIGH);
        pump_stop_time[2] = millis() + t_gin;
        digitalWrite(B_PIN[3], HIGH);
        pump_stop_time[3] = millis() + t_campari;
        digitalWrite(B_PIN[4], HIGH);
        pump_stop_time[4] = millis() + t_vermut;
      } else if (currentRecipeId == "boulevardier") {
        float ml_whisky = (customAlcoholOz > 0) ? customAlcoholOz * 30.0 : 30.0;
        float ml_campari = 30.0;
        float ml_vermut = (customMixerOz > 0) ? customMixerOz * 30.0 : 30.0;

        unsigned long t_whisky = (ml_whisky / b_ml_ps[5]) * 1000;
        unsigned long t_campari = (ml_campari / b_ml_ps[3]) * 1000;
        unsigned long t_vermut = (ml_vermut / b_ml_ps[4]) * 1000;

        digitalWrite(B_PIN[5], HIGH);
        pump_stop_time[5] = millis() + t_whisky;
        digitalWrite(B_PIN[3], HIGH);
        pump_stop_time[3] = millis() + t_campari;
        digitalWrite(B_PIN[4], HIGH);
        pump_stop_time[4] = millis() + t_vermut;
      } else if (currentRecipeId == "godfather") {
        float ml_whisky = (customAlcoholOz > 0) ? customAlcoholOz * 30.0 : 60.0;
        float ml_amaretto = (customMixerOz > 0) ? customMixerOz * 30.0 : 30.0;

        unsigned long t_whisky = (ml_whisky / b_ml_ps[5]) * 1000;
        unsigned long t_amaretto = (ml_amaretto / b_ml_ps[1]) * 1000;

        digitalWrite(B_PIN[5], HIGH);
        pump_stop_time[5] = millis() + t_whisky;
        digitalWrite(B_PIN[1], HIGH);
        pump_stop_time[1] = millis() + t_amaretto;
      } else if (currentRecipeId == "americano") {
        float ml_campari =
            (customAlcoholOz > 0) ? customAlcoholOz * 30.0 : 45.0;
        float ml_vermut = (customMixerOz > 0) ? customMixerOz * 30.0 : 45.0;

        unsigned long t_campari = (ml_campari / b_ml_ps[3]) * 1000;
        unsigned long t_vermut = (ml_vermut / b_ml_ps[4]) * 1000;

        digitalWrite(B_PIN[3], HIGH);
        pump_stop_time[3] = millis() + t_campari;
        digitalWrite(B_PIN[4], HIGH);
        pump_stop_time[4] = millis() + t_vermut;
      } else if (currentRecipeId == "whisky_rocks") {
        float ml_whisky = (customAlcoholOz > 0) ? customAlcoholOz * 30.0 : 60.0;
        unsigned long t_whisky = (ml_whisky / b_ml_ps[5]) * 1000;

        digitalWrite(B_PIN[5], HIGH);
        pump_stop_time[5] = millis() + t_whisky;
      } else if (currentRecipeId == "campari_rocks") {
        float ml_campari =
            (customAlcoholOz > 0) ? customAlcoholOz * 30.0 : 60.0;
        unsigned long t_campari = (ml_campari / b_ml_ps[3]) * 1000;

        digitalWrite(B_PIN[3], HIGH);
        pump_stop_time[3] = millis() + t_campari;
      }
    }

    if (waiting_for_pumps) {
      // Monitorea si todas las bombas ya terminaron (tiempo es 0)
      bool bombas_corriendo = false;
      for (int i = 0; i < NUM_BOMBAS; i++) {
        if (pump_stop_time[i] > 0) {
          bombas_corriendo = true;
          break;
        }
      }
      if (!bombas_corriendo) {
        waiting_for_pumps = false;
        step_in_progress = false;
        activeStep = nextStepAfter(activeStep);
        publishState();
      }
    }
    break;

  case STEP_AGITATION_SYSTEM:
    if (now >= step_timer) {
      if (stir_state == 0) {
        Serial.println("Agitacion: Bajando cuchara...");
        servo_cont_set(100); // bajar
        step_timer = now + TIEMPO_BAJAR_CUCHARA;
        stir_state = 1;
      } else if (stir_state == 1) {
        Serial.println("Agitacion: Revolviendo trago...");
        servo_cont_set(60); // girar para agitar
        step_timer = now + TIEMPO_AGITACION;
        stir_state = 2;
      } else if (stir_state == 2) {
        Serial.println("Agitacion: Subiendo cuchara...");
        servo_cont_set(-100); // subir
        step_timer = now + TIEMPO_SUBIR_CUCHARA;
        stir_state = 3;
      } else if (stir_state == 3) {
        servo_cont_set(0); // detener
        Serial.println("Agitacion: Cuchara arriba.");

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
      int ice = doc["iceCount"] | 2;
      float alc = doc["alcoholOz"] | 0.0;
      float mix = doc["mixerOz"] | 0.0;
      startPreparation(val, ice, alc, mix);
      ok = true;
    }
  } else if (cmd == "CLEAN") {
    if (status != STATUS_IDLE) {
      Serial.println("Maquina ocupada");
    } else {
      startCleaning();
      ok = true;
    }
  } else if (cmd == "CONFIG_WIFI") {
    // Configuración recibida por el panel de administración
    // En producción se guardaría en Preferences (NVS), aquí respondemos OK
    Serial.println("Nueva config de red recibida. Guardando...");
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
