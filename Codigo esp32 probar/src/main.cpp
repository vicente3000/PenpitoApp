#include <Arduino.h>
#include <ESP32Servo.h>

// ═══════════════════════════════════════════
//  PINOUT
// ═══════════════════════════════════════════
// BOMBAS (L298N)
const int B_PWM[] = {12, 13, 19, 25, 26, 32, 33};
const int B_DIR[] = {2, 4, 21, 15, 16, 17, 18};
const int NUM_BOMBAS = 7;
float b_ml_ps[7] = {0};

// SERVOS
Servo srv_pos[3];
const int SRV_PIN[] = {22, 23, 27};
Servo srv_cont;
const int SRV_CONT_PIN = 14;

// NEMA17 + A4988
const int MOTOR_STEP = 5;
const int LIMIT_SW = 34;
volatile bool limit_triggered = false;

void IRAM_ATTR on_limit() {
  limit_triggered = true;
}

// ═══════════════════════════════════════════
//  SETUP
// ═══════════════════════════════════════════
void setup() {
  Serial.begin(115200);

  // Bombas
  for (int i = 0; i < NUM_BOMBAS; i++) {
    pinMode(B_PWM[i], OUTPUT);
    pinMode(B_DIR[i], OUTPUT);
    digitalWrite(B_PWM[i], LOW);
    digitalWrite(B_DIR[i], LOW);
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

  // Motor
  pinMode(MOTOR_STEP, OUTPUT);
  digitalWrite(MOTOR_STEP, LOW);
  pinMode(LIMIT_SW, INPUT);
  attachInterrupt(digitalPinToInterrupt(LIMIT_SW), on_limit, RISING);

  // Menu
  Serial.println(F("╔══════════════════════════════╗"));
  Serial.println(F("║     COCTELERA INTELIGENTE    ║"));
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
  Serial.println(F("  bp<n> <s>    prime, ej: bp1 8"));
  Serial.println(F("  bt           test todas 1s"));
  Serial.println(F("── SERVOS ──"));
  Serial.println(F("  s<n> <ang>   servo posicional, ej: s1 90"));
  Serial.println(F("  sc <ang>     servo continuo (0-180), 90=stop"));
  Serial.println(F("── MOTOR ──"));
  Serial.println(F("  mr <steps>   girar N pasos"));
  Serial.println(F("  mh           home (busca limit switch)"));
  Serial.println(F("  ms           stop emergencia"));
  Serial.println(F("  mp <pos>     ir a posicion absoluta"));
  Serial.println(F("── GENERAL ──"));
  Serial.println(F("  0            apagar todo"));
  Serial.println(F("  ?            ayuda"));
}

// ═══════════════════════════════════════════
//  BOMBAS
// ═══════════════════════════════════════════
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
  Serial.print(F("Bomba ")); Serial.print(n + 1);
  Serial.println(F(" -> 10s. ml? Usa bl<n> <ml>"));
}

void guardar_cal(int n, float ml) {
  b_ml_ps[n] = ml / 10.0;
  Serial.print(F("Bomba ")); Serial.print(n + 1);
  Serial.print(F(": ")); Serial.print(b_ml_ps[n], 2);
  Serial.println(F(" ml/s"));
}

void dispensar(int n, float ml) {
  if (b_ml_ps[n] <= 0) {
    Serial.print(F("Bomba ")); Serial.print(n + 1);
    Serial.println(F(" no calibrada"));
    return;
  }
  int t = (ml / b_ml_ps[n]) * 1000;
  Serial.print(F("Dispensando ")); Serial.print(ml);
  Serial.print(F("ml bomba ")); Serial.print(n + 1);
  Serial.print(F(" ")); Serial.print(t); Serial.println(F("ms"));
  bomba_on(n);
  delay(t);
  bombas_off();
  Serial.println(F("OK"));
}

void primear(int n, int seg) {
  bomba_on(n);
  delay(seg * 1000);
  bombas_off();
  Serial.print(F("Prime bomba ")); Serial.println(n + 1);
}

void test_bombas() {
  for (int i = 0; i < NUM_BOMBAS; i++) {
    Serial.print(F("Bomba ")); Serial.println(i + 1);
    bomba_on(i);
    delay(1000);
    bombas_off();
    delay(300);
  }
  Serial.println(F("Test OK"));
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

void servo_cont_set(int ang) {
  ang = constrain(ang, 0, 180);
  srv_cont.write(ang);
  Serial.print(F("Servo continuo -> ")); Serial.println(ang);
}

// ═══════════════════════════════════════════
//  MOTOR NEMA17
// ═══════════════════════════════════════════
int motor_pos = 0;

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
  Serial.print(F("Moviendo a ")); Serial.print(target);
  Serial.print(F(" (")); Serial.print(diff); Serial.println(F(" pasos)"));
  motor_steps(abs(diff));
  if (limit_triggered) {
    Serial.println(F("Limit switch alcanzado"));
    limit_triggered = false;
  } else {
    Serial.println(F("OK"));
  }
}

// ═══════════════════════════════════════════
//  PARSER
// ═══════════════════════════════════════════
void loop() {
  if (!Serial.available()) return;

  String c = Serial.readStringUntil('\n');
  c.trim();
  if (c.length() == 0) return;

  char p = c[0];

  if (p == '?') { help(); }
  else if (p == '0') { bombas_off(); motor_stop(); Serial.println(F("Todo off")); }

  // ── BOMBAS ──
  else if (p == 'b') {
    if (c.length() < 2) return;
    char s = c[1];

    if (s == 't') { test_bombas(); }
    else if (s == 'c') {
      int n = c.substring(2).toInt() - 1;
      if (n >= 0 && n < NUM_BOMBAS) calibrar(n);
    } else if (s == 'l') {
      int sp = c.indexOf(' ', 2);
      if (sp > 0) {
        int n = c.substring(2, sp).toInt() - 1;
        float ml = c.substring(sp + 1).toFloat();
        if (n >= 0 && n < NUM_BOMBAS && ml > 0) guardar_cal(n, ml);
      }
    } else if (s == 'p') {
      int sp = c.indexOf(' ', 2);
      int n, seg = 5;
      if (sp > 0) {
        n = c.substring(2, sp).toInt() - 1;
        seg = c.substring(sp + 1).toInt();
      } else {
        n = c.substring(2).toInt() - 1;
      }
      if (n >= 0 && n < NUM_BOMBAS) primear(n, seg);
    } else {
      int n = c.substring(1).toInt() - 1;
      if (n >= 0 && n < NUM_BOMBAS) dispensar(n, 30);
    }
  }

  // ── SERVOS ──
  else if (p == 's') {
    if (c[1] == 'c') {
      int ang = c.substring(2).toInt();
      servo_cont_set(ang);
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

    if (s == 's') { motor_stop(); Serial.println(F("Motor stop")); }
    else if (s == 'h') { home(); }
    else if (s == 'r') {
      int n = c.substring(2).toInt();
      if (n > 0) {
        Serial.print(F("Girando ")); Serial.print(n); Serial.println(F(" pasos"));
        motor_steps(n);
        if (!limit_triggered) Serial.println(F("OK"));
        else { Serial.println(F("Limit!")); limit_triggered = false; }
      }
    } else if (s == 'p') {
      int pos = c.substring(2).toInt();
      mover_a(pos);
    }
  }
}
