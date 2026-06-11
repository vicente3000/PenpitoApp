#include <Arduino.h>
#include <ArduinoJson.h>
#include <WebServer.h>
#include <WiFi.h>

// ESP32 + A4988 + NEMA 17 + final de carrera.
// La app movil controla este firmware por HTTP:
//   GET  /state
//   POST /command  {"cmd":"PREPARE","val":"piscola","iceCount":2}

#define STEP_PIN 18
#define DIR_PIN 19
#define ENABLE_PIN 23

#define SLEEP_PIN 22
#define RESET_PIN 21

#define MS1_PIN 25
#define MS2_PIN 26
#define MS3_PIN 27

#define ENDSTOP_PIN 32

const char* WIFI_SSID = "Penpito-Kraken";
const char* WIFI_PASSWORD = "penpito123";

const int STEPS_PER_REV = 200;
const int MICROSTEPS = 16;
const int PULSES_PER_REV = STEPS_PER_REV * MICROSTEPS;
const int STEP_DELAY_US = 100;
const bool DIRECCION_IR_AL_SWITCH = false;
const bool DIRECCION_VOLVER_INICIO = !DIRECCION_IR_AL_SWITCH;
const long MAX_HOMING_STEPS = PULSES_PER_REV * 20L;

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

WebServer server(80);

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
unsigned long stepStartedAt = 0;
unsigned long readyStartedAt = 0;

void setupHardware();
void setupWifi();
void setupRoutes();
void handleCors();
void handleOptions();
void handleState();
void handleCommand();
void sendJsonResponse(int code, JsonDocument& doc);
void serializeState(JsonObject state);
const char* statusToString();
const char* stepToString(PreparationStep step);
PreparationStep nextStepAfter(PreparationStep step);
bool recipeNeedsAgitation(const String& recipeId);
bool recipeNeedsCarbonation(const String& recipeId);
void startPreparation(const String& recipeId, int iceCount);
void startCleaning();
void updateMachine();
void completeActiveStep();
void resetPreparationState();
void ejecutarRecorrido();
long avanzarHastaFinal();
void volverAlInicio(long pasos);
void moverMotor(long pasos, bool direccion);
void darPaso();
bool finalPistaActivado();

void setup() {
  Serial.begin(115200);
  setupHardware();
  setupWifi();
  setupRoutes();
  Serial.println("Kraken listo para recibir comandos desde la app movil.");
}

void loop() {
  server.handleClient();
  updateMachine();
}

void setupHardware() {
  pinMode(STEP_PIN, OUTPUT);
  pinMode(DIR_PIN, OUTPUT);
  pinMode(ENABLE_PIN, OUTPUT);
  pinMode(SLEEP_PIN, OUTPUT);
  pinMode(RESET_PIN, OUTPUT);
  pinMode(MS1_PIN, OUTPUT);
  pinMode(MS2_PIN, OUTPUT);
  pinMode(MS3_PIN, OUTPUT);
  pinMode(ENDSTOP_PIN, INPUT_PULLUP);

  digitalWrite(ENABLE_PIN, LOW);
  digitalWrite(RESET_PIN, HIGH);
  digitalWrite(SLEEP_PIN, HIGH);
  digitalWrite(MS1_PIN, HIGH);
  digitalWrite(MS2_PIN, HIGH);
  digitalWrite(MS3_PIN, HIGH);
}

void setupWifi() {
  WiFi.mode(WIFI_AP);
  WiFi.softAP(WIFI_SSID, WIFI_PASSWORD);

  Serial.print("WiFi AP: ");
  Serial.println(WIFI_SSID);
  Serial.print("IP Kraken: ");
  Serial.println(WiFi.softAPIP());
}

void setupRoutes() {
  server.on("/state", HTTP_GET, handleState);
  server.on("/command", HTTP_POST, handleCommand);
  server.on("/state", HTTP_OPTIONS, handleOptions);
  server.on("/command", HTTP_OPTIONS, handleOptions);
  server.begin();
}

void handleCors() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type,Accept");
}

void handleOptions() {
  handleCors();
  server.send(204);
}

void handleState() {
  JsonDocument doc;
  serializeState(doc.to<JsonObject>());
  sendJsonResponse(200, doc);
}

void handleCommand() {
  JsonDocument input;
  DeserializationError error = deserializeJson(input, server.arg("plain"));

  JsonDocument output;
  JsonObject state = output["state"].to<JsonObject>();
  bool ok = false;

  if (error) {
    output["ok"] = false;
    output["message"] = "JSON invalido";
    serializeState(state);
    sendJsonResponse(400, output);
    return;
  }

  String cmd = input["cmd"] | "";
  String val = input["val"] | "";

  if (cmd == "POWER") {
    isOn = val == "ON";
    if (!isOn) {
      resetPreparationState();
    }
    ok = true;
  } else if (!isOn) {
    output["message"] = "Maquina apagada";
  } else if (cmd == "PREPARE") {
    if (status != STATUS_IDLE) {
      output["message"] = "Maquina ocupada";
    } else {
      startPreparation(val, input["iceCount"] | 2);
      ok = true;
    }
  } else if (cmd == "CLEAN") {
    if (status != STATUS_IDLE) {
      output["message"] = "Maquina ocupada";
    } else {
      startCleaning();
      ok = true;
    }
  } else {
    output["message"] = "Comando no soportado";
  }

  output["ok"] = ok;
  serializeState(state);
  sendJsonResponse(ok ? 200 : 409, output);
}

void sendJsonResponse(int code, JsonDocument& doc) {
  String body;
  serializeJson(doc, body);
  handleCors();
  server.send(code, "application/json", body);
}

void serializeState(JsonObject state) {
  state["isOn"] = isOn;
  state["status"] = statusToString();
  if (errorMessage.length()) {
    state["errorMessage"] = errorMessage;
  } else {
    state["errorMessage"] = nullptr;
  }
  if (currentRecipeId.length()) {
    state["currentRecipeId"] = currentRecipeId;
  } else {
    state["currentRecipeId"] = nullptr;
  }
  state["requestedIceCount"] = requestedIceCount;
  state["activeStepId"] = activeStep == STEP_NONE ? nullptr : stepToString(activeStep);
  state["isDrinkReady"] = isDrinkReady;

  JsonArray completed = state["completedStepIds"].to<JsonArray>();
  for (int index = 0; index < activeStep && activeStep != STEP_NONE; index += 1) {
    PreparationStep step = static_cast<PreparationStep>(index);
    if ((step == STEP_ICE_DISPENSER && skipIce) ||
        (step == STEP_AGITATION_SYSTEM && skipAgitation) ||
        (step == STEP_CARBONATED_STATION && skipCarbonation)) {
      continue;
    }
    completed.add(stepToString(step));
  }

  JsonArray skipped = state["skippedStepIds"].to<JsonArray>();
  if (skipIce) {
    skipped.add("ice_dispenser");
  }
  if (skipAgitation) {
    skipped.add("agitation_system");
  }
  if (skipCarbonation) {
    skipped.add("carbonated_station");
  }
}

const char* statusToString() {
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

const char* stepToString(PreparationStep step) {
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
      next += 1;
      continue;
    }
    if (candidate == STEP_AGITATION_SYSTEM && skipAgitation) {
      next += 1;
      continue;
    }
    if (candidate == STEP_CARBONATED_STATION && skipCarbonation) {
      next += 1;
      continue;
    }
    return candidate;
  }

  return STEP_READY;
}

bool recipeNeedsAgitation(const String& recipeId) {
  return recipeId == "negroni";
}

bool recipeNeedsCarbonation(const String& recipeId) {
  return recipeId == "piscola" || recipeId == "gin_tonic";
}

void startPreparation(const String& recipeId, int iceCount) {
  currentRecipeId = recipeId;
  requestedIceCount = max(0, iceCount);
  skipIce = requestedIceCount == 0;
  skipAgitation = !recipeNeedsAgitation(recipeId);
  skipCarbonation = !recipeNeedsCarbonation(recipeId);
  isDrinkReady = false;
  errorMessage = "";
  status = STATUS_PREPARING;
  activeStep = nextStepAfter(STEP_NONE);
  stepStartedAt = millis();

  Serial.print("Preparando receta: ");
  Serial.println(currentRecipeId);
}

void startCleaning() {
  status = STATUS_CLEANING;
  activeStep = STEP_NONE;
  isDrinkReady = false;
  errorMessage = "";
  stepStartedAt = millis();
  Serial.println("Limpieza iniciada desde app movil.");
}

void updateMachine() {
  if (status == STATUS_PREPARING && millis() - stepStartedAt >= 1200) {
    completeActiveStep();
  }

  if (status == STATUS_CLEANING && millis() - stepStartedAt >= 3000) {
    resetPreparationState();
    Serial.println("Limpieza terminada.");
  }

  if (isDrinkReady && millis() - readyStartedAt >= 2200) {
    resetPreparationState();
  }
}

void completeActiveStep() {
  if (activeStep == STEP_CUP_DISPENSER) {
    ejecutarRecorrido();
    if (status == STATUS_ERROR) {
      return;
    }
  }

  if (activeStep == STEP_READY) {
    isDrinkReady = true;
    readyStartedAt = millis();
    Serial.println("Trago listo.");
    return;
  }

  activeStep = nextStepAfter(activeStep);
  stepStartedAt = millis();
}

void resetPreparationState() {
  status = STATUS_IDLE;
  activeStep = STEP_NONE;
  currentRecipeId = "";
  requestedIceCount = 2;
  skipIce = false;
  skipAgitation = false;
  skipCarbonation = false;
  isDrinkReady = false;
}

void ejecutarRecorrido() {
  Serial.println("Partiendo desde la posicion inicial.");
  long pasosHastaFinal = avanzarHastaFinal();

  if (pasosHastaFinal > 0) {
    delay(500);
    volverAlInicio(pasosHastaFinal);
  }

  Serial.println("Recorrido terminado. Carril en posicion inicial.");
}

long avanzarHastaFinal() {
  Serial.println("Avanzando hasta tocar el switch...");
  digitalWrite(DIR_PIN, DIRECCION_IR_AL_SWITCH ? HIGH : LOW);
  delayMicroseconds(10);

  for (long i = 0; i < MAX_HOMING_STEPS; i += 1) {
    if (finalPistaActivado()) {
      Serial.print("Switch tocado. Pasos recorridos: ");
      Serial.println(i);
      return i;
    }

    darPaso();
  }

  status = STATUS_ERROR;
  errorMessage = "No se encontro el switch de fin de carrera.";
  Serial.println(errorMessage);
  return 0;
}

void volverAlInicio(long pasos) {
  Serial.println("Volviendo a la posicion inicial...");
  moverMotor(pasos, DIRECCION_VOLVER_INICIO);
}

void moverMotor(long pasos, bool direccion) {
  digitalWrite(DIR_PIN, direccion ? HIGH : LOW);
  delayMicroseconds(10);

  for (long i = 0; i < pasos; i += 1) {
    if (direccion == DIRECCION_IR_AL_SWITCH && finalPistaActivado()) {
      Serial.println("Movimiento detenido por final de pista.");
      return;
    }

    darPaso();
  }
}

void darPaso() {
  digitalWrite(STEP_PIN, HIGH);
  delayMicroseconds(STEP_DELAY_US);
  digitalWrite(STEP_PIN, LOW);
  delayMicroseconds(STEP_DELAY_US);
}

bool finalPistaActivado() {
  if (digitalRead(ENDSTOP_PIN) == HIGH) {
    return false;
  }

  delay(5);
  return digitalRead(ENDSTOP_PIN) == LOW;
}
