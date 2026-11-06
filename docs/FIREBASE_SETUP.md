# Going live: ESP32 → Firebase Realtime Database → Dashboard

Without `VITE_FIREBASE_DB_URL` the dashboard runs in clearly labelled **DEMO MODE** (simulated firmware).

1. Create a Firebase project and a Realtime Database.
2. Create an Email/Password user for the device (e.g. `esp32@yourdomain`) in Firebase Authentication. Note its UID.
3. Database rules (public read of parking state, writes only by the device user):

```json
{
  "rules": {
    "parking": {
      ".read": true,
      ".write": "auth != null && auth.uid === 'DEVICE_UID'"
    }
  }
}
```

4. Open `firmware/smart_parking_firebase.ino`, fill in Wi-Fi + Firebase settings, flash (keep a backup of your original `smart_parking.ino`).
5. Set `VITE_FIREBASE_DB_URL=https://<project>-default-rtdb.<region>.firebasedatabase.app` for the dashboard and rebuild.

## Payload published at `/parking`

```json
{
  "lastSeen": 1730822400000,
  "slots": [{ "status": "FREE|RESERVED|OCCUPIED", "ir": false, "reservedUntil": 0, "updated": 0, "ok": true }],
  "entry": { "distance": 42.1, "usOk": true, "phase": "IDLE|DETECTING|GATE_OPEN|WELCOME|FULL", "servo": 0, "slot": 3, "qrAt": 0, "stage": "scan" },
  "exit":  { "phase": "IDLE|OPEN", "servo": 0, "closeAt": 0, "paymentAt": 0, "stage": "idle" },
  "oled": ["SMART PARKING", "READY"],
  "counters": { "entries": 0, "exits": 0, "full": 0, "irEvents": 0, "usDetections": 0 },
  "logs": { "<push-id>": { "ts": 0, "category": "entry", "message": "...", "severity": "info", "slot": 3 } }
}
```

Timestamps are epoch milliseconds (firmware syncs via NTP). The device is shown offline when `lastSeen` is older than 15 s.
