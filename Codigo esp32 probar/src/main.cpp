#include <Arduino.h>
#include <ESP32Servo.h>

// ═══════════════════════════════════════════
//  PINOUT (Unificado en 1x ESP32)
// ═══════════════════════════════════════════
// BOMBAS: 1 pin de control por bomba (jumpers ENA/ENB puestos, IN2/IN4 a GND)
const int B_PIN[] = {12, 13, 19, 25, 26, 32, 33};
const int NUM_BOMBAS = 7;
float b_ml_ps[7] = {0};
unsigned long pump_stop_time[7] = {0}; // Tiempos de parada de bombas (no bloqueante)

// SERVOS
Servo srv_pos[3];
const int SRV_PIN[] = {22, 23, 27};
Servo srv_cont;
const int SRV_CONT_PIN = 14;
const int SRV_CONT_STOP = 90;
const int SRV_CONT_TRIM = 0;

// NEMA17 + A4988
const int MOTOR_STEP = 5;
const int MOTOR_DIR = 18;
const int MOTOR_ENABLE = 4; // LOW = Habilitado, HIGH = Apagado (sin energía)
const int LIMIT_SW = 34;    // Entrada digital con pull-down externo de 10k
volatile bool limit_triggered = false;

void IRAM_ATTR on_limit() {
  limit_triggered = true;
}

void help();
void motor_stop();
bool is_limit_pressed();

// Variables para secuencia de test de bombas no bloqueante
int test_active_pump = -1;
unsigned long test_next_action_time = 0;
bool test_pump_running = false;

// ═══════════════════════════════════════════
//  SETUP
// ═══════════════════════════════════════════
void setup() {
  Serial.begin(115200);

  // Inicialización de Bombas
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

  // Inicialización de Motor
  pinMode(MOTOR_STEP, OUTPUT);
  digitalWrite(MOTOR_STEP, LOW);
  pinMode(MOTOR_DIR, OUTPUT);
  digitalWrite(MOTOR_DIR, LOW);
  pinMode(MOTOR_ENABLE, OUTPUT);
  digitalWrite(MOTOR_ENABLE, HIGH); // Apagado por defecto al iniciar para evitar sobrecalentamiento

  // Limit Switch
  pinMode(LIMIT_SW, INPUT);
  attachInterrupt(digitalPinToInterrupt(LIMIT_SW), on_limit, RISING);

  // Menu de Ayuda
  Serial.println(F("╔══════════════════════════════╗"));
  Serial.println(F("║   PENPITO: CONTROL UNIFICADO ║"));
  Serial.println(F("╚══════════════════════════════╝"));
  help();
}

// ═══════════════════════════════════════════
//  AYUDA
// ═══════════════════════════════════════════
void help() {
  Serial.println(F("── BOMBAS ──"));
  Serial.println(F("  bc<n>        calibrar 10s, ej: bc1"));
  Serial.println(F("  bl<n> <ml>   guardar cal, ej: bl1 42"));
  Serial.println(F("  b<n>         dispensar 30ml, ej: b1"));
  Serial.println(F("  bp<n> <s>    primear, ej: bp1 8"));
  Serial.println(F("  bt           test todas secuencial"));
  Serial.println(F("── SERVOS ──"));
  Serial.println(F("  s<n> <ang>   servo posicional, ej: s1 90"));
  Serial.println(F("  sc <vel>     servo continuo (-100..100), 0=stop"));
  Serial.println(F("── MOTOR ──"));
  Serial.println(F("  mr <steps>   girar N pasos (ej: mr 200 o mr -200)"));
  Serial.println(F("  mh           home (busca limit switch)"));
  Serial.println(F("  ms           stop de emergencia"));
  Serial.println(F("  mp <pos>     ir a posicion absoluta"));
  Serial.println(F("── GENERAL ──"));
  Serial.println(F("  0            apagar todo inmediatamente"));
  Serial.println(F("  ?            ayuda"));
}

// ═══════════════════════════════════════════
//  BOMBAS (NO BLOQUEANTE)
// ═══════════════════════════════════════════
void bombas_off() {
  for (int i = 0; i < NUM_BOMBAS; i++) {
    digitalWrite(B_PIN[i], LOW);
    pump_stop_time[i] = 0;
  }
  test_active_pump = -1; // Detiene secuencia de pruebas si está activa
  Serial.println(F("Bombas Apagadas"));
}

void bomba_on(int n, unsigned long duration_ms) {
  if (n < 0 || n >= NUM_BOMBAS) return;
  digitalWrite(B_PIN[n], HIGH);
  pump_stop_time[n] = millis() + duration_ms;
}

void calibrar(int n) {
  Serial.print(F("Iniciando calibracion Bomba ")); Serial.print(n + 1);
  Serial.println(F(" por 10s..."));
  bomba_on(n, 10000);
}

void guardar_cal(int n, float ml) {
  b_ml_ps[n] = ml / 10.0;
  Serial.print(F("Bomba ")); Serial.print(n + 1);
  Serial.print(F(" calibrada: ")); Serial.print(b_ml_ps[n], 2);
  Serial.println(F(" ml/s"));
}

void dispensar(int n, float ml) {
  if (b_ml_ps[n] <= 0) {
    Serial.print(F("Bomba ")); Serial.print(n + 1);
    Serial.println(F(" no calibrada. Usa bl<n> <ml>"));
    return;
  }
  unsigned long t = (ml / b_ml_ps[n]) * 1000;
  Serial.print(F("Dispensando ")); Serial.print(ml);
  Serial.print(F("ml en Bomba ")); Serial.print(n + 1);
  Serial.print(F(" (")); Serial.print(t); Serial.println(F(" ms)"));
  bomba_on(n, t);
}

void primear(int n, int seg) {
  Serial.print(F("Primeando Bomba ")); Serial.print(n + 1);
  Serial.print(F(" por ")); Serial.print(seg); Serial.println(F("s..."));
  bomba_on(n, (unsigned long)seg * 1000);
}

void test_bombas() {
  Serial.println(F("Iniciando test de bombas secuencial no bloqueante..."));
  test_active_pump = 0;
  test_next_action_time = millis();
  test_pump_running = false;
}

// ═══════════════════════════════════════════
//  SERVOS
// ═══════════════════════════════════════════
void servo_pos(int n, int ang) {
  ang = constrain(ang, 0, 180);
  srv_pos[n].write(ang);
  Serial.print(F("Servo ")); Serial.print(n + 1);
  Serial.print(F(" -> ")); Serial.println(ang);
}

void servo_cont_set(int vel) {
  int speed = constrain(vel, -100, 100);
  int pulse = SRV_CONT_STOP + SRV_CONT_TRIM + map(speed, -100, 100, -90, 90);
  pulse = constrain(pulse, 0, 180);
  srv_cont.write(pulse);
  Serial.print(F("Servo continuo velocidad=")); Serial.print(speed);
  Serial.print(F(" (pwm=")); Serial.print(pulse); Serial.println(F(")"));
}

// ═══════════════════════════════════════════
//  MOTOR NEMA17 (A4988)
// ═══════════════════════════════════════════
int motor_pos = 0;

void motor_stop() {
  digitalWrite(MOTOR_STEP, LOW);
  digitalWrite(MOTOR_ENABLE, HIGH); // Apaga las bobinas para que no se caliente
}

void motor_step() {
  digitalWrite(MOTOR_STEP, HIGH);
  delayMicroseconds(5);
  digitalWrite(MOTOR_STEP, LOW);
  delayMicroseconds(1000); // Frecuencia de 1kHz para el paso
}

bool is_limit_pressed() {
  if (digitalRead(LIMIT_SW) == HIGH) {
    delayMicroseconds(50); // Filtro contra ruido / debounce
    return digitalRead(LIMIT_SW) == HIGH;
  }
  return false;
}

bool motor_steps(int n) {
  if (n == 0) return true;

  // Control físico de dirección
  digitalWrite(MOTOR_DIR, (n > 0) ? HIGH : LOW);
  digitalWrite(MOTOR_ENABLE, LOW); // Enciende las bobinas del motor
  delayMicroseconds(10); // Tiempo de establecimiento

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

  // Dejamos el motor habilitado al finalizar el movimiento para sostener posición.
  // Se apagará si se ejecuta parada de emergencia (ms) o apagado general (0).
  return completed;
}

void home() {
  Serial.println(F("Buscando Home..."));
  limit_triggered = false;

  digitalWrite(MOTOR_DIR, LOW);    // Sentido hacia el switch
  digitalWrite(MOTOR_ENABLE, LOW); // Habilita motor
  delayMicroseconds(10);

  // Avanza paso a paso de forma continua hasta tocar el switch
  while (!limit_triggered && !is_limit_pressed()) {
    motor_step();
  }

  digitalWrite(MOTOR_STEP, LOW);
  motor_pos = 0;
  Serial.println(F("Switch de limite tocado. Home posicionado."));
  delay(500);

  // Retrocede 100 pasos fuera del switch para liberar el contacto
  Serial.println(F("Retrocediendo 100 pasos de seguridad..."));
  digitalWrite(MOTOR_DIR, HIGH);
  for (int i = 0; i < 100; i++) {
    motor_step();
  }
  motor_pos = 100;
  limit_triggered = false;
  Serial.println(F("Home Listo."));
}

void mover_a(int target) {
  int diff = target - motor_pos;
  Serial.print(F("Moviendo a posicion ")); Serial.print(target);
  Serial.print(F(" (")); Serial.print(diff); Serial.println(F(" pasos)"));
  
  if (motor_steps(diff)) {
    Serial.println(F("Movimiento OK"));
  } else {
    Serial.println(F("Movimiento interrumpido por switch de limite"));
  }
}

// ═══════════════════════════════════════════
//  PARSER Y CONTROL NO BLOQUEANTE
// ═══════════════════════════════════════════
void loop() {
  unsigned long now = millis();

  // 1. Monitoreo No Bloqueante del tiempo de dispensado de Bombas
  for (int i = 0; i < NUM_BOMBAS; i++) {
    if (pump_stop_time[i] > 0) {
      if (now >= pump_stop_time[i]) {
        digitalWrite(B_PIN[i], LOW);
        pump_stop_time[i] = 0;
        Serial.print(F("Bomba ")); Serial.print(i + 1); Serial.println(F(" terminada."));
      }
    }
  }

  // 2. Monitoreo No Bloqueante de secuencia de pruebas (bt)
  if (test_active_pump >= 0) {
    if (now >= test_next_action_time) {
      if (!test_pump_running) {
        // Enciende la bomba actual
        digitalWrite(B_PIN[test_active_pump], HIGH);
        test_pump_running = true;
        test_next_action_time = now + 1000; // Corre por 1 segundo
        Serial.print(F("Probando Bomba ")); Serial.println(test_active_pump + 1);
      } else {
        // Apaga la bomba actual
        digitalWrite(B_PIN[test_active_pump], LOW);
        test_pump_running = false;
        test_active_pump++;
        if (test_active_pump >= NUM_BOMBAS) {
          test_active_pump = -1; // Fin del test
          Serial.println(F("Test de Bombas Finalizado."));
        } else {
          test_next_action_time = now + 300; // Espera 300ms de descanso antes de la siguiente
        }
      }
    }
  }

  // 3. Procesamiento de Comandos Seriales
  if (!Serial.available()) return;

  String c = Serial.readStringUntil('\n');
  c.trim();
  if (c.length() == 0) return;

  char p = c[0];

  if (p == '?') { help(); }
  else if (p == '0') {
    bombas_off();
    motor_stop();
    servo_cont_set(0);
    Serial.println(F("EMERGENCIA: Apagado general realizado."));
  }

  // ── BOMBAS ──
  else if (p == 'b') {
    if (c.length() < 2) return;
    char s = c[1];

    if (s == 't') {
      test_bombas();
    }
    else if (s == 'c') {
      int n = c.substring(2).toInt() - 1;
      if (n >= 0 && n < NUM_BOMBAS) calibrar(n);
    }
    else if (s == 'l') {
      int sp = c.indexOf(' ', 2);
      if (sp > 0) {
        int n = c.substring(2, sp).toInt() - 1;
        float ml = c.substring(sp + 1).toFloat();
        if (n >= 0 && n < NUM_BOMBAS && ml > 0) guardar_cal(n, ml);
      }
    }
    else if (s == 'p') {
      int sp = c.indexOf(' ', 2);
      int n, seg = 5;
      if (sp > 0) {
        n = c.substring(2, sp).toInt() - 1;
        seg = c.substring(sp + 1).toInt();
      } else {
        n = c.substring(2).toInt() - 1;
      }
      if (n >= 0 && n < NUM_BOMBAS) primear(n, seg);
    }
    else {
      int n = c.substring(1).toInt() - 1;
      if (n >= 0 && n < NUM_BOMBAS) dispensar(n, 30);
    }
  }

  // ── SERVOS ──
  else if (p == 's') {
    if (c[1] == 'c') {
      int vel = c.substring(2).toInt();
      servo_cont_set(vel);
    } else {
      int sp = c.indexOf(' ', 1);
      if (sp > 0) {
        int n = c.substring(1, sp).toInt() - 1;
        int ang = c.substring(sp + 1).toInt();
        if (n >= 0 && n < 3) servo_pos(n, ang);
      }
    }
  }

  // ── MOTOR ──
  else if (p == 'm') {
    if (c.length() < 2) return;
    char s = c[1];

    if (s == 's') {
      motor_stop();
      Serial.println(F("Motor Detenido (Sin energía)"));
    }
    else if (s == 'h') {
      home();
    }
    else if (s == 'r') {
      int steps = c.substring(2).toInt();
      mover_a(motor_pos + steps);
    }
    else if (s == 'p') {
      int pos = c.substring(2).toInt();
      mover_a(pos);
    }
  }
}
