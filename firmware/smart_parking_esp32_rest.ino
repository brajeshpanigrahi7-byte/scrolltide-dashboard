/**
 * ParkSense ESP32 Hardware Firmware - REST API Client
 * Hardware: ESP32 Dev Module, HC-SR04, 5x IR Sensors, 2x SG90 Servos, SSD1306 OLED (I2C), Active Buzzer
 *
 * REST Endpoints:
 * - POST /api/public/device-session (Creates or retrieves payment session)
 * - GET  /api/public/device-poll?session=<id> (Polls Razorpay payment status)
 * - POST /api/public/device-event (Reports boot, entered, slots occupancy, telemetry)
 * - GET  /api/public/device-due?device=esp32-entry-1 (Checks for auto-open exit & slot warnings)
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include <ESP32Servo.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

// ======================= CONFIGURATION =======================
const char* WIFI_SSID     = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// Backend URL (Your deployed Lovable Cloud app or Supabase edge functions)
const char* API_BASE_URL  = "https://scrolltide-dashboard.lovable.app/api/public";
const char* DEVICE_ID     = "esp32-entry-1";
const char* DEVICE_KEY    = "YOUR_DEVICE_API_KEY"; // Must match backend DEVICE_API_KEY

// ======================= GPIO PINOUT =========================
#define PIN_TRIG        5
#define PIN_ECHO        18
#define PIN_ENTRY_SERVO 13
#define PIN_EXIT_SERVO  27
#define PIN_BUZZER      4

// 5 IR Sensors for Slots 1 to 5
const int IR_PINS[5]    = { 34, 35, 32, 33, 25 };

// OLED Display (I2C)
#define SCREEN_WIDTH  128
#define SCREEN_HEIGHT 64
#define OLED_RESET    -1
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

Servo entryServo;
Servo exitServo;

// ======================= STATE MACHINE =======================
enum EntryState {
  STATE_IDLE,
  STATE_WAITING_PAYMENT,
  STATE_GATE_OPEN,
  STATE_FULL
};

EntryState currentEntryState = STATE_IDLE;
String activeSessionId = "";
String activePayUrl = "";
String activeSessionCode = "";
int assignedSlot = 1;

unsigned long lastPollTime = 0;
unsigned long lastDueTime = 0;
unsigned long lastTelemetryTime = 0;
unsigned long gateOpenedAt = 0;
unsigned long exitOpenedAt = 0;
bool exitGateOpen = false;

// Debouncing for vehicle arrival
int consecutiveReads = 0;

// ======================= UTILITY FUNCTIONS ===================
float measureDistanceCm() {
  digitalWrite(PIN_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(PIN_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PIN_TRIG, LOW);
  long duration = pulseIn(PIN_ECHO, HIGH, 30000);
  if (duration == 0) return 999.0;
  return duration * 0.034 / 2.0;
}

String getOccupancyString() {
  String occ = "";
  for (int i = 0; i < 5; i++) {
    // IR sensor: LOW typically = Object detected (car parked)
    bool occupied = (digitalRead(IR_PINS[i]) == LOW);
    occ += occupied ? "1" : "0";
  }
  return occ;
}

int findFirstFreeSlot(const String& occ) {
  for (int i = 0; i < 5; i++) {
    if (occ[i] == '0') return i + 1;
  }
  return 0; // All full
}

void showOled(const String& line1, const String& line2, const String& line3 = "") {
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println("--- PARKSENSE ---");
  display.println("");
  display.setTextSize(1);
  display.println(line1);
  display.println(line2);
  if (line3.length() > 0) display.println(line3);
  display.display();
}

void beep(int ms = 100) {
  digitalWrite(PIN_BUZZER, HIGH);
  delay(ms);
  digitalWrite(PIN_BUZZER, LOW);
}

// ======================= API CLIENT FUNCTIONS ================

// 1. POST /api/public/device-session
bool requestSession(int slot) {
  if (WiFi.status() != WL_CONNECTED) return false;

  HTTPClient http;
  String url = String(API_BASE_URL) + "/device-session";
  http.begin(url);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-device-key", DEVICE_KEY);

  StaticJsonDocument<256> doc;
  doc["device"] = DEVICE_ID;
  doc["slot"] = slot;

  String body;
  serializeJson(doc, body);

  int httpCode = http.POST(body);
  String response = http.getString();
  http.end();

  Serial.printf("POST /device-session -> %d\n", httpCode);
  Serial.println(response);

  if (httpCode == 200 || httpCode == 201) {
    StaticJsonDocument<512> resDoc;
    DeserializationError err = deserializeJson(resDoc, response);
    if (!err) {
      activeSessionId = resDoc["session_id"].as<String>();
      activeSessionCode = resDoc["code"].as<String>();
      activePayUrl = resDoc["pay_url"].as<String>();

      // If already marked paid (e.g. repeated request after quick payment)
      if (resDoc.containsKey("status") && String(resDoc["status"].as<const char*>()) == "paid") {
        Serial.println("Session already paid! Opening barrier...");
        openEntryGate();
        return true;
      }

      showOled("SCAN QR TO PAY", "Code: " + activeSessionCode, "Slot: " + String(slot));
      currentEntryState = STATE_WAITING_PAYMENT;
      beep(150);
      return true;
    }
  } else if (httpCode == 409) {
    // Slot occupied or reserved
    StaticJsonDocument<256> resDoc;
    deserializeJson(resDoc, response);
    String errStr = resDoc["error"].as<String>();
    Serial.println("Slot unavailable: " + errStr);
    showOled("SLOT " + String(slot) + " UNAVAILABLE", errStr, "Please wait...");
    delay(2000);
  }

  return false;
}

// 2. GET /api/public/device-poll?session=<id>
void pollPayment() {
  if (activeSessionId.length() == 0 || WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  String url = String(API_BASE_URL) + "/device-poll?session=" + activeSessionId;
  http.begin(url);
  http.addHeader("x-device-key", DEVICE_KEY);

  int httpCode = http.GET();
  if (httpCode == 200) {
    String response = http.getString();
    StaticJsonDocument<256> doc;
    if (!deserializeJson(doc, response)) {
      String status = doc["status"].as<String>();
      if (status == "paid") {
        Serial.println("Payment confirmed! Opening entry gate.");
        openEntryGate();
      } else if (status == "expired" || status == "cancelled") {
        Serial.println("Payment session expired.");
        showOled("SESSION EXPIRED", "Try again");
        delay(2000);
        currentEntryState = STATE_IDLE;
        activeSessionId = "";
      }
    }
  }
  http.end();
}

// 3. POST /api/public/device-event
void sendEvent(const String& eventName, int slot = 0, const String& sessionId = "") {
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  String url = String(API_BASE_URL) + "/device-event";
  http.begin(url);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-device-key", DEVICE_KEY);

  StaticJsonDocument<512> doc;
  doc["device"] = DEVICE_ID;
  doc["event"] = eventName;
  doc["occupancy"] = getOccupancyString();
  doc["dist"] = measureDistanceCm();
  doc["rssi"] = WiFi.RSSI();
  doc["uptime"] = millis() / 1000;
  doc["state"] = (int)currentEntryState;
  doc["exit_open"] = exitGateOpen;

  if (slot > 0) doc["slot"] = slot;
  if (sessionId.length() > 0) doc["session"] = sessionId;

  String body;
  serializeJson(doc, body);
  http.POST(body);
  http.end();
}

// 4. GET /api/public/device-due?device=esp32-entry-1
void checkDue() {
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  String url = String(API_BASE_URL) + "/device-due?device=" + String(DEVICE_ID);
  http.begin(url);
  http.addHeader("x-device-key", DEVICE_KEY);

  int httpCode = http.GET();
  if (httpCode == 200) {
    String response = http.getString();
    StaticJsonDocument<512> doc;
    if (!deserializeJson(doc, response)) {
      bool exitOpen = doc["exit_open"].as<bool>();
      if (exitOpen && !exitGateOpen) {
        Serial.println("Exit gate command received! Opening exit barrier for 60s.");
        openExitGate();
      }

      // Check slot warning LEDs / reminder beeps
      JsonArray warnSlots = doc["warn_slots"].as<JsonArray>();
      for (int slotNum : warnSlots) {
        Serial.printf("Warning: Slot %d session ending soon (10m left)!\n", slotNum);
      }
    }
  }
  http.end();
}

void openEntryGate() {
  beep(200);
  showOled("PAYMENT RECEIVED", "BARRIER OPEN", "PROCEED TO SLOT " + String(assignedSlot));
  entryServo.write(90);
  currentEntryState = STATE_GATE_OPEN;
  gateOpenedAt = millis();

  // Inform backend that vehicle entered (starts parking timer)
  sendEvent("entered", assignedSlot, activeSessionId);
}

void closeEntryGate() {
  entryServo.write(0);
  currentEntryState = STATE_IDLE;
  activeSessionId = "";
  activePayUrl = "";
  activeSessionCode = "";
  showOled("SMART PARKING", "SYSTEM READY");
}

void openExitGate() {
  exitServo.write(90);
  exitGateOpen = true;
  exitOpenedAt = millis();
  beep(100);
}

void closeExitGate() {
  exitServo.write(0);
  exitGateOpen = false;
  sendEvent("leave_now");
}

// ======================= SETUP & LOOP ========================
void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\nStarting ParkSense ESP32...");

  pinMode(PIN_TRIG, OUTPUT);
  pinMode(PIN_ECHO, INPUT);
  pinMode(PIN_BUZZER, OUTPUT);

  for (int i = 0; i < 5; i++) {
    pinMode(IR_PINS[i], INPUT_PULLUP);
  }

  entryServo.attach(PIN_ENTRY_SERVO);
  exitServo.attach(PIN_EXIT_SERVO);
  entryServo.write(0);
  exitServo.write(0);

  Wire.begin();
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println("SSD1306 allocation failed");
  } else {
    display.clearDisplay();
    showOled("CONNECTING WI-FI", WIFI_SSID);
  }

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  int tries = 0;
  while (WiFi.status() != WL_CONNECTED && tries < 30) {
    delay(500);
    Serial.print(".");
    tries++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nWiFi Connected! IP: " + WiFi.localIP().toString());
    showOled("WI-FI CONNECTED", "IP: " + WiFi.localIP().toString());
    sendEvent("boot");
  } else {
    Serial.println("\nWiFi connection failed! Running offline mode.");
    showOled("WI-FI FAILED", "Offline Mode");
  }

  delay(1500);
  showOled("SMART PARKING", "SYSTEM READY");
}

void loop() {
  unsigned long now = millis();

  // 1. Periodic Telemetry (Heartbeat & Slot states every 3s)
  if (now - lastTelemetryTime > 3000) {
    lastTelemetryTime = now;
    sendEvent("slots");
  }

  // 2. Periodic Due & Exit Check (Every 4s)
  if (now - lastDueTime > 4000) {
    lastDueTime = now;
    checkDue();
  }

  // 3. Exit gate timer (close after 60 seconds)
  if (exitGateOpen && (now - exitOpenedAt > 60000)) {
    closeExitGate();
  }

  // 4. Entry State Machine
  float dist = measureDistanceCm();

  switch (currentEntryState) {
    case STATE_IDLE: {
      // Vehicle detected at entry barrier (< 15 cm)
      if (dist < 15.0) {
        consecutiveReads++;
        if (consecutiveReads >= 5) { // 5 consecutive stable readings (~500 ms)
          String occ = getOccupancyString();
          int freeSlot = findFirstFreeSlot(occ);

          if (freeSlot == 0) {
            currentEntryState = STATE_FULL;
            showOled("PARKING FULL", "No slots available");
            beep(300);
          } else {
            assignedSlot = freeSlot;
            showOled("VEHICLE DETECTED", "Assigning Slot " + String(assignedSlot) + "...");
            requestSession(assignedSlot);
          }
          consecutiveReads = 0;
        }
      } else {
        consecutiveReads = 0;
      }
      break;
    }

    case STATE_WAITING_PAYMENT: {
      // Poll payment status every 2 seconds
      if (now - lastPollTime > 2000) {
        lastPollTime = now;
        pollPayment();
      }

      // If car backed away from entry before paying
      if (dist > 30.0) {
        consecutiveReads++;
        if (consecutiveReads >= 15) { // Car absent for ~1.5s
          Serial.println("Vehicle departed before payment.");
          sendEvent("cancelled", assignedSlot, activeSessionId);
          currentEntryState = STATE_IDLE;
          activeSessionId = "";
          showOled("SMART PARKING", "SYSTEM READY");
          consecutiveReads = 0;
        }
      } else {
        consecutiveReads = 0;
      }
      break;
    }

    case STATE_GATE_OPEN: {
      // Wait for car to pass through barrier (dist > 20 cm)
      if (dist > 20.0 && (now - gateOpenedAt > 3000)) {
        closeEntryGate();
      }
      break;
    }

    case STATE_FULL: {
      if (dist > 25.0) {
        currentEntryState = STATE_IDLE;
        showOled("SMART PARKING", "SYSTEM READY");
      }
      break;
    }
  }

  delay(100);
}
