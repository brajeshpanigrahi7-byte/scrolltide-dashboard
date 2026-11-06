// Firebase bridge to ADD to your existing smart_parking.ino (keep a backup of the original).
// Pin mapping and parking state machines stay unchanged; this only publishes state.
// Library: "Firebase ESP Client" by Mobizt. Hardware keeps working when Wi-Fi is down.
#include <WiFi.h>
#include <time.h>
#include <Firebase_ESP_Client.h>

#define WIFI_SSID      "YOUR_WIFI"
#define WIFI_PASSWORD  "YOUR_WIFI_PASSWORD"
#define API_KEY        "YOUR_FIREBASE_WEB_API_KEY"
#define DATABASE_URL   "https://YOUR-PROJECT-default-rtdb.firebasedatabase.app"
#define DEVICE_EMAIL   "esp32@yourdomain"
#define DEVICE_PASS    "DEVICE_PASSWORD"

FirebaseData fbdo; FirebaseAuth fbAuth; FirebaseConfig fbConfig;
unsigned long lastHeartbeat = 0, lastWifiTry = 0;
bool stateDirty = true;

uint64_t epochMs() { struct timeval tv; gettimeofday(&tv, nullptr); return (uint64_t)tv.tv_sec * 1000ULL + tv.tv_usec / 1000; }

void cloudSetup() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);           // non-blocking
  configTime(19800, 0, "pool.ntp.org");           // IST
  fbConfig.api_key = API_KEY; fbConfig.database_url = DATABASE_URL;
  fbAuth.user.email = DEVICE_EMAIL; fbAuth.user.password = DEVICE_PASS;
  Firebase.reconnectWiFi(true);
  Firebase.begin(&fbConfig, &fbAuth);
}

// Call from your existing code whenever a slot / gate / OLED state changes
void markDirty() { stateDirty = true; }

void cloudLog(const char* category, const String& msg, const char* severity, int slot) {
  if (WiFi.status() != WL_CONNECTED || !Firebase.ready()) return;
  FirebaseJson j; j.set("ts", (double)epochMs()); j.set("category", category);
  j.set("message", msg); j.set("severity", severity); if (slot > 0) j.set("slot", slot);
  Firebase.RTDB.pushJSON(&fbdo, "/parking/logs", &j);
}

// Call every loop() iteration — returns immediately when nothing to send.
// Uses your existing globals: slotState[5], irStable[5], reserveUntil[5], lastDistance, entryServoPos, ...
void cloudLoop() {
  unsigned long now = millis();
  if (WiFi.status() != WL_CONNECTED) {
    if (now - lastWifiTry > 10000) { lastWifiTry = now; WiFi.reconnect(); }
    return;                                       // parking logic continues offline
  }
  if (!Firebase.ready()) return;
  if (!stateDirty && now - lastHeartbeat < 5000) return;
  lastHeartbeat = now; stateDirty = false;

  FirebaseJson j;
  j.set("lastSeen", (double)epochMs());
  // for (int i = 0; i < 5; i++) {
  //   String p = "slots/[" + String(i) + "]/";
  //   j.set(p + "status", slotState[i] == FREE ? "FREE" : slotState[i] == RESERVED ? "RESERVED" : "OCCUPIED");
  //   j.set(p + "ir", irStable[i]);
  // }
  // j.set("entry/distance", lastDistance); j.set("entry/servo", entryServoPos);
  // j.set("exit/servo", exitServoPos);
  Firebase.RTDB.updateNodeAsync(&fbdo, "/parking", &j);   // async: does not block sensors
}
